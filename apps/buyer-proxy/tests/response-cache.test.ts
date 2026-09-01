import type { BuyerSuccess } from '@agenticfi/onchain-router-buyer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResponseCache,
  cacheableRequest,
  responseCacheKey,
  RESPONSE_CACHE_MAX_ENTRIES,
  RESPONSE_CACHE_MAX_ITEM_BYTES,
  RESPONSE_CACHE_TTL_MS,
} from '../src/response-cache.js';

const BODY = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
const SCOPE = {
  wallet: 'wallet-1',
  session: 'session-1',
  policy: 'policy-1',
  catalog: 'catalog-1',
};
function success(content = 'answer'): BuyerSuccess {
  return {
    ok: true,
    outcome: 'Completed',
    idempotencyKey: 'key-1',
    body: {
      object: 'chat.completion',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    },
    receipt: {
      id: 'receipt-1',
      operationId: 'op-1',
      catalogVersion: 'catalog-1',
      model: 'test-model',
      usage: {},
      settlement: { success: true, transaction: 'tx', network: 'eip155:8453', payer: 'payer' },
      maximumAmount: '100',
      actualAmount: '10',
    },
    payment: {
      network: 'eip155:8453',
      asset: 'asset',
      recipient: 'recipient',
      authorizedMaximumAtomic: '100',
      actualAtomic: '10',
      transaction: 'tx',
    },
  };
}
const caches: ResponseCache[] = [];
function cache() {
  const item = new ResponseCache();
  caches.push(item);
  return item;
}
afterEach(() => {
  caches.splice(0).forEach((item) => item.close());
  vi.useRealTimers();
});

