import { request as httpRequest } from 'node:http';
import OpenAI from 'openai';
import type { BuyerFailure, BuyerResult } from '@onchainrouter/buyer-core';
import type { BuyerStatus, ModelCatalog } from '@onchainrouter/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuyerProxyService, type BuyerProxyService } from '../src/service.js';
import { startBuyerProxy, type StartedBuyerProxy } from '../src/server.js';

const TOKEN = 'a'.repeat(43);
const MODEL = 'gemini-2.5-flash';
const MODELS: ModelCatalog = {
  object: 'list',
  catalog_version: 'catalog-1',
  categories: [],
  data: [{ id: MODEL, object: 'model', owned_by: 'google' }],
};

function success(
  idempotencyKey: string,
  outcome: 'Completed' | 'RecoveredSuccess' = 'Completed',
): BuyerResult {
  return {
    ok: true,
    outcome,
    idempotencyKey,
    body: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    receipt: {
      id: 'receipt-1',
      operationId: 'operation-1',
      catalogVersion: 'catalog-1',
      model: MODEL,
      usage: { inputTokens: '1', outputTokens: '1' },
      settlement: {
        success: true,
        transaction: '0xsettlement',
        network: 'eip155:8453',
        payer: '0x1111111111111111111111111111111111111111',
      },
      maximumAmount: '1000',
      actualAmount: '100',
    },
    payment: {
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x2222222222222222222222222222222222222222',
      authorizedMaximumAtomic: '1000',
      actualAtomic: '100',
      transaction: '0xsettlement',
    },
  };
}

function service(overrides: Partial<BuyerProxyService> = {}): BuyerProxyService {
  return {
    models: async () => MODELS,
    chat: async (_body, idempotencyKey) => success(idempotencyKey ?? 'generated'),
    ...overrides,
  };
}

const proxies: StartedBuyerProxy[] = [];

async function proxy(adapter: BuyerProxyService = service()): Promise<StartedBuyerProxy> {
  const started = await startBuyerProxy({ port: 0, token: TOKEN, service: adapter });
  proxies.push(started);
  return started;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    proxies.splice(0).map(async (item) => await item.close().catch(() => undefined)),
  );
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

