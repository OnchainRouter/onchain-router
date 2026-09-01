import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROXY_PORT,
  parseChatBody,
  parseCacheRequest,
  parseIdempotencyKey,
  proxyClientRecipe,
} from '../src/contracts.js';
import { parseProxyArguments } from '../src/index.js';

describe('local proxy contracts', () => {
  it('supports cache refresh and no-store controls without forwarding them to paid requests', () => {
    const body = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] };
    expect(parseCacheRequest(body).cacheMode).toBe('reuse');
    expect(parseCacheRequest(body, 'max-age=0, NO-CACHE').cacheMode).toBe('refresh');
    for (const input of [
      { ...body, cache: false },
      { ...body, no_cache: true },
    ]) {
      expect(parseCacheRequest(input)).toEqual({ body, cacheMode: 'bypass' });
    }
    expect(parseCacheRequest(body, 'no-cache, no-store').cacheMode).toBe('bypass');
    expect(() => parseCacheRequest({ ...body, cache: 'false' })).toThrow('cache must be boolean');
    expect(() => parseCacheRequest({ ...body, no_cache: null })).toThrow(
      'no_cache must be boolean',
    );
    expect(parseProxyArguments([]).cacheEnabled).toBe(true);
    expect(parseProxyArguments(['--no-cache']).cacheEnabled).toBe(false);
  });
  it('preserves ordinary non-streaming OpenAI request fields', () => {
    const body = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      stream: false,
    };
    expect(parseChatBody(body)).toBe(body);
  });

  it.each(['origin', 'network', 'asset', 'recipient', 'payTo', 'maximum', 'private_key'])(
    'rejects caller-controlled authority field %s',
    (field) => {
      expect(() =>
        parseChatBody({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'hello' }],
          [field]: 'attacker-controlled',
        }),
      ).toThrow(`forbidden authority field: ${field}`);
    },
  );

  it('rejects streaming and malformed idempotency before Buyer Runtime', () => {
    expect(() =>
      parseChatBody({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    ).toThrow('streaming is not supported');
    expect(() => parseIdempotencyKey('contains whitespace')).toThrow('idempotency key is invalid');
  });

  it('emits a secret-free, loopback-only client recipe', () => {
    const recipe = proxyClientRecipe(DEFAULT_PROXY_PORT, '/private/profile/proxy-token');
    expect(recipe).toEqual({
      baseURL: 'http://127.0.0.1:8402/v1',
      tokenFile: '/private/profile/proxy-token',
      endpoints: [
        '/v1/models',
        '/v1/chat/completions',
        '/v1/messages',
        '/v1/images/generations',
        '/v1/audio/speech',
        '/v1/audio/transcriptions',
        '/v1/pricing',
        '/v1/audio/voices',
      ],
      streaming: false,
      idempotencyHeader: 'Idempotency-Key',
    });
    expect(JSON.stringify(recipe)).not.toMatch(/private.?key|passphrase|mnemonic|bearer.?value/i);
  });

  it('offers no host/public-bind option', () => {
    expect(parseProxyArguments([])).toMatchObject({ action: 'serve', port: DEFAULT_PROXY_PORT });
    expect(() => parseProxyArguments(['--host', '0.0.0.0'])).toThrow('unknown option: --host');
    expect(() => parseProxyArguments(['--port', '0'])).toThrow('between 1 and 65535');
  });
});
