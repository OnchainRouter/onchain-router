import {
  PaymentPolicyRejected,
  SettlementOutcomeUnknown,
  type BuyerResult,
} from '@agenticfi/onchain-router-buyer-core';
import type { BuyerCatalogInspection, BuyerStatus } from '@agenticfi/onchain-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuyerProxyService } from '../src/service.js';
import { ResponseCache } from '../src/response-cache.js';

const BODY = {
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'hello' }],
};

const SUCCESS: BuyerResult = {
  ok: true,
  outcome: 'Completed',
  idempotencyKey: 'proxy-request-1',
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } },
    ],
  },
  receipt: {
    id: 'receipt-1',
    operationId: 'operation-1',
    catalogVersion: 'catalog-1',
    model: BODY.model,
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

const CATALOG: BuyerCatalogInspection = {
  models: {
    object: 'list',
    catalog_version: 'catalog-1',
    categories: [
      {
        id: 'text_generation',
        endpoints: [
          { method: 'POST', path: '/v1/chat/completions' },
          { method: 'POST', path: '/v1/messages' },
        ],
        model_ids: ['gemini-2.5-flash', 'gemini-not-allowed'],
      },
      {
        id: 'image_generation',
        endpoints: [{ method: 'POST', path: '/v1/images/generations' }],
        model_ids: ['gemini-image'],
      },
    ],
    data: [
      {
        id: 'gemini-2.5-flash',
        supported_endpoints: ['/v1/chat/completions', '/v1/messages'],
      },
      { id: 'gemini-not-allowed', supported_endpoints: ['/v1/chat/completions'] },
      { id: 'gemini-image', supported_endpoints: ['/v1/images/generations'] },
    ],
  },
  pricing: {
    object: 'pricing_catalog',
    catalog_version: 'catalog-1',
    service_fee_basis_points: 0,
    promotion: 'launch',
    data: [],
  },
  policy: {
    canonicalOrigin: 'https://router.example',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipients: ['0x2222222222222222222222222222222222222222'],
    schemes: ['upto'],
    models: ['gemini-2.5-flash', 'gemini-image'],
    limits: {
      perCallAtomic: '1000',
      sessionAtomic: '2000',
      hourAtomic: '2000',
      dayAtomic: '5000',
    },
    delegations: [],
    sessionDurationMs: 60_000,
    reservationTtlMs: 5_000,
    maximumAuthorizationSeconds: 60,
    maximumOutputTokens: 8192,
    requirePerCallConfirmation: false,
    hash: 'policy-1',
  },
};

const STATUS: BuyerStatus = {
  address: '0x1111111111111111111111111111111111111111',
  agentId: 'owner',
  sessionId: 'session-1',
  idleExpiresAt: Date.now() + 3_600_000,
  absoluteExpiresAt: Date.now() + 3_600_000,
  policy: {
    ...CATALOG.policy,
    models: [...CATALOG.policy.models],
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipients: ['0x2222222222222222222222222222222222222222'],
    schemes: ['upto'],
    delegations: [],
  },
  spend: { sessionAtomic: '100', hourAtomic: '100', dayAtomic: '100', delegationAtomic: null },
};

const services: ReturnType<typeof createBuyerProxyService>[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function cacheHarness(cacheEnabled = true) {
  const state = { status: structuredClone(STATUS), catalog: structuredClone(CATALOG) };
  const chat = vi.fn(async (): Promise<BuyerResult> => structuredClone(SUCCESS));
  const status = vi.fn(async () => state.status);
  const inspectCatalog = vi.fn(async () => state.catalog);
  const connectBuyer = vi.fn(async () => ({ chat, status, close: vi.fn() }));
  const service = createBuyerProxyService({
    cacheEnabled,
    dependencies: { connectBuyer, inspectCatalog },
  });
  services.push(service);
  const call = (body = BODY, key?: string) => service.chat(body, key, new AbortController().signal);
  return { state, chat, status, inspectCatalog, connectBuyer, service, call };
}

describe('session-isolated response reuse', () => {
  it('reuses a verified answer without another paid handoff or a fabricated payment', async () => {
    const chat = vi.fn(async () => SUCCESS);
    const status = vi.fn(async () => STATUS);
    const service = createBuyerProxyService({
      dependencies: {
        connectBuyer: async () => ({ chat, status, close: vi.fn() }),
        inspectCatalog: async () => CATALOG,
      },
    });
    await service.chat(BODY, undefined, new AbortController().signal);
    const hit = await service.chat(BODY, undefined, new AbortController().signal);
    expect(hit).toMatchObject({
      ok: true,
      outcome: 'CachedResponse',
      body: SUCCESS.body,
      chargedAtomic: '0',
      cache: { sourceReceiptId: 'receipt-1' },
    });
    expect(hit).not.toHaveProperty('payment');
    expect(hit).not.toHaveProperty('receipt');
    expect(chat).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(2);
    service.close?.();
  });

  it('bypasses both lookup and storage for caller idempotency, preserving ambiguity', async () => {
    const h = cacheHarness();
    await h.call();
    const failure: BuyerResult = {
      ok: false,
      outcome: 'SettlementOutcomeUnknown',
      retry: 'human_review',
      idempotencyKey: 'ambiguous-key',
      message: 'review settlement',
    };
    h.chat.mockResolvedValueOnce(failure);
    await expect(h.call(BODY, 'ambiguous-key')).resolves.toBe(failure);
    expect(h.chat).toHaveBeenLastCalledWith(BODY, 'ambiguous-key');
    expect(h.chat).toHaveBeenCalledTimes(2);
    const separate = cacheHarness();
    await separate.call(BODY, 'first-key');
    await expect(separate.call()).resolves.toMatchObject({ outcome: 'Completed' });
    expect(separate.chat).toHaveBeenCalledTimes(2);
  });

  it.each(['sessionId', 'agentId', 'address'] as const)(
    'isolates the cache by %s',
    async (field) => {
      const h = cacheHarness();
      await h.call();
      h.state.status = { ...h.state.status, [field]: 'another-identity' };
      await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
      expect(h.chat).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['hash', 'canonicalOrigin'] as const)(
    'isolates the cache by policy %s',
    async (field) => {
      const h = cacheHarness();
      await h.call();
      h.state.status = {
        ...h.state.status,
        policy: { ...h.state.status.policy, [field]: 'different' },
      };
      h.state.catalog = {
        ...h.state.catalog,
        policy: { ...h.state.catalog.policy, [field]: 'different' },
      };
      await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
      expect(h.chat).toHaveBeenCalledTimes(2);
    },
  );

  it('does not reuse a changed catalog or a removed model', async () => {
    const h = cacheHarness();
    await h.call();
    h.state.catalog = {
      ...h.state.catalog,
      models: { ...h.state.catalog.models, catalog_version: 'catalog-2' },
    };
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    h.state.catalog = { ...h.state.catalog, models: { ...h.state.catalog.models, data: [] } };
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    expect(h.chat).toHaveBeenCalledTimes(3);
  });

  it.each(['model', 'delegation', 'expired', 'policy-race'] as const)(
    'rejects %s revocation before reuse or paid handoff',
    async (reason) => {
      const h = cacheHarness();
      await h.call();
      if (reason === 'model')
        h.state.status = { ...h.state.status, policy: { ...h.state.status.policy, models: [] } };
      if (reason === 'delegation')
        h.state.status = {
          ...h.state.status,
          policy: {
            ...h.state.status.policy,
            delegations: [{ agentId: STATUS.agentId, maximumAtomic: '1000', revoked: true }],
          },
        };
      if (reason === 'expired')
        h.state.status = { ...h.state.status, idleExpiresAt: Date.now() - 1 };
      if (reason === 'policy-race')
        h.state.status = {
          ...h.state.status,
          policy: { ...h.state.status.policy, hash: 'changed-mid-read' },
        };
      await expect(h.call()).rejects.toBeInstanceOf(PaymentPolicyRejected);
      expect(h.chat).toHaveBeenCalledOnce();
    },
  );

  it('clears on lock/unavailable discovery and cannot serve offline stale content', async () => {
    const h = cacheHarness();
    await h.call();
    h.connectBuyer.mockRejectedValueOnce(new PaymentPolicyRejected('locked'));
    await expect(h.call()).rejects.toThrow('locked');
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    h.inspectCatalog.mockRejectedValueOnce(new Error('discovery unavailable'));
    await expect(h.call()).rejects.toThrow('discovery unavailable');
    expect(h.chat).toHaveBeenCalledTimes(2);
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
  });

  it('clears on broker revocation and respects cancellation after discovery', async () => {
    const h = cacheHarness();
    await h.call();
    h.status.mockRejectedValueOnce(new PaymentPolicyRejected('session locked'));
    await expect(h.call()).rejects.toThrow('session locked');
    await h.call();
    const controller = new AbortController();
    h.inspectCatalog.mockImplementationOnce(async () => {
      controller.abort();
      return h.state.catalog;
    });
    await expect(h.service.chat(BODY, undefined, controller.signal)).rejects.toThrow('cancelled');
    expect(h.chat).toHaveBeenCalledTimes(2);
  });

  it('refreshes explicitly, without falling back to old content after a failed refresh', async () => {
    const h = cacheHarness();
    await h.call();
    h.chat.mockResolvedValueOnce({
      ok: false,
      outcome: 'ProviderOutcomeUnknown',
      retry: 'human_review',
      idempotencyKey: 'unknown',
      message: 'review provider',
    });
    await expect(
      h.service.chat(BODY, undefined, new AbortController().signal, { cacheMode: 'refresh' }),
    ).resolves.toMatchObject({ ok: false, outcome: 'ProviderOutcomeUnknown' });
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    await expect(h.call()).resolves.toMatchObject({ outcome: 'CachedResponse' });
    expect(h.chat).toHaveBeenCalledTimes(3);
  });

  it('bypasses for disabled caches, no-store, and per-call confirmation policies', async () => {
    const disabled = cacheHarness(false);
    await disabled.call();
    await disabled.call();
    expect(disabled.chat).toHaveBeenCalledTimes(2);
    expect(disabled.inspectCatalog).not.toHaveBeenCalled();
    const h = cacheHarness();
    await h.service.chat(BODY, undefined, new AbortController().signal, { cacheMode: 'bypass' });
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    h.state.status = {
      ...h.state.status,
      policy: { ...h.state.status.policy, requirePerCallConfirmation: true },
    };
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    expect(h.chat).toHaveBeenCalledTimes(3);
  });

  it('never caches failures, wrong-model receipts, or stale-catalog receipts', async () => {
    const h = cacheHarness();
    h.chat.mockResolvedValueOnce({
      ok: false,
      outcome: 'ReceiptVerificationFailed',
      retry: 'retry_same_idempotency_key',
      idempotencyKey: 'bad-receipt',
      message: 'not verified',
    });
    await h.call();
    if (!SUCCESS.ok) throw new Error('fixture');
    h.chat.mockResolvedValueOnce({
      ...SUCCESS,
      receipt: { ...SUCCESS.receipt, model: 'wrong-model' },
    });
    await h.call();
    h.chat.mockResolvedValueOnce({
      ...SUCCESS,
      receipt: { ...SUCCESS.receipt, catalogVersion: 'stale' },
    });
    await h.call();
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    expect(h.chat).toHaveBeenCalledTimes(4);
  });

  it('does not let cache maintenance replace a verified result with ambiguity', async () => {
    const h = cacheHarness();
    vi.spyOn(ResponseCache.prototype, 'put').mockImplementationOnce(() => {
      throw new Error('cache unavailable');
    });
    await expect(h.call()).resolves.toMatchObject({ ok: true, outcome: 'Completed' });
    await expect(h.call()).resolves.toMatchObject({ ok: true, outcome: 'Completed' });
    expect(h.chat).toHaveBeenCalledTimes(2);
  });

  it('preserves explicit-key conflicts even when the answer is already cached', async () => {
    const h = cacheHarness();
    await h.call();
    h.chat.mockResolvedValueOnce({
      ok: false,
      outcome: 'IdempotencyConflict',
      retry: 'do_not_retry',
      idempotencyKey: 'conflict-key',
      message: 'different operation',
    });
    await expect(h.call(BODY, 'conflict-key')).resolves.toMatchObject({
      ok: false,
      outcome: 'IdempotencyConflict',
    });
    expect(h.chat).toHaveBeenCalledTimes(2);
  });

  it('does not persist across service restart, and expires rather than extending TTL on hits', async () => {
    vi.useFakeTimers();
    const h = cacheHarness();
    await h.call();
    vi.advanceTimersByTime(9 * 60_000);
    await expect(h.call()).resolves.toMatchObject({ outcome: 'CachedResponse' });
    vi.advanceTimersByTime(60_000);
    await expect(h.call()).resolves.toMatchObject({ outcome: 'Completed' });
    h.service.close?.();
    const fresh = cacheHarness();
    await expect(fresh.call()).resolves.toMatchObject({ outcome: 'Completed' });
  });
});

describe('local proxy Buyer Runtime adapter', () => {
  it('filters model discovery to local-policy callable aliases across categories', async () => {
    const service = createBuyerProxyService({
      dependencies: { inspectCatalog: async () => CATALOG },
    });
    await expect(service.models(new AbortController().signal)).resolves.toMatchObject({
      data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-image' }],
      categories: [
        {
          id: 'text_generation',
          endpoints: [
            { method: 'POST', path: '/v1/chat/completions' },
            { method: 'POST', path: '/v1/messages' },
          ],
          model_ids: ['gemini-2.5-flash'],
        },
        {
          id: 'image_generation',
          endpoints: [{ method: 'POST', path: '/v1/images/generations' }],
          model_ids: ['gemini-image'],
        },
      ],
    });
  });

  it('forwards the exact body and stable key without payment authority', async () => {
    const chat = vi.fn(async () => SUCCESS);
    const close = vi.fn();
    const service = createBuyerProxyService({
      dependencies: { connectBuyer: async () => ({ chat, close, status: async () => STATUS }) },
    });
    await expect(service.chat(BODY, 'proxy-request-1', new AbortController().signal)).resolves.toBe(
      SUCCESS,
    );
    expect(chat).toHaveBeenCalledWith(BODY, 'proxy-request-1');
    expect(JSON.stringify(chat.mock.calls)).not.toMatch(
      /recipient|payTo|privateKey|maximumAtomic/i,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('honors cancellation before handoff and finishes after handoff', async () => {
    const before = new AbortController();
    before.abort();
    const connectBuyer = vi.fn();
    const service = createBuyerProxyService({ dependencies: { connectBuyer } });
    await expect(service.chat(BODY, 'proxy-request-1', before.signal)).rejects.toBeInstanceOf(
      PaymentPolicyRejected,
    );
    expect(connectBuyer).not.toHaveBeenCalled();

    const after = new AbortController();
    const chat = vi.fn(async () => {
      after.abort();
      return SUCCESS;
    });
    const afterService = createBuyerProxyService({
      dependencies: {
        connectBuyer: async () => ({ chat, close: vi.fn(), status: async () => STATUS }),
      },
    });
    await expect(afterService.chat(BODY, 'proxy-request-1', after.signal)).resolves.toBe(SUCCESS);
  });

  it('classifies an unexpected post-handoff exception as settlement unknown', async () => {
    const service = createBuyerProxyService({
      dependencies: {
        connectBuyer: async () => ({
          status: async () => STATUS,
          chat: async () => {
            throw new Error('must not escape as retryable HTTP 500');
          },
          close: vi.fn(),
        }),
      },
    });
    await expect(
      service.chat(BODY, 'proxy-request-1', new AbortController().signal),
    ).rejects.toBeInstanceOf(SettlementOutcomeUnknown);
  });

  it('does not let cleanup replace a durable Buyer Runtime result', async () => {
    const close = vi.fn(() => {
      throw new Error('local close failed after the durable result');
    });
    const service = createBuyerProxyService({
      dependencies: {
        connectBuyer: async () => ({
          chat: async () => SUCCESS,
          close,
          status: async () => STATUS,
        }),
      },
    });
    await expect(service.chat(BODY, 'proxy-request-1', new AbortController().signal)).resolves.toBe(
      SUCCESS,
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