describe('loopback OpenAI-compatible buyer proxy', () => {
  it('authenticates every media path, bypasses text caching, and never retries an ambiguous result', async () => {
    const execute = vi.fn<NonNullable<BuyerProxyService['execute']>>(async (_path, _body, key) => ({
      ok: false,
      outcome: 'ProviderOutcomeUnknown',
      retry: 'human_review',
      idempotencyKey: key ?? 'generated',
      message: 'Review the original operation.',
    }));
    const started = await proxy(service({ execute }));
    const cases = [
      [
        '/v1/messages',
        { model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 },
      ],
      ['/v1/images/generations', { model: 'image-model', prompt: 'a blue circle' }],
      ['/v1/audio/speech', { model: 'speech-model', input: 'hello' }],
      [
        '/v1/audio/transcriptions',
        {
          model: 'transcription-model',
          audio_base64: 'SUQzYXVkaW8=',
          acknowledge_provider_retention: true,
        },
      ],
    ] as const;
    for (const [endpoint, body] of cases) {
      const call = (headers: Record<string, string>) =>
        fetch(`${started.origin}${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
      expect((await call({})).status).toBe(401);
      expect((await call(auth({ origin: 'https://attacker.example' }))).status).toBe(403);
      const response = await call(auth({ 'idempotency-key': 'media-proxy-1' }));
      expect(response.status).toBe(409);
      expect(response.headers.get('x-onchain-router-cache')).toBe('BYPASS');
      expect(response.headers.get('x-should-retry')).toBe('false');
      expect(response.headers.get('x-onchain-router-retry')).toBe('human_review');
      expect(execute.mock.calls.at(-1)).toEqual([
        endpoint,
        body,
        'media-proxy-1',
        expect.any(AbortSignal),
      ]);
    }
    expect(execute).toHaveBeenCalledTimes(4);
    const rejected = await fetch(`${started.origin}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'transcription-model', audio_base64: 'SUQzYXVkaW8=' }),
    });
    expect(rejected.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('reuses paid text through HTTP, reports zero new charge, and preserves refresh/auth/recovery boundaries', async () => {
    const policy: BuyerStatus['policy'] = {
      canonicalOrigin: 'https://router.example',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipients: ['0x2222222222222222222222222222222222222222'],
      schemes: ['exact'],
      models: [MODEL],
      limits: {
        perCallAtomic: '1000',
        sessionAtomic: '10000',
        hourAtomic: '10000',
        dayAtomic: '10000',
      },
      delegations: [],
      sessionDurationMs: 60_000,
      reservationTtlMs: 5000,
      maximumAuthorizationSeconds: 60,
      maximumOutputTokens: 8192,
      requirePerCallConfirmation: false,
      hash: 'policy-1',
    };
    const status: BuyerStatus = {
      policy,
      address: 'payer',
      agentId: 'owner',
      sessionId: 'one',
      idleExpiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 60_000,
      spend: { sessionAtomic: '100', hourAtomic: '100', dayAtomic: '100', delegationAtomic: null },
    };
    const chat = vi.fn(async (_body, key: string | undefined) => success(key ?? 'generated'));
    const adapter = createBuyerProxyService({
      dependencies: {
        connectBuyer: async () => ({ chat, status: async () => status, close: vi.fn() }),
        inspectCatalog: async () => ({
          policy,
          models: {
            ...MODELS,
            data: [{ id: MODEL, supported_endpoints: ['/v1/chat/completions'] }],
          },
          pricing: {
            object: 'pricing_catalog',
            catalog_version: 'catalog-1',
            service_fee_basis_points: 0,
            promotion: 'launch',
            data: [],
          },
        }),
      },
    });
    const started = await proxy(adapter);
    const body = { model: MODEL, messages: [{ role: 'user', content: 'hello' }] };
    const call = (headers = {}, input = body) =>
      fetch(`${started.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json', ...headers }),
        body: JSON.stringify(input),
      });
    const first = await call();
    expect(first.headers.get('x-onchain-router-cache')).toBe('MISS');
    expect(first.headers.get('x-payment-actual-atomic')).toBe('100');
    const hit = await call();
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-onchain-router-cache')).toBe('HIT');
    expect(hit.headers.get('x-onchain-router-outcome')).toBe('CachedResponse');
    expect(hit.headers.get('x-onchain-router-charge-atomic')).toBe('0');
    expect(hit.headers.get('x-onchain-router-source-receipt-id')).toBe('receipt-1');
    expect(hit.headers.get('x-onchain-router-idempotency-key')).toBe(
      first.headers.get('x-onchain-router-idempotency-key'),
    );
    expect(hit.headers.get('cache-control')).toBe('no-store');
    expect(hit.headers.get('x-payment-transaction')).toBeNull();
    expect(hit.headers.get('x-payment-actual-atomic')).toBeNull();
    expect(hit.headers.get('x-receipt-id')).toBeNull();
    expect(await hit.json()).toEqual(await first.json());
    expect(chat).toHaveBeenCalledOnce();
    expect((await call({ authorization: 'Bearer invalid' })).status).toBe(401);
    expect(chat).toHaveBeenCalledOnce();
    expect(
      (await call({ 'Cache-Control': 'no-cache' })).headers.get('x-onchain-router-cache'),
    ).toBe('MISS');
    expect(
      (await call({ 'Cache-Control': 'no-store' })).headers.get('x-onchain-router-cache'),
    ).toBe('BYPASS');
    expect(
      (await call({}, { ...body, cache: false } as typeof body)).headers.get(
        'x-onchain-router-cache',
      ),
    ).toBe('BYPASS');
    expect(chat.mock.calls.at(-1)?.[0]).not.toHaveProperty('cache');
    expect(
      (await call({ 'Idempotency-Key': 'recover-source' })).headers.get('x-onchain-router-cache'),
    ).toBe('BYPASS');
    expect(chat).toHaveBeenCalledTimes(5);
    expect((await call({}, { ...body, cache: 'false' } as typeof body)).status).toBe(400);
    expect(chat).toHaveBeenCalledTimes(5);
    const close = vi.spyOn(adapter, 'close');
    await started.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it('serves the official OpenAI SDK and returns safe payment/receipt metadata', async () => {
    const chat = vi.fn(async (_body, key: string | undefined) => success(key ?? 'generated'));
    const started = await proxy(service({ chat }));
    const client = new OpenAI({
      apiKey: TOKEN,
      baseURL: `${started.origin}/v1`,
      maxRetries: 0,
      defaultHeaders: { 'Idempotency-Key': 'openai-proxy-1' },
    });
    const models = await client.models.list();
    expect(models.data.map((model) => model.id)).toEqual([MODEL]);
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    });
    expect(completion.object).toBe('chat.completion');
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
      'openai-proxy-1',
      expect.any(AbortSignal),
      { cacheMode: 'reuse', callerSuppliedIdempotencyKey: true },
    );
    const response = await fetch(`${started.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json', 'idempotency-key': 'metadata-1' }),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.headers.get('x-receipt-id')).toBe('receipt-1');
    expect(response.headers.get('x-payment-actual-atomic')).toBe('100');
    const returnedHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      returnedHeaders[name] = value;
    });
    expect(JSON.stringify(returnedHeaders)).not.toContain('receipt-token');
  });

  it('requires the bearer and rejects browsers, spoofed hosts, CORS, and unknown routes', async () => {
    const started = await proxy();
    const unauthenticated = await fetch(`${started.origin}/v1/models`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain('Bearer');

    const browser = await fetch(`${started.origin}/v1/models`, {
      headers: auth({ origin: 'https://attacker.example' }),
    });
    expect(browser.status).toBe(403);
    expect(browser.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${started.origin}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: auth({ origin: 'https://attacker.example' }),
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    const unknown = await fetch(`${started.origin}/wallet`, { headers: auth() });
    expect(unknown.status).toBe(404);

    const hostStatus = await new Promise<number>((resolve, reject) => {
      const url = new URL(started.origin);
      const request = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          path: '/v1/models',
          headers: auth({ host: 'attacker.example' }),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(hostStatus).toBe(400);
    const address = started.server.address();
    expect(address && typeof address !== 'string' ? address.address : null).toBe('127.0.0.1');
  });

  it('rejects streaming, authority injection, ambiguous keys, and oversized bodies before handoff', async () => {
    const chat = vi.fn(async (_body, key: string | undefined) => success(key ?? 'generated'));
    const started = await proxy(service({ chat }));
    for (const body of [
      { model: MODEL, messages: [{ role: 'user', content: 'hello' }], stream: true },
      { model: MODEL, messages: [{ role: 'user', content: 'hello' }], recipient: 'attacker' },
    ]) {
      const response = await fetch(`${started.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const ambiguous = await fetch(`${started.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: auth({
        'content-type': 'application/json',
        'idempotency-key': 'one',
        'x-idempotency-key': 'two',
      }),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(ambiguous.status).toBe(400);
    const oversized = await fetch(`${started.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'a'.repeat(128 * 1024) }],
      }),
    });
    expect(oversized.status).toBe(413);
    expect(chat).not.toHaveBeenCalled();
  });

  it('maps ambiguous financial outcomes to non-retryable-by-default HTTP 409', async () => {
    const failure: BuyerFailure = {
      ok: false,
      outcome: 'SettlementOutcomeUnknown',
      retry: 'human_review',
      idempotencyKey: 'ambiguous-1',
      message: 'settlement outcome is unknown',
      reference: 'trace-safe',
    };
    const started = await proxy(service({ chat: async () => failure }));
    const response = await fetch(`${started.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json', 'idempotency-key': 'ambiguous-1' }),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('x-onchain-router-retry')).toBe('human_review');
    expect(await response.json()).toMatchObject({
      error: { code: 'SettlementOutcomeUnknown' },
      onchain_router: { retry: 'human_review', reference: 'trace-safe' },
    });
  });

  it('prevents the official OpenAI client from automatically retrying ambiguity', async () => {
    const chat = vi.fn(
      async (_body, idempotencyKey: string | undefined): Promise<BuyerFailure> => ({
        ok: false,
        outcome: 'ProviderOutcomeUnknown',
        retry: 'human_review',
        idempotencyKey: idempotencyKey ?? 'missing',
        message: 'provider outcome is unknown',
      }),
    );
    const started = await proxy(service({ chat }));
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${started.origin}/v1` });

    await expect(
      client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(chat).toHaveBeenCalledOnce();
  });

  it('preserves one logical effect across concurrent same-key requests', async () => {
    let providerAndSettlementEffects = 0;
    const inFlight = new Map<string, Promise<BuyerResult>>();
    const adapter = service({
      chat: async (_body, key) => {
        const idempotencyKey = key ?? 'generated';
        const existing = inFlight.get(idempotencyKey);
        if (existing) return await existing;
        const operation = (async () => {
          providerAndSettlementEffects += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return success(idempotencyKey);
        })();
        inFlight.set(idempotencyKey, operation);
        return await operation;
      },
    });
    const started = await proxy(adapter);
    const call = async () =>
      await fetch(`${started.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json', 'idempotency-key': 'concurrent-1' }),
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
      });
    const responses = await Promise.all([call(), call(), call(), call()]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(providerAndSettlementEffects).toBe(1);
  });

  it('preserves the same key across a lost response and proxy restart', async () => {
    let providerEffects = 0;
    let releaseFinancialResult: (() => void) | undefined;
    let financialResultCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      financialResultCommitted = resolve;
    });
    const cache = new Map<string, BuyerResult>();
    const adapter = service({
      chat: async (_body, key) => {
        const idempotencyKey = key ?? 'generated';
        const existing = cache.get(idempotencyKey);
        if (existing) return { ...existing, outcome: 'RecoveredSuccess' } as BuyerResult;
        providerEffects += 1;
        await new Promise<void>((resolve) => {
          releaseFinancialResult = resolve;
        });
        const result = success(idempotencyKey);
        cache.set(idempotencyKey, result);
        financialResultCommitted?.();
        return result;
      },
    });
    const first = await proxy(adapter);
    await new Promise<void>((resolve, reject) => {
      const url = new URL(first.origin);
      const request = httpRequest({
        host: url.hostname,
        port: Number(url.port),
        path: '/v1/chat/completions',
        method: 'POST',
        headers: auth({ 'content-type': 'application/json', 'idempotency-key': 'lost-response-1' }),
      });
      request.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
        else reject(error);
      });
      request.end(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }));
      void vi
        .waitFor(() => expect(releaseFinancialResult).toBeTypeOf('function'))
        .then(() => {
          request.destroy();
          resolve();
        }, reject);
    });
    releaseFinancialResult?.();
    await committed;
    await first.close();
    proxies.splice(proxies.indexOf(first), 1);

    const restarted = await proxy(adapter);
    const recovered = await fetch(`${restarted.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json', 'idempotency-key': 'lost-response-1' }),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('x-onchain-router-outcome')).toBe('RecoveredSuccess');
    expect(providerEffects).toBe(1);
  });
});
