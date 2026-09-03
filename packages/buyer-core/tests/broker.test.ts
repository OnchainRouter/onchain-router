import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { PERMIT2_ADDRESS } from '@x402/evm';
import {
  SignerBroker,
  SignerBrokerClient,
  type Permit2Operations,
  type SignerBrokerSession,
} from '../src/broker.js';
import { BuyerRuntimeError } from '../src/errors.js';
import { LocalSpendLedger } from '../src/ledger.js';
import { createBoundedPermit2ApprovalTx } from '../src/permit2.js';
import { createBuyerPolicy, validatePaymentRequirement } from '../src/policy.js';
import { WalletVault } from '../src/vault.js';
import {
  TEST_ASSET,
  TEST_ORIGIN,
  testExactPaymentRequired,
  testExactPolicy,
  testPaymentRequired,
  testPolicy,
} from './helpers.js';

const directories: string[] = [];
const PASSPHRASE = 'correct horse battery staple';

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-broker-'));
  await chmod(path, 0o700);
  directories.push(path);
  return path;
}

async function rawCall(session: SignerBrokerSession, value: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(session.socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', (chunk: string) => (output += chunk));
    socket.once('end', () => {
      try {
        resolve(JSON.parse(output.trim()) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('broker response parse failed'));
      }
    });
    socket.once('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe('short-lived signer broker', () => {
  it('builds a bounded approval only for canonical Permit2', () => {
    const transaction = createBoundedPermit2ApprovalTx(TEST_ASSET, 5_000n);
    expect(transaction.to).toBe(TEST_ASSET);
    expect(
      decodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'approve',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ] as const,
        data: transaction.data,
      }),
    ).toMatchObject({ functionName: 'approve', args: [PERMIT2_ADDRESS, 5_000n] });
    expect(() => createBoundedPermit2ApprovalTx(TEST_ASSET, 0n)).toThrow(
      'Permit2 approval amount must be positive',
    );
  });

  async function setup(
    now: () => number = Date.now,
    permit2Operations: Permit2Operations = {
      allowance: vi.fn().mockResolvedValue(2n ** 256n - 1n),
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve: vi.fn().mockResolvedValue({
        transactionHash: `0x${'1'.repeat(64)}`,
        status: 'success',
      }),
    },
    policy = testPolicy(),
  ) {
    const root = await directory();
    const ledger = new LocalSpendLedger(join(root, 'ledger', 'buyer.sqlite'), policy);
    const vault = new WalletVault({
      directory: join(root, 'wallet'),
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    await vault.create(PASSPHRASE);
    const broker = new SignerBroker({
      socketPath: join(root, 'ipc', 'signer.sock'),
      vault,
      ledger,
      policy,
      agentId: 'test-agent',
      idleTimeoutMs: 2_000,
      absoluteTimeoutMs: 10_000,
      now,
      testPermit2Operations: permit2Operations,
    });
    const session = await broker.start(PASSPHRASE);
    return {
      root,
      policy,
      ledger,
      vault,
      broker,
      session,
      client: new SignerBrokerClient(session),
    };
  }

  function authorization(
    session: SignerBrokerSession,
    paymentRequired = testPaymentRequired(),
    idempotencyKey = 'broker-payment',
    policy = testPolicy(),
  ) {
    const validated = validatePaymentRequirement(
      paymentRequired,
      policy,
      `${TEST_ORIGIN}/v1/chat/completions`,
      'gemini-2.5-flash',
    );
    return {
      paymentRequired,
      requestUrl: `${TEST_ORIGIN}/v1/chat/completions`,
      model: 'gemini-2.5-flash',
      idempotencyKey,
      requestHash: 'request-hash',
      requirementHash: validated.requirementHash,
      agentId: session.agentId,
      sessionId: session.sessionId,
      maximumAtomic: validated.amountAtomic,
    };
  }

  async function captureBuyerError(promise: Promise<unknown>): Promise<BuyerRuntimeError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof BuyerRuntimeError) return error;
      throw error;
    }
    throw new Error('expected_buyer_runtime_error');
  }

  it('creates only the official policy-bound upto payload and authorizes durably before return', async () => {
    const context = await setup();
    try {
      const request = authorization(context.session);
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });
      const payload = await context.client.authorize(request);
      expect(payload.x402Version).toBe(2);
      expect(payload.accepted.scheme).toBe('upto');
      expect(payload.payload['signature']).toMatch(/^0x[0-9a-f]+$/i);
      expect(typeof payload.payload['permit2Authorization']).toBe('object');
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('authorized');
      await expect(context.client.authorize(request)).rejects.toMatchObject({
        code: 'IdempotencyConflict',
      });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('creates an official exact EIP-3009 payload without a Permit2 allowance or gas check', async () => {
    const allowance = vi.fn<Permit2Operations['allowance']>();
    const nativeBalance = vi.fn<Permit2Operations['nativeBalance']>();
    const approve = vi.fn<Permit2Operations['approve']>();
    const permit2Operations: Permit2Operations = {
      allowance,
      nativeBalance,
      approve,
    };
    const policy = testExactPolicy();
    const context = await setup(Date.now, permit2Operations, policy);
    try {
      const request = authorization(
        context.session,
        testExactPaymentRequired(),
        'broker-exact-payment',
        policy,
      );
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });
      const payload = await context.client.authorize(request);
      expect(payload.x402Version).toBe(2);
      expect(payload.accepted.scheme).toBe('exact');
      expect(payload.payload['signature']).toMatch(/^0x[0-9a-f]+$/i);
      expect(payload.payload['authorization']).toMatchObject({
        to: request.paymentRequired.accepts[0]?.payTo,
        value: request.maximumAtomic.toString(),
      });
      expect(payload.payload).not.toHaveProperty('permit2Authorization');
      expect(allowance).not.toHaveBeenCalled();
      expect(nativeBalance).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('authorized');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('rejects a paid authorization before signing when Permit2 allowance is insufficient', async () => {
    const allowance = vi.fn().mockResolvedValue(0n);
    const approve = vi.fn();
    const permit2Operations: Permit2Operations = {
      allowance,
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve,
    };
    const context = await setup(Date.now, permit2Operations);
    try {
      const request = authorization(
        context.session,
        testPaymentRequired('600'),
        'first-use-wallet',
      );
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });

      const error = await captureBuyerError(context.client.authorize(request));
      expect(error.code).toBe('Permit2ApprovalRequired');
      expect(error.retry).toBe('do_not_retry');
      expect(error.message).toContain('onchain-router permit2 approve');
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('released');
      expect(allowance).toHaveBeenCalledWith(context.session.address, TEST_ASSET);
      expect(approve).not.toHaveBeenCalled();
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('approves only the policy asset for the policy-bounded daily amount', async () => {
    const allowance = vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(5_000n);
    const approve = vi.fn().mockResolvedValue({
      transactionHash: `0x${'2'.repeat(64)}`,
      status: 'success',
    });
    const context = await setup(Date.now, {
      allowance,
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve,
    });
    try {
      await expect(context.client.approvePermit2()).resolves.toMatchObject({
        object: 'permit2_approval',
        outcome: 'approved',
        asset: TEST_ASSET,
        allowanceAtomic: '5000',
        requiredAtomic: '5000',
        approved: true,
      });
      expect(approve).toHaveBeenCalledOnce();
      expect(approve).toHaveBeenCalledWith(TEST_ASSET, 5_000n);
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('requires Base ETH before attempting the bounded Permit2 approval', async () => {
    const approve = vi.fn();
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValue(0n),
      nativeBalance: vi.fn().mockResolvedValue(0n),
      approve,
    });
    try {
      const error = await captureBuyerError(context.client.approvePermit2());
      expect(error.code).toBe('InsufficientFunds');
      expect(error.message).toContain('Base ETH');
      expect(approve).not.toHaveBeenCalled();
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('does not broadcast another approval when the policy amount is already allowed', async () => {
    const approve = vi.fn();
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValue(5_000n),
      nativeBalance: vi.fn().mockResolvedValue(0n),
      approve,
    });
    try {
      await expect(context.client.approvePermit2()).resolves.toMatchObject({
        outcome: 'already_approved',
        approved: true,
      });
      expect(approve).not.toHaveBeenCalled();
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('fails closed when the approval transaction reverts', async () => {
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValue(0n),
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve: vi.fn().mockResolvedValue({
        transactionHash: `0x${'4'.repeat(64)}`,
        status: 'reverted',
      }),
    });
    try {
      await expect(context.client.approvePermit2()).rejects.toMatchObject({
        code: 'Permit2ApprovalRequired',
        reference: `0x${'4'.repeat(64)}`,
      });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('requires human review when the mined approval is not visible in the fresh allowance read', async () => {
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValue(0n),
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve: vi.fn().mockResolvedValue({
        transactionHash: `0x${'5'.repeat(64)}`,
        status: 'success',
      }),
    });
    try {
      await expect(context.client.approvePermit2()).rejects.toMatchObject({
        code: 'Permit2ApprovalOutcomeUnknown',
        retry: 'human_review',
        reference: `0x${'5'.repeat(64)}`,
      });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('requires human review when the post-confirmation allowance read fails', async () => {
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValueOnce(0n).mockRejectedValueOnce(new Error('rpc down')),
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve: vi.fn().mockResolvedValue({
        transactionHash: `0x${'6'.repeat(64)}`,
        status: 'success',
      }),
    });
    try {
      await expect(context.client.approvePermit2()).rejects.toMatchObject({
        code: 'Permit2ApprovalOutcomeUnknown',
        retry: 'human_review',
        reference: `0x${'6'.repeat(64)}`,
      });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('requires human review when approval broadcast or receipt status is unknown', async () => {
    const context = await setup(Date.now, {
      allowance: vi.fn().mockResolvedValue(0n),
      nativeBalance: vi.fn().mockResolvedValue(1n),
      approve: vi.fn().mockRejectedValue(new Error('transport unavailable')),
    });
    try {
      const error = await captureBuyerError(context.client.approvePermit2());
      expect(error.code).toBe('Permit2ApprovalOutcomeUnknown');
      expect(error.retry).toBe('human_review');
      expect(error.message).toContain('permit2 status');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('rejects arbitrary signing actions, invalid capabilities, and broker-identity substitution', async () => {
    const context = await setup();
    try {
      const generic = await rawCall(context.session, {
        id: 'generic',
        capability: context.session.capability,
        action: 'signTypedData',
        payload: { message: 'never sign this' },
      });
      expect(generic).toMatchObject({ ok: false, error: { code: 'WalletLocked' } });
      const copied = await rawCall(context.session, {
        id: 'copied',
        capability: 'not-the-capability',
        action: 'status',
      });
      expect(copied).toMatchObject({ ok: false, error: { code: 'WalletLocked' } });

      const request = authorization(context.session);
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });
      await expect(
        context.client.authorize({ ...request, agentId: 'different-agent' }),
      ).rejects.toBeInstanceOf(BuyerRuntimeError);
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('reserved');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('observes an immediate cross-process policy reduction before signing', async () => {
    const context = await setup();
    try {
      const request = authorization(context.session);
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });
      context.ledger.restrictPolicy(
        createBuyerPolicy({
          ...context.policy,
          limits: {
            perCallAtomic: 500n,
            sessionAtomic: 1_000n,
            hourAtomic: 1_000n,
            dayAtomic: 2_000n,
          },
          delegations: [{ agentId: 'test-agent', maximumAtomic: 1_000n }],
        }),
      );
      await expect(context.client.authorize(request)).rejects.toMatchObject({
        code: 'AuthorizationAboveLocalCap',
      });
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('reserved');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('does not let a running capability inherit a freshly widened human policy', async () => {
    const context = await setup();
    try {
      const request = authorization(context.session);
      context.ledger.reserve({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        requirementHash: request.requirementHash,
        model: request.model,
        agentId: request.agentId,
        sessionId: request.sessionId,
        maximumAtomic: request.maximumAtomic,
        now: Date.now(),
      });
      const wider = createBuyerPolicy({
        ...context.policy,
        limits: {
          perCallAtomic: 1_500n,
          sessionAtomic: 3_000n,
          hourAtomic: 3_000n,
          dayAtomic: 6_000n,
        },
        delegations: [{ agentId: 'test-agent', maximumAtomic: 3_000n }],
      });
      context.ledger.replacePolicy(
        wider,
        await context.vault.authenticatePolicyChange(wider.hash, PASSPHRASE),
      );
      await expect(context.client.authorize(request)).rejects.toMatchObject({
        code: 'PaymentPolicyRejected',
      });
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('reserved');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('keeps an observed policy reduction pinned for the rest of the broker session', async () => {
    const context = await setup();
    try {
      const reduced = createBuyerPolicy({
        ...context.policy,
        maximumOutputTokens: context.policy.maximumOutputTokens - 1,
      });
      context.ledger.restrictPolicy(reduced);
      const firstChallenge = testPaymentRequired();
      firstChallenge.accepts[0] = { ...firstChallenge.accepts[0]!, amount: '400' };
      const first = authorization(context.session, firstChallenge, 'reduced-policy');
      context.ledger.reserve({
        idempotencyKey: first.idempotencyKey,
        requestHash: first.requestHash,
        requirementHash: first.requirementHash,
        model: first.model,
        agentId: first.agentId,
        sessionId: first.sessionId,
        maximumAtomic: first.maximumAtomic,
        now: Date.now(),
      });
      await expect(context.client.authorize(first)).resolves.toMatchObject({ x402Version: 2 });

      context.ledger.replacePolicy(
        context.policy,
        await context.vault.authenticatePolicyChange(context.policy.hash, PASSPHRASE),
      );
      const secondChallenge = testPaymentRequired();
      secondChallenge.accepts[0] = { ...secondChallenge.accepts[0]!, amount: '400' };
      const second = authorization(context.session, secondChallenge, 're-expanded-policy');
      context.ledger.reserve({
        idempotencyKey: second.idempotencyKey,
        requestHash: second.requestHash,
        requirementHash: second.requirementHash,
        model: second.model,
        agentId: second.agentId,
        sessionId: second.sessionId,
        maximumAtomic: second.maximumAtomic,
        now: Date.now(),
      });
      await expect(context.client.authorize(second)).rejects.toMatchObject({
        code: 'PaymentPolicyRejected',
      });
      expect(context.ledger.get(second.idempotencyKey)?.state).toBe('reserved');
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('fails closed on idle/absolute expiry and manual lock', async () => {
    let clock = 10_000;
    const context = await setup(() => clock);
    try {
      expect(await context.client.status()).toMatchObject({ address: context.session.address });
      clock = 12_001;
      await expect(context.client.status()).rejects.toMatchObject({ code: 'WalletLocked' });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }

    const manual = await setup();
    try {
      await manual.client.lock();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(manual.client.status()).rejects.toMatchObject({ code: 'WalletLocked' });
    } finally {
      await manual.broker.stop();
      manual.ledger.close();
    }
  });
});
