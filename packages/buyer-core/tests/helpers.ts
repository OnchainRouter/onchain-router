import type { PaymentRequired } from '@x402/core/types';
import { createBuyerPolicy } from '../src/policy.js';

export const TEST_ORIGIN = 'https://buyer.example';
export const TEST_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const TEST_RECIPIENT = '0x1111111111111111111111111111111111111111';
export const TEST_FACILITATOR = '0x2222222222222222222222222222222222222222';

export function testPolicy(overrides: Record<string, unknown> = {}) {
  return createBuyerPolicy({
    canonicalOrigin: TEST_ORIGIN,
    network: 'eip155:8453',
    asset: TEST_ASSET,
    recipients: [TEST_RECIPIENT],
    schemes: ['upto'],
    models: ['gemini-2.5-flash'],
    limits: {
      perCallAtomic: 1_000n,
      sessionAtomic: 2_000n,
      hourAtomic: 1_000n,
      dayAtomic: 5_000n,
    },
    delegations: [{ agentId: 'test-agent', maximumAtomic: 2_000n }],
    sessionDurationMs: 60_000,
    reservationTtlMs: 1_000,
    maximumAuthorizationSeconds: 60,
    maximumOutputTokens: 8_192,
    requirePerCallConfirmation: false,
    ...overrides,
  });
}

export function testPaymentRequired(
  amount = '600',
  overrides: Partial<PaymentRequired> = {},
): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: `${TEST_ORIGIN}/v1/chat/completions`,
      description: 'test',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'upto',
        network: 'eip155:8453',
        asset: TEST_ASSET,
        amount,
        payTo: TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        extra: { facilitatorAddress: TEST_FACILITATOR },
      },
    ],
    ...overrides,
  };
}

export function testExactPolicy(overrides: Record<string, unknown> = {}) {
  return testPolicy({ schemes: ['exact'], ...overrides });
}

export function testExactPaymentRequired(amount = '600'): PaymentRequired {
  const paymentRequired = testPaymentRequired(amount);
  paymentRequired.accepts[0] = {
    ...paymentRequired.accepts[0]!,
    scheme: 'exact',
    extra: {
      name: 'USD Coin',
      version: '2',
    },
  };
  return paymentRequired;
}
