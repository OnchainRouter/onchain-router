import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationAboveLocalCap,
  IdempotencyConflict,
  PaymentPolicyRejected,
} from '../src/errors.js';
import { LocalSpendLedger } from '../src/ledger.js';
import { createBuyerPolicy } from '../src/policy.js';
import type { VerifiedReceipt } from '../src/types.js';
import { WalletVault } from '../src/vault.js';
import { testPolicy } from './helpers.js';
import Database from 'better-sqlite3';

const directories: string[] = [];

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-ledger-'));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

function reservation(key: string, maximumAtomic = 600n, now = 1_000) {
  return {
    idempotencyKey: key,
    requestHash: `request-${key}`,
    requirementHash: `requirement-${key}`,
    model: 'gemini-2.5-flash',
    agentId: 'test-agent',
    sessionId: 'session-1',
    maximumAtomic,
    now,
  };
}

function receipt(id: string, actual: bigint, maximum: bigint): VerifiedReceipt {
  return {
    id,
    operationId: id,
    catalogVersion: 'test',
    model: 'gemini-2.5-flash',
    usage: {},
    settlement: {
      success: true,
      transaction: '0xsettled',
      network: 'eip155:8453',
      payer: '0x4444444444444444444444444444444444444444',
    },
    maximumAmount: maximum.toString(),
    actualAmount: actual.toString(),
  };
}

