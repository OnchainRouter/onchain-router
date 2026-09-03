import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSpendLedger } from '../src/ledger.js';
import { BuyerRuntime } from '../src/runtime.js';
import { canonicalHash } from '../src/canonical.js';
import { createBuyerPolicy } from '../src/policy.js';
import type { BrokerAuthorizationRequest, PaymentAuthorizer } from '../src/types.js';
import {
  TEST_ASSET,
  TEST_ORIGIN,
  TEST_RECIPIENT,
  testPaymentRequired,
  testPolicy,
} from './helpers.js';

const directories: string[] = [];
const PAYER = '0x4444444444444444444444444444444444444444' as const;

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-runtime-'));
  await chmod(path, 0o700);
  directories.push(path);
  return path;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function settlement(amount = '123') {
  return {
    success: true as const,
    transaction: '0xsettlement',
    network: 'eip155:8453' as const,
    payer: PAYER,
    amount,
  };
}

function durableReceipt(id: string, amount = '123', maximum = '600') {
  return {
    id,
    operationId: id,
    catalogVersion: 'catalog-test',
    model: 'gemini-2.5-flash',
    usage: { inputTokens: '1', outputTokens: '2' },
    settlement: {
      success: true,
      transaction: '0xsettlement',
      network: 'eip155:8453',
      payer: PAYER,
    },
    maximumAmount: maximum,
    actualAmount: amount,
  };
}

function challengeResponse(): Response {
  return json(
    { error: 'payment_required' },
    {
      status: 402,
      headers: { 'payment-required': encodePaymentRequiredHeader(testPaymentRequired()) },
    },
  );
}

function paidResponse(receiptId: string, recovered = false): Response {
  return json(
    { id: 'completion', choices: [{ message: { role: 'assistant', content: 'hello' } }] },
    {
      status: 200,
      headers: {
        'payment-response': encodePaymentResponseHeader(settlement()),
        'x-receipt-id': receiptId,
        'x-receipt-token': 'receipt-capability-never-returned',
        ...(recovered ? { 'x-recovered-response': 'true' } : {}),
      },
    },
  );
}

class TestAuthorizer implements PaymentAuthorizer {
  public readonly address = PAYER;
  public readonly agentId = 'test-agent';
  public readonly sessionId = 'test-session';
  public calls = 0;

  public constructor(private readonly ledger: LocalSpendLedger) {}

  public async authorize(request: BrokerAuthorizationRequest): Promise<PaymentPayload> {
    this.calls += 1;
    this.ledger.claimAuthorization(
      request.idempotencyKey,
      request.requestHash,
      request.requirementHash,
    );
    this.ledger.markAuthorized(
      request.idempotencyKey,
      request.requestHash,
      request.requirementHash,
    );
    return {
      x402Version: 2,
      resource: request.paymentRequired.resource,
      accepted: request.paymentRequired.accepts[0]!,
      payload: { signature: '0xtest' },
    };
  }
}

async function setup(fetcher: typeof fetch) {
  const root = await directory();
  const ledger = new LocalSpendLedger(join(root, 'ledger.sqlite'), testPolicy());
  const authorizer = new TestAuthorizer(ledger);
  return {
    ledger,
    authorizer,
    runtime: new BuyerRuntime({ ledger, authorizer, fetch: fetcher, receiptAttempts: 3 }),
  };
}

