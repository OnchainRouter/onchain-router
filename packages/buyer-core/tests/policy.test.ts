import { describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import {
  AuthorizationAboveLocalCap,
  PaymentPolicyRejected,
  UnexpectedAsset,
  UnexpectedRecipient,
  UnsupportedNetwork,
} from '../src/errors.js';
import { createBuyerPolicy, validatePaymentRequirement } from '../src/policy.js';
import {
  TEST_ASSET,
  TEST_ORIGIN,
  TEST_RECIPIENT,
  testPaymentRequired,
  testPolicy,
} from './helpers.js';

describe('buyer policy', () => {
  it('normalizes and hashes a Base-mainnet exact policy', () => {
    const policy = testPolicy();
    expect(policy.network).toBe('eip155:8453');
    expect(policy.asset).toBe(TEST_ASSET);
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.models)).toBe(true);
    expect(Object.isFrozen(policy.recipients)).toBe(true);
    expect(Object.isFrozen(policy.delegations)).toBe(true);
  });

  it('rejects non-mainnet, non-HTTPS, unsupported scheme, and invalid money', () => {
    expect(() =>
      createBuyerPolicy({
        ...testPolicy(),
        network: 'eip155:84532',
      }),
    ).toThrow(UnsupportedNetwork);
    expect(() =>
      createBuyerPolicy({ ...testPolicy(), canonicalOrigin: 'http://buyer.example' }),
    ).toThrow(PaymentPolicyRejected);
    expect(() => createBuyerPolicy({ ...testPolicy(), schemes: ['custom'] as never })).toThrow(
      PaymentPolicyRejected,
    );
    expect(() =>
      createBuyerPolicy({
        ...testPolicy(),
        limits: { ...testPolicy().limits, perCallAtomic: 0n },
      }),
    ).toThrow(PaymentPolicyRejected);
  });

  it('rejects ambiguous address checksums and duplicate delegation identities', () => {
    expect(() =>
      createBuyerPolicy({
        ...testPolicy(),
        asset: '0x8ba1f109551bd432803012645Ac136ddd64DBA72',
      }),
    ).toThrow(UnexpectedAsset);
    expect(() =>
      createBuyerPolicy({
        ...testPolicy(),
        delegations: [
          { agentId: 'duplicate', maximumAtomic: 600n },
          { agentId: 'duplicate', maximumAtomic: 500n, revoked: true },
        ],
      }),
    ).toThrow(PaymentPolicyRejected);
  });

  it('accepts only an exact policy-bound challenge', () => {
    const validated = validatePaymentRequirement(
      testPaymentRequired(),
      testPolicy(),
      `${TEST_ORIGIN}/v1/chat/completions`,
      'gemini-2.5-flash',
    );
    expect(validated.amountAtomic).toBe(600n);
    expect(validated.requirement.payTo).toBe(TEST_RECIPIENT);
  });

  it('blocks a legacy upto profile with an explicit one-way migration command', () => {
    expect(() =>
      validatePaymentRequirement(
        testPaymentRequired(),
        testPolicy({ schemes: ['upto'] }),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'gemini-2.5-flash',
      ),
    ).toThrow('legacy upto profiles cannot spend; run onchain-router policy set --scheme exact');
  });

  it.each([
    ['facilitator address', { name: 'USD Coin', version: '2', facilitatorAddress: TEST_RECIPIENT }],
    ['Permit2 marker', { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' }],
    ['unknown metadata', { name: 'USD Coin', version: '2', unexpected: true }],
  ])('rejects nonstandard exact EIP-712 %s before signing', (_label, extra) => {
    const challenge = testPaymentRequired();
    challenge.accepts[0] = { ...challenge.accepts[0]!, extra } as PaymentRequirements;
    expect(() =>
      validatePaymentRequirement(
        challenge,
        testPolicy(),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'gemini-2.5-flash',
      ),
    ).toThrow(PaymentPolicyRejected);
  });

  it.each([
    ['network', { network: 'eip155:84532' }, UnsupportedNetwork],
    ['scheme', { scheme: 'upto' }, PaymentPolicyRejected],
    ['asset', { asset: '0x3333333333333333333333333333333333333333' }, UnexpectedAsset],
    ['recipient', { payTo: '0x3333333333333333333333333333333333333333' }, UnexpectedRecipient],
    ['maximum', { amount: '1001' }, AuthorizationAboveLocalCap],
    ['timeout', { maxTimeoutSeconds: 61 }, PaymentPolicyRejected],
  ])('rejects a challenge with the wrong %s', (_label, change, ErrorType) => {
    const challenge = testPaymentRequired();
    challenge.accepts[0] = { ...challenge.accepts[0]!, ...change } as PaymentRequirements;
    expect(() =>
      validatePaymentRequirement(
        challenge,
        testPolicy(),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'gemini-2.5-flash',
      ),
    ).toThrow(ErrorType);
  });

  it('rejects resource, model, metadata, and non-integer mismatches before signing', () => {
    expect(() =>
      validatePaymentRequirement(
        testPaymentRequired(),
        testPolicy(),
        `${TEST_ORIGIN}/v1/messages`,
        'gemini-2.5-flash',
      ),
    ).toThrow(PaymentPolicyRejected);
    expect(() =>
      validatePaymentRequirement(
        testPaymentRequired(),
        testPolicy(),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'unapproved-model',
      ),
    ).toThrow(PaymentPolicyRejected);
    const noFacilitator = testPaymentRequired();
    noFacilitator.accepts[0] = { ...noFacilitator.accepts[0]!, extra: {} };
    expect(() =>
      validatePaymentRequirement(
        noFacilitator,
        testPolicy(),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'gemini-2.5-flash',
      ),
    ).toThrow(PaymentPolicyRejected);
    const fractional = testPaymentRequired();
    fractional.accepts[0] = { ...fractional.accepts[0]!, amount: '1.5' };
    expect(() =>
      validatePaymentRequirement(
        fractional,
        testPolicy(),
        `${TEST_ORIGIN}/v1/chat/completions`,
        'gemini-2.5-flash',
      ),
    ).toThrow(PaymentPolicyRejected);
  });
});