async function runWorker(
  databasePath: string,
  key: string,
  mode: 'reserved' | 'signing' | 'authorized' | 'unknown',
  startAt: number,
  operationNow: number,
): Promise<number> {
  const fixture = fileURLToPath(new URL('./fixtures/ledger-worker.ts', import.meta.url));
  return await new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, databasePath, key, mode, String(startAt), String(operationNow)],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('transactional spend ledger', () => {
  it('reopens an initialized ledger without a duplicated policy configuration', async () => {
    const directory = await stateDirectory();
    const path = join(directory, 'ledger.sqlite');
    const initialized = new LocalSpendLedger(path, testPolicy());
    initialized.reserve(reservation('reopen', 600n, 1_000));
    initialized.claimAuthorization('reopen', 'request-reopen', 'requirement-reopen', 1_100);
    initialized.markAuthorized('reopen', 'request-reopen', 'requirement-reopen', 1_200);
    initialized.commitSpent('reopen', 400n, receipt('receipt-reopen', 400n, 600n), 1_300);
    initialized.close();

    const reopened = new LocalSpendLedger(path);
    try {
      expect(reopened.currentPolicy()).toEqual(testPolicy());
      expect(reopened.receipt('reopen')?.id).toBe('receipt-reopen');
      expect(reopened.spendSummary('session-1', 'test-agent', 1_500)).toEqual({
        sessionAtomic: 400n,
        hourAtomic: 400n,
        dayAtomic: 400n,
        delegationAtomic: 400n,
      });
    } finally {
      reopened.close();
    }
  });

  it('does not create an unconfigured ledger while opening a profile', async () => {
    const directory = await stateDirectory();
    expect(() => new LocalSpendLedger(join(directory, 'missing.sqlite'))).toThrow(
      PaymentPolicyRejected,
    );
  });

  it('migrates a version-one ledger transactionally and preserves operations', async () => {
    const directory = await stateDirectory();
    const path = join(directory, 'ledger.sqlite');
    const policy = testPolicy();
    const legacy = new Database(path);
    legacy.exec(`
      create table runtime_metadata (key text primary key, value text not null) strict;
      create table operations (
        idempotency_key text primary key,
        request_hash text not null,
        requirement_hash text not null,
        model text not null,
        agent_id text not null,
        session_id text not null,
        maximum_atomic integer not null check(maximum_atomic > 0),
        actual_atomic integer check(actual_atomic is null or actual_atomic >= 0),
        state text not null check(state in ('reserved','authorized','spent','released','unknown')),
        hour_bucket integer not null,
        day_bucket integer not null,
        created_at integer not null,
        updated_at integer not null,
        reservation_expires_at integer not null,
        receipt_json text
      ) strict;
      create index operations_hour on operations(hour_bucket, state);
      create index operations_day on operations(day_bucket, state);
      create index operations_session on operations(session_id, state);
      create index operations_agent on operations(agent_id, state);
      pragma user_version = 1;
    `);
    legacy
      .prepare("insert into runtime_metadata (key, value) values ('policy_hash', ?)")
      .run(policy.hash);
    legacy
      .prepare(
        `insert into operations values (?, ?, ?, ?, ?, ?, ?, null, 'reserved', ?, ?, ?, ?, ?, null)`,
      )
      .run(
        'legacy-operation',
        'legacy-request',
        'legacy-requirement',
        'gemini-2.5-flash',
        'test-agent',
        'legacy-session',
        100,
        0,
        0,
        1_000,
        1_000,
        2_000,
      );
    legacy.close();
    await chmod(path, 0o600);

    const ledger = new LocalSpendLedger(path, policy);
    try {
      expect(ledger.get('legacy-operation')).toMatchObject({
        state: 'reserved',
        policyHash: policy.hash,
      });
      expect(
        ledger.claimAuthorization('legacy-operation', 'legacy-request', 'legacy-requirement', 1_100)
          .state,
      ).toBe('signing');
    } finally {
      ledger.close();
    }
  });

  it('prevents overspend across racing operating-system processes', async () => {
    const directory = await stateDirectory();
    const path = join(directory, 'ledger.sqlite');
    const initialized = new LocalSpendLedger(path, testPolicy());
    initialized.close();
    const startAt = Date.now() + 500;
    const operationNow = Date.now();
    const exits = await Promise.all([
      runWorker(path, 'process-left', 'reserved', startAt, operationNow),
      runWorker(path, 'process-right', 'reserved', startAt, operationNow),
    ]);
    expect(exits.sort()).toEqual([0, 2]);
    const ledger = new LocalSpendLedger(path, testPolicy());
    try {
      const retained = ['process-left', 'process-right'].filter(
        (key) => ledger.get(key)?.state === 'reserved',
      );
      expect(retained).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it('recovers safely after abrupt exits at signing, authorized, and unknown boundaries', async () => {
    for (const mode of ['signing', 'authorized', 'unknown'] as const) {
      const directory = await stateDirectory();
      const path = join(directory, 'ledger.sqlite');
      const operationNow = Date.now() - 2_000;
      expect(await runWorker(path, `crash-${mode}`, mode, Date.now(), operationNow)).toBe(0);
      const ledger = new LocalSpendLedger(path, testPolicy());
      try {
        const released = ledger.releaseStalePreAuthorizations(Date.now());
        if (mode === 'signing') {
          expect(released).toBe(1);
          expect(ledger.get(`crash-${mode}`)?.state).toBe('released');
        } else {
          expect(released).toBe(0);
          expect(ledger.get(`crash-${mode}`)?.state).toBe(mode);
        }
      } finally {
        ledger.close();
      }
    }
  });

  it('serializes separate connections and cannot overspend an hour budget', async () => {
    const directory = await stateDirectory();
    const policy = createBuyerPolicy({
      ...testPolicy(),
      limits: {
        perCallAtomic: 1_000n,
        sessionAtomic: 2_000n,
        hourAtomic: 1_000n,
        dayAtomic: 2_000n,
      },
    });
    const path = join(directory, 'ledger.sqlite');
    const left = new LocalSpendLedger(path, policy);
    const right = new LocalSpendLedger(path, policy);
    try {
      expect(left.reserve(reservation('left')).state).toBe('reserved');
      expect(() => right.reserve(reservation('right'))).toThrow(AuthorizationAboveLocalCap);
    } finally {
      left.close();
      right.close();
    }
  });

  it('preserves the aggregate cap across a deterministic property sequence', async () => {
    const directory = await stateDirectory();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), testPolicy());
    let seed = 0x402;
    let accepted = 0n;
    try {
      for (let index = 0; index < 128; index += 1) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        const amount = BigInt((seed % 97) + 1);
        if (accepted + amount <= 1_000n) {
          ledger.reserve(reservation(`property-${index}`, amount));
          accepted += amount;
        } else {
          expect(() => ledger.reserve(reservation(`property-${index}`, amount))).toThrow(
            AuthorizationAboveLocalCap,
          );
        }
        expect(accepted).toBeLessThanOrEqual(1_000n);
      }
    } finally {
      ledger.close();
    }
  });

  it('binds idempotency to identical request and challenge hashes', async () => {
    const directory = await stateDirectory();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), testPolicy());
    try {
      const first = ledger.reserve(reservation('same'));
      expect(ledger.reserve(reservation('same'))).toEqual(first);
      expect(() => ledger.reserve({ ...reservation('same'), requestHash: 'changed' })).toThrow(
        IdempotencyConflict,
      );
    } finally {
      ledger.close();
    }
  });

  it('releases only stale pre-signature states and retains ambiguous authorization', async () => {
    const directory = await stateDirectory();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), testPolicy());
    try {
      const reserved = reservation('stale', 600n, 1_000);
      ledger.reserve(reserved);
      ledger.claimAuthorization(
        reserved.idempotencyKey,
        reserved.requestHash,
        reserved.requirementHash,
        1_100,
      );
      expect(ledger.releaseStalePreAuthorizations(2_001)).toBe(1);
      expect(ledger.get('stale')?.state).toBe('released');

      const authorized = reservation('authorized', 600n, 3_000);
      ledger.reserve(authorized);
      ledger.claimAuthorization(
        authorized.idempotencyKey,
        authorized.requestHash,
        authorized.requirementHash,
        3_100,
      );
      ledger.markAuthorized(
        authorized.idempotencyKey,
        authorized.requestHash,
        authorized.requirementHash,
        3_200,
      );
      expect(ledger.releaseStalePreAuthorizations(5_000)).toBe(0);
      expect(ledger.get('authorized')?.state).toBe('authorized');
    } finally {
      ledger.close();
    }
  });

  it('commits actual integer spend, never above the signed maximum', async () => {
    const directory = await stateDirectory();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), testPolicy());
    try {
      const input = reservation('spent');
      ledger.reserve(input);
      ledger.claimAuthorization(input.idempotencyKey, input.requestHash, input.requirementHash);
      ledger.markAuthorized(input.idempotencyKey, input.requestHash, input.requirementHash);
      const committed = ledger.commitSpent('spent', 100n, receipt('spent', 100n, 600n));
      expect(committed.actualAtomic).toBe(100n);
      expect(() => ledger.commitSpent('spent', 601n, receipt('spent', 601n, 600n))).toThrow(
        IdempotencyConflict,
      );
      const unsigned = reservation('unsigned');
      ledger.reserve(unsigned);
      expect(() => ledger.commitSpent('unsigned', 100n, receipt('unsigned', 100n, 600n))).toThrow(
        IdempotencyConflict,
      );
    } finally {
      ledger.close();
    }
  });

  it('enforces delegation presence and immediate revocation', async () => {
    const directory = await stateDirectory();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), testPolicy());
    try {
      expect(() =>
        ledger.reserve({ ...reservation('unknown-agent'), agentId: 'other-agent' }),
      ).toThrow(AuthorizationAboveLocalCap);
      const revoked = createBuyerPolicy({
        ...testPolicy(),
        delegations: [{ agentId: 'test-agent', maximumAtomic: 2_000n, revoked: true }],
      });
      ledger.restrictPolicy(revoked);
      expect(() => ledger.reserve(reservation('revoked'))).toThrow(AuthorizationAboveLocalCap);
    } finally {
      ledger.close();
    }
  });

  it('allows narrowing without authentication but consumes fresh wallet authentication to widen', async () => {
    const directory = await stateDirectory();
    const original = testPolicy();
    const ledger = new LocalSpendLedger(join(directory, 'ledger.sqlite'), original);
    const vault = new WalletVault({
      directory: join(directory, 'wallet'),
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    const passphrase = 'correct horse battery staple';
    try {
      await vault.create(passphrase);
      const address = await vault.verifyPassphrase(passphrase);
      ledger.bindWalletAddress(address);
      expect(() =>
        ledger.restrictPolicy({
          ...original,
          maximumOutputTokens: original.maximumOutputTokens - 1,
          hash: original.hash,
        }),
      ).toThrow(PaymentPolicyRejected);
      const restricted = createBuyerPolicy({
        ...original,
        limits: {
          perCallAtomic: 500n,
          sessionAtomic: 1_000n,
          hourAtomic: 1_000n,
          dayAtomic: 2_000n,
        },
        delegations: [{ agentId: 'test-agent', maximumAtomic: 1_000n }],
      });
      ledger.restrictPolicy(restricted);
      expect(ledger.currentPolicy().limits.perCallAtomic).toBe(500n);
      expect(() => ledger.restrictPolicy(original)).toThrow(PaymentPolicyRejected);

      const human = await vault.authenticatePolicyChange(original.hash, passphrase);
      ledger.replacePolicy(original, human);
      expect(ledger.currentPolicy().hash).toBe(original.hash);
      expect(() => ledger.replacePolicy(restricted, human)).toThrow();
    } finally {
      ledger.close();
    }
  });
});