function request(idempotencyKey = 'runtime-payment') {
  return {
    url: `${TEST_ORIGIN}/v1/chat/completions`,
    model: 'gemini-2.5-flash',
    body: {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    },
    idempotencyKey,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe('official x402 buyer lifecycle', () => {
  it('recovers a prior ambiguous success without signing or repeating the paid POST', async () => {
    const receiptId = randomUUID();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return paidResponse(receiptId, true);
      return json(durableReceipt(receiptId));
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    const pending = request('recover-me');
    const serializedUrl = new URL(pending.url).toString();
    const requestHash = canonicalHash({
      method: 'POST',
      url: serializedUrl,
      body: pending.body,
      model: pending.model,
    });
    const challenge = testPaymentRequired();
    const requirementHash = canonicalHash(challenge.accepts[0]);
    context.ledger.reserve({
      idempotencyKey: 'recover-me',
      requestHash,
      requirementHash,
      model: pending.model,
      agentId: context.authorizer.agentId,
      sessionId: context.authorizer.sessionId,
      maximumAtomic: 600n,
      now: Date.now(),
    });
    context.ledger.claimAuthorization('recover-me', requestHash, requirementHash);
    context.ledger.markAuthorized('recover-me', requestHash, requirementHash);
    context.ledger.markUnknown('recover-me');
    try {
      const result = await context.runtime.execute(pending);
      expect(result).toMatchObject({ ok: true, outcome: 'RecoveredSuccess' });
      expect(context.authorizer.calls).toBe(0);
      expect(calls).toBe(2);
      expect(context.ledger.get('recover-me')?.state).toBe('spent');
    } finally {
      context.ledger.close();
    }
  });

  it('uses one identity and identical body for challenge/retry, then returns only after receipt', async () => {
    const receiptId = randomUUID();
    const calls: Array<{
      url: string;
      method: string;
      body: string | null;
      headers: Headers;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      });
      if (calls.length === 1) return challengeResponse();
      if (calls.length === 2) return paidResponse(receiptId);
      return json(durableReceipt(receiptId));
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute({
        ...request(),
        headers: { 'x-quote-token': 'request-bound.quote' },
      });
      expect(result).toMatchObject({
        ok: true,
        outcome: 'Completed',
        payment: {
          network: 'eip155:8453',
          asset: TEST_ASSET,
          recipient: TEST_RECIPIENT,
          authorizedMaximumAtomic: '600',
          actualAtomic: '123',
        },
      });
      expect(calls).toHaveLength(3);
      expect(calls[0]?.body).toBe(calls[1]?.body);
      expect(calls[0]?.headers.get('x-idempotency-key')).toBe('runtime-payment');
      expect(calls[1]?.headers.get('x-idempotency-key')).toBe('runtime-payment');
      expect(calls[1]?.headers.get('payment-signature')).toBeTruthy();
      expect(calls[0]?.headers.get('x-quote-token')).toBe('request-bound.quote');
      expect(calls[1]?.headers.get('x-quote-token')).toBe('request-bound.quote');
      expect(calls[2]?.method).toBe('GET');
      expect(calls.every(({ redirect }) => redirect === 'error')).toBe(true);
      expect(calls[2]?.headers.get('x-receipt-token')).toBe('receipt-capability-never-returned');
      expect(context.ledger.get('runtime-payment')).toMatchObject({
        state: 'spent',
        actualAtomic: 123n,
      });
    } finally {
      context.ledger.close();
    }
  });

  it('never retries an ambiguous paid POST and retains its maximum as unknown spend', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      throw new TypeError('network connection dropped');
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('ambiguous'));
      expect(result).toMatchObject({ ok: false, outcome: 'SettlementOutcomeUnknown' });
      expect(calls).toBe(2);
      expect(context.ledger.get('ambiguous')?.state).toBe('unknown');
    } finally {
      context.ledger.close();
    }
  });

  it('keeps authorization ambiguous when a paid error response cannot be read safely', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return new Response(null, {
        status: 503,
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
      });
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('oversized-paid-error'));
      expect(result).toMatchObject({ ok: false, outcome: 'RuntimeUnavailable' });
      expect(calls).toBe(2);
      expect(context.ledger.get('oversized-paid-error')?.state).toBe('unknown');
    } finally {
      context.ledger.close();
    }
  });

  it('withholds a successful provider body when receipt verification fails', async () => {
    const receiptId = randomUUID();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      if (calls === 2) return paidResponse(receiptId);
      return json({ error: 'receipt_unavailable' }, { status: 503 });
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('receipt-failure'));
      expect(result).toMatchObject({ ok: false, outcome: 'ReceiptVerificationFailed' });
      expect(result).not.toHaveProperty('body');
      expect(calls).toBe(5);
      expect(context.ledger.get('receipt-failure')?.state).toBe('unknown');
    } finally {
      context.ledger.close();
    }
  });

  it('rejects an over-maximum or wrong-payer receipt and keeps the outcome ambiguous', async () => {
    const receiptId = randomUUID();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      if (calls === 2) return paidResponse(receiptId);
      return json({
        ...durableReceipt(receiptId, '601'),
        settlement: {
          ...durableReceipt(receiptId).settlement,
          payer: '0x5555555555555555555555555555555555555555',
        },
      });
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('bad-receipt'));
      expect(result).toMatchObject({ ok: false, outcome: 'ReceiptVerificationFailed' });
      expect(context.ledger.get('bad-receipt')?.state).toBe('unknown');
    } finally {
      context.ledger.close();
    }
  });

  it('rejects a PAYMENT-RESPONSE whose payer does not match the unlocked signer', async () => {
    const receiptId = randomUUID();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return json(
        { id: 'completion' },
        {
          status: 200,
          headers: {
            'payment-response': encodePaymentResponseHeader({
              ...settlement(),
              payer: '0x5555555555555555555555555555555555555555',
            }),
            'x-receipt-id': receiptId,
            'x-receipt-token': 'must-not-be-used',
          },
        },
      );
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('wrong-settlement-payer'));
      expect(result).toMatchObject({ ok: false, outcome: 'ReceiptVerificationFailed' });
      expect(calls).toBe(2);
      expect(context.ledger.get('wrong-settlement-payer')?.state).toBe('unknown');
    } finally {
      context.ledger.close();
    }
  });

  it('releases a definite payment rejection and preserves provider/settlement unknown outcomes', async () => {
    for (const scenario of [
      {
        code: 'payment_rejected',
        status: 402,
        outcome: 'PaymentVerificationRejected',
        state: 'released',
      },
      { code: 'insufficient_funds', status: 402, outcome: 'InsufficientFunds', state: 'released' },
      {
        code: 'provider_outcome_unknown',
        status: 502,
        outcome: 'ProviderOutcomeUnknown',
        state: 'unknown',
      },
      {
        code: 'settlement_or_receipt_unknown',
        status: 503,
        outcome: 'SettlementOutcomeUnknown',
        state: 'unknown',
      },
    ] as const) {
      let calls = 0;
      const fetcher = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return challengeResponse();
        return json({ error: { code: scenario.code } }, { status: scenario.status });
      }) as unknown as typeof fetch;
      const context = await setup(fetcher);
      try {
        const key = `known-${scenario.status}-${scenario.code}`;
        const result = await context.runtime.execute(request(key));
        expect(result).toMatchObject({ ok: false, outcome: scenario.outcome });
        expect(context.ledger.get(key)?.state).toBe(scenario.state);
      } finally {
        context.ledger.close();
      }
    }
  });

  it('classifies a provider-execution quarantine as a non-retriable policy rejection', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return json({ error: 'payer_provider_quarantined' }, { status: 429 });
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('payer-quarantined'));
      expect(result).toMatchObject({
        ok: false,
        outcome: 'PaymentPolicyRejected',
        retry: 'do_not_retry',
        message: 'payer_provider_quarantined',
      });
      expect(context.ledger.get('payer-quarantined')?.state).toBe('released');
    } finally {
      context.ledger.close();
    }
  });

  it('reports a safe x402 rejection code from the updated PAYMENT-REQUIRED header', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return json(
        { error: 'Payment Required' },
        {
          status: 402,
          headers: {
            'payment-required': encodePaymentRequiredHeader({
              ...testPaymentRequired(),
              error: 'invalid_permit2_allowance',
            }),
          },
        },
      );
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('header-error'));
      expect(result).toMatchObject({
        ok: false,
        outcome: 'PaymentVerificationRejected',
        message: 'invalid_permit2_allowance',
      });
      expect(context.ledger.get('header-error')?.state).toBe('released');
    } finally {
      context.ledger.close();
    }
  });

  it('normalizes a bounded facilitator diagnostic suffix without exposing remote prose', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return json(
        { error: 'Payment Required' },
        {
          status: 402,
          headers: {
            'payment-required': encodePaymentRequiredHeader({
              ...testPaymentRequired(),
              error: 'insufficient_funds: simulation failed',
            }),
          },
        },
      );
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('header-error-suffix'));
      expect(result).toMatchObject({
        ok: false,
        outcome: 'InsufficientFunds',
        message: 'insufficient_funds',
      });
      expect(context.ledger.get('header-error-suffix')?.state).toBe('released');
    } finally {
      context.ledger.close();
    }
  });

  it('maps a known prose transport rejection to a safe machine-readable reason', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return challengeResponse();
      return json(
        { error: 'Payment Required' },
        {
          status: 402,
          headers: {
            'payment-required': encodePaymentRequiredHeader({
              ...testPaymentRequired(),
              error: 'No matching payment requirements',
            }),
          },
        },
      );
    }) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const result = await context.runtime.execute(request('header-error-phrase'));
      expect(result).toMatchObject({
        ok: false,
        outcome: 'PaymentVerificationRejected',
        message: 'no_matching_payment_requirements',
      });
      expect(context.ledger.get('header-error-phrase')?.state).toBe('released');
    } finally {
      context.ledger.close();
    }
  });

  it('refuses changed body/model identity and unapproved forwarding headers before network use', async () => {
    const fetcher = vi.fn(async () => challengeResponse()) as unknown as typeof fetch;
    const context = await setup(fetcher);
    try {
      const wrongModel = await context.runtime.execute({
        ...request('wrong-model'),
        body: { model: 'different-model' },
      });
      expect(wrongModel).toMatchObject({ ok: false, outcome: 'PaymentPolicyRejected' });
      const unapprovedModel = await context.runtime.execute({
        ...request('unapproved-model'),
        model: 'unapproved-model',
        body: { model: 'unapproved-model' },
      });
      expect(unapprovedModel).toMatchObject({
        ok: false,
        outcome: 'PaymentPolicyRejected',
      });
      const unsafeHeader = await context.runtime.execute({
        ...request('unsafe-header'),
        headers: { authorization: 'must-not-forward' },
      });
      expect(unsafeHeader).toMatchObject({ ok: false, outcome: 'PaymentPolicyRejected' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      context.ledger.close();
    }
  });

  it('enforces output-token and human confirmation policy before signing', async () => {
    const root = await directory();
    const policy = createBuyerPolicy({ ...testPolicy(), requirePerCallConfirmation: true });
    const ledger = new LocalSpendLedger(join(root, 'confirmation.sqlite'), policy);
    const authorizer = new TestAuthorizer(ledger);
    const fetcher = vi.fn(async () => challengeResponse()) as unknown as typeof fetch;
    try {
      const overTokens = await new BuyerRuntime({ ledger, authorizer, fetch: fetcher }).execute({
        ...request('too-many-tokens'),
        body: { ...request().body, max_tokens: 8_193 },
      });
      expect(overTokens).toMatchObject({ ok: false, outcome: 'PaymentPolicyRejected' });
      expect(fetcher).not.toHaveBeenCalled();

      const confirmation = vi.fn(async () => false);
      const declined = await new BuyerRuntime({
        ledger,
        authorizer,
        fetch: fetcher,
        confirmPayment: confirmation,
      }).execute(request('declined'));
      expect(declined).toMatchObject({ ok: false, outcome: 'PaymentPolicyRejected' });
      expect(confirmation).toHaveBeenCalledWith(
        expect.objectContaining({ maximumAtomic: '600', recipient: TEST_RECIPIENT }),
      );
      expect(authorizer.calls).toBe(0);
      expect(ledger.get('declined')).toBeNull();
    } finally {
      ledger.close();
    }
  });
});