describe('bounded local response cache', () => {
  it('canonicalizes object order while preserving all text, caller fields, parameters, and scope', () => {
    const key = responseCacheKey(SCOPE, BODY);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(responseCacheKey(SCOPE, { messages: BODY.messages, model: BODY.model })).toBe(key);
    for (const body of [
      { ...BODY, user: 'another-user' },
      { ...BODY, request_id: 'another-request' },
      { ...BODY, temperature: 1 },
      { ...BODY, max_tokens: 50 },
      { ...BODY, messages: [{ role: 'user', content: '[2026-08-31] hello' }] },
      { ...BODY, messages: [{ role: 'user', content: 'hello ' }] },
      { ...BODY, messages: [{ role: 'system', content: 'hello' }] },
    ])
      expect(responseCacheKey(SCOPE, body)).not.toBe(key);
    expect(responseCacheKey({ ...SCOPE, session: 'new' }, BODY)).not.toBe(key);
    expect(responseCacheKey(SCOPE, { ...BODY, invalid: undefined })).toBeNull();
    let deep: unknown = 'text';
    for (let i = 0; i < 40; i++) deep = { deep };
    expect(responseCacheKey(SCOPE, deep)).toBeNull();
  });

  it.each([
    { tools: [] },
    { tool_choice: 'auto' },
    { functions: [] },
    { stream: true },
    { extra_body: { grounding: true } },
    { modalities: ['audio'] },
    { messages: [{ role: 'tool', content: 'result' }] },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }],
        },
      ],
    },
  ])('bypasses tool/media/unknown request shape %j', (fields) => {
    expect(cacheableRequest({ ...BODY, ...fields })).toBe(false);
  });

  it('expires entries without more traffic, and never resets TTL on read', () => {
    vi.useFakeTimers();
    const c = cache();
    c.put('key', success(), Date.now() + 3_600_000);
    vi.advanceTimersByTime(RESPONSE_CACHE_TTL_MS - 1);
    expect(c.get('key')?.cache.ageMs).toBe(RESPONSE_CACHE_TTL_MS - 1);
    vi.advanceTimersByTime(1);
    expect(c.get('key')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clips TTL to session expiry and rejects backward-clock reuse', () => {
    vi.useFakeTimers();
    const c = cache();
    c.put('short', success(), Date.now() + 100);
    vi.advanceTimersByTime(100);
    expect(c.get('short')).toBeUndefined();
    c.put('future', success(), Date.now() + 1000);
    vi.setSystemTime(Date.now() - 1);
    expect(c.get('future')).toBeUndefined();
  });

  it('uses LRU eviction at the entry limit', () => {
    const c = cache();
    for (let i = 0; i < RESPONSE_CACHE_MAX_ENTRIES; i++)
      c.put(String(i), success(), Date.now() + 60_000);
    c.get('0');
    c.put('new', success(), Date.now() + 60_000);
    expect(c.get('0')).toBeDefined();
    expect(c.get('1')).toBeUndefined();
    expect(c.get('new')).toBeDefined();
  });

  it('does not extend retention when the wall clock moves backward and a write reschedules expiry', () => {
    vi.useFakeTimers();
    const c = cache();
    c.put('original', success(), Date.now() + 3_600_000);
    vi.advanceTimersByTime(6 * 60_000);
    vi.setSystemTime(Date.now() - 5 * 60_000);
    c.put('later', success(), Date.now() + 3_600_000);
    vi.advanceTimersByTime(4 * 60_000);
    expect(c.get('original')).toBeUndefined();
    expect(c.get('later')).toBeDefined();
  });

  it('enforces UTF-8 per-item and aggregate serialized-byte limits', () => {
    const c = cache();
    c.put('too-large', success('é'.repeat(RESPONSE_CACHE_MAX_ITEM_BYTES / 2)), Date.now() + 60_000);
    expect(c.get('too-large')).toBeUndefined();
    const large = success('x'.repeat(RESPONSE_CACHE_MAX_ITEM_BYTES - 1024));
    for (let i = 0; i < 17; i++) c.put(String(i), large, Date.now() + 60_000);
    expect(c.get('0')).toBeUndefined();
    expect(c.get('16')).toBeDefined();
  });

  it('stores immutable snapshots and clears on close, including late in-flight completions', () => {
    const c = cache();
    const result = success();
    c.put('key', result, Date.now() + 60_000);
    const hit = c.get('key');
    (hit?.body as Record<string, unknown>)['object'] = 'changed';
    expect(c.get('key')?.body).toMatchObject({ object: 'chat.completion' });
    c.close();
    expect(c.get('key')).toBeUndefined();
    c.put('late', result, Date.now() + 60_000);
    expect(c.get('late')).toBeUndefined();
  });

  it.each(['tool_calls', 'length', 'content_filter'])(
    'does not cache unfinished or action output: %s',
    (finish_reason) => {
      const c = cache();
      const result = success();
      c.put(
        'key',
        {
          ...result,
          body: {
            object: 'chat.completion',
            choices: [{ finish_reason, message: { role: 'assistant', content: 'not final' } }],
          },
        },
        Date.now() + 60_000,
      );
      expect(c.get('key')).toBeUndefined();
    },
  );

  it('does not cache tool calls even when mislabeled as stopped, or an unsuccessful runtime result', () => {
    const c = cache();
    c.put(
      'tool',
      {
        ...success(),
        body: {
          object: 'chat.completion',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'run it', tool_calls: [] },
            },
          ],
        },
      },
      Date.now() + 60_000,
    );
    c.put(
      'failed',
      {
        ok: false,
        outcome: 'ProviderOutcomeUnknown',
        retry: 'human_review',
        idempotencyKey: 'failed',
        message: 'review',
      },
      Date.now() + 60_000,
    );
    expect(c.get('tool')).toBeUndefined();
    expect(c.get('failed')).toBeUndefined();
  });

  it.each([
    { content: '' },
    { content: 'refused', refusal: 'cannot answer' },
    { content: 'audio', audio: {} },
  ])('does not cache empty, refusal, or audio output %j', (fields) => {
    const c = cache();
    c.put(
      'key',
      {
        ...success(),
        body: {
          object: 'chat.completion',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...fields } }],
        },
      },
      Date.now() + 60_000,
    );
    expect(c.get('key')).toBeUndefined();
  });

  it('rejects invalid expiry without retaining a timer or entry', () => {
    vi.useFakeTimers();
    const c = cache();
    c.put('key', success(), Number.NaN);
    expect(c.get('key')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
