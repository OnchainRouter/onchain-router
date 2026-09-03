import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SignerBroker, SignerBrokerClient, type SignerBrokerSession } from '../src/broker.js';
import { BuyerRuntimeError } from '../src/errors.js';
import { LocalSpendLedger } from '../src/ledger.js';
import { createBuyerPolicy, validatePaymentRequirement } from '../src/policy.js';
import { WalletVault } from '../src/vault.js';
import { TEST_ORIGIN, testPaymentRequired, testPolicy } from './helpers.js';

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
  async function setup(now: () => number = Date.now, policy = testPolicy()) {
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

  it('creates only the official exact EIP-3009 payload and authorizes durably before return', async () => {
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
      expect(payload.accepted.scheme).toBe('exact');
      expect(payload.payload['signature']).toMatch(/^0x[0-9a-f]+$/i);
      expect(payload.payload['authorization']).toMatchObject({
        to: request.paymentRequired.accepts[0]?.payTo,
        value: request.maximumAtomic.toString(),
      });
      expect(context.ledger.get(request.idempotencyKey)?.state).toBe('authorized');
      await expect(context.client.authorize(request)).rejects.toMatchObject({
        code: 'IdempotencyConflict',
      });
    } finally {
      await context.broker.stop();
      context.ledger.close();
    }
  });

  it('refuses to unlock or spend from a legacy upto profile until a human migrates it', async () => {
    const root = await directory();
    const policy = testPolicy({ schemes: ['upto'] });
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
    });
    await expect(broker.start(PASSPHRASE)).rejects.toThrow(
      'legacy upto profiles cannot unlock or spend; run onchain-router policy set --scheme exact',
    );
    ledger.close();
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
