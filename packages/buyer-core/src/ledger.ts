import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AuthorizationAboveLocalCap,
  IdempotencyConflict,
  PaymentPolicyRejected,
} from './errors.js';
import { canonicalJson } from './canonical.js';
import { consumeHumanAuthorization, type HumanAuthorization } from './human-auth.js';
import { assertSupportedPlatform } from './filesystem.js';
import { createBuyerPolicy, isPolicyRestriction, validateEffectiveBuyerPolicy } from './policy.js';
import {
  MAX_SQLITE_INTEGER,
  type EffectiveBuyerPolicy,
  type LocalOperation,
  type LocalSpendSummary,
  type ReservationInput,
  type VerifiedReceipt,
} from './types.js';

interface OperationRow {
  idempotency_key: string;
  request_hash: string;
  requirement_hash: string;
  model: string;
  agent_id: string;
  session_id: string;
  maximum_atomic: bigint;
  actual_atomic: bigint | null;
  state: LocalOperation['state'];
  created_at: bigint;
  updated_at: bigint;
  reservation_expires_at: bigint;
  receipt_json: string | null;
  policy_hash: string;
}

interface TotalRow {
  total: bigint;
}

function atomic(value: bigint, label: string): bigint {
  if (value < 0n || value > MAX_SQLITE_INTEGER)
    throw new PaymentPolicyRejected(`${label} is outside the signed 64-bit integer range`);
  return value;
}

function asOperation(row: OperationRow): LocalOperation {
  return {
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    requirementHash: row.requirement_hash,
    model: row.model,
    agentId: row.agent_id,
    sessionId: row.session_id,
    maximumAtomic: row.maximum_atomic,
    actualAtomic: row.actual_atomic,
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reservationExpiresAt: Number(row.reservation_expires_at),
    receipt: row.receipt_json ? (JSON.parse(row.receipt_json) as VerifiedReceipt) : null,
    policyHash: row.policy_hash,
  };
}

interface StoredPolicy {
  canonicalOrigin: string;
  network: `eip155:${number}`;
  asset: `0x${string}`;
  recipients: `0x${string}`[];
  schemes: ['upto'];
  models: string[];
  limits: {
    perCallAtomic: string;
    sessionAtomic: string;
    hourAtomic: string;
    dayAtomic: string;
  };
  delegations?: Array<{ agentId: string; maximumAtomic: string; revoked?: boolean }>;
  sessionDurationMs: number;
  reservationTtlMs: number;
  maximumAuthorizationSeconds: number;
  maximumOutputTokens: number;
  requirePerCallConfirmation: boolean;
}

function serializePolicy(policy: EffectiveBuyerPolicy): string {
  return canonicalJson({
    canonicalOrigin: policy.canonicalOrigin,
    network: policy.network,
    asset: policy.asset,
    recipients: [...policy.recipients],
    schemes: ['upto'],
    models: [...policy.models],
    limits: {
      perCallAtomic: policy.limits.perCallAtomic.toString(),
      sessionAtomic: policy.limits.sessionAtomic.toString(),
      hourAtomic: policy.limits.hourAtomic.toString(),
      dayAtomic: policy.limits.dayAtomic.toString(),
    },
    ...(policy.delegations
      ? {
          delegations: policy.delegations.map((delegation) => ({
            agentId: delegation.agentId,
            maximumAtomic: delegation.maximumAtomic.toString(),
            ...(delegation.revoked === undefined ? {} : { revoked: delegation.revoked }),
          })),
        }
      : {}),
    sessionDurationMs: policy.sessionDurationMs,
    reservationTtlMs: policy.reservationTtlMs,
    maximumAuthorizationSeconds: policy.maximumAuthorizationSeconds,
    maximumOutputTokens: policy.maximumOutputTokens,
    requirePerCallConfirmation: policy.requirePerCallConfirmation,
  });
}

function deserializePolicy(json: string): EffectiveBuyerPolicy {
  try {
    const policy = JSON.parse(json) as StoredPolicy;
    return createBuyerPolicy({
      canonicalOrigin: policy.canonicalOrigin,
      network: policy.network,
      asset: policy.asset,
      recipients: policy.recipients,
      schemes: ['upto'],
      models: policy.models,
      limits: {
        perCallAtomic: BigInt(policy.limits.perCallAtomic),
        sessionAtomic: BigInt(policy.limits.sessionAtomic),
        hourAtomic: BigInt(policy.limits.hourAtomic),
        dayAtomic: BigInt(policy.limits.dayAtomic),
      },
      ...(policy.delegations
        ? {
            delegations: policy.delegations.map((delegation) => ({
              ...delegation,
              maximumAtomic: BigInt(delegation.maximumAtomic),
            })),
          }
        : {}),
      sessionDurationMs: policy.sessionDurationMs,
      reservationTtlMs: policy.reservationTtlMs,
      maximumAuthorizationSeconds: policy.maximumAuthorizationSeconds,
      maximumOutputTokens: policy.maximumOutputTokens,
      requirePerCallConfirmation: policy.requirePerCallConfirmation,
    });
  } catch (error) {
    if (error instanceof PaymentPolicyRejected) throw error;
    throw new PaymentPolicyRejected('persisted buyer policy is malformed');
  }
}

function assertDatabasePath(path: string): string {
  assertSupportedPlatform();
  const absolute = resolve(path);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new PaymentPolicyRejected('ledger directory must not traverse symbolic links');
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new PaymentPolicyRejected('ledger directory must be a real directory');
  if (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid())
    throw new PaymentPolicyRejected('ledger directory has an unexpected owner');
  if ((directoryInfo.mode & 0o077) !== 0)
    throw new PaymentPolicyRejected('ledger directory must be owner-only (0700)');
  try {
    const fileInfo = lstatSync(absolute);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new PaymentPolicyRejected('ledger must be a regular file');
    if (typeof process.getuid === 'function' && fileInfo.uid !== process.getuid())
      throw new PaymentPolicyRejected('ledger has an unexpected owner');
    if ((fileInfo.mode & 0o077) !== 0)
      throw new PaymentPolicyRejected('ledger must be owner-only (0600)');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return absolute;
}

export class LocalSpendLedger {
  private readonly database: Database.Database;

  public constructor(path: string, initialPolicy?: EffectiveBuyerPolicy) {
    const absolute = assertDatabasePath(path);
    const existed = existsSync(absolute);
    if (!existed && !initialPolicy)
      throw new PaymentPolicyRejected('buyer ledger is not initialized');
    const verifiedPolicy = initialPolicy ? validateEffectiveBuyerPolicy(initialPolicy) : undefined;
    this.database = new Database(absolute, { timeout: 5_000 });
    this.database.defaultSafeIntegers(true);
    chmodSync(absolute, 0o600);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('trusted_schema = OFF');
    if (verifiedPolicy) {
      this.migrate(verifiedPolicy);
      this.bindPolicy(verifiedPolicy);
    } else {
      const version = Number(this.database.pragma('user_version', { simple: true }));
      if (version !== 2) {
        this.database.close();
        throw new PaymentPolicyRejected('buyer ledger requires an authenticated migration');
      }
      validateEffectiveBuyerPolicy(this.currentPolicy());
    }
  }

  public close(): void {
    this.database.close();
  }

  public reserve(input: ReservationInput): LocalOperation {
    atomic(input.maximumAtomic, 'maximum authorization');
    if (input.maximumAtomic === 0n)
      throw new PaymentPolicyRejected('zero authorization is invalid');
    if (!Number.isSafeInteger(input.now) || input.now <= 0)
      throw new PaymentPolicyRejected('reservation clock is invalid');
    const transaction = this.database.transaction(() => {
      const policy = this.currentPolicy();
      if (input.maximumAtomic > policy.limits.perCallAtomic) throw new AuthorizationAboveLocalCap();
      if (!policy.models.includes(input.model))
        throw new PaymentPolicyRejected('model is outside the current policy');
      this.releaseStalePreAuthorizations(input.now);
      const existing = this.get(input.idempotencyKey);
      if (existing) {
        if (
          existing.requestHash !== input.requestHash ||
          existing.requirementHash !== input.requirementHash
        )
          throw new IdempotencyConflict();
        return existing;
      }

      const delegation = policy.delegations?.find(
        (candidate) => candidate.agentId === input.agentId,
      );
      if (policy.delegations && policy.delegations.length > 0 && !delegation)
        throw new AuthorizationAboveLocalCap('agent has no active delegation');
      if (delegation?.revoked) throw new AuthorizationAboveLocalCap('agent delegation is revoked');
      const amount = input.maximumAtomic;
      const hourBucket = BigInt(Math.floor(input.now / 3_600_000));
      const dayBucket = BigInt(Math.floor(input.now / 86_400_000));
      this.assertFits(
        this.total('hour_bucket = ?', hourBucket) + amount,
        policy.limits.hourAtomic,
        'hour',
      );
      this.assertFits(
        this.total('day_bucket = ?', dayBucket) + amount,
        policy.limits.dayAtomic,
        'day',
      );
      this.assertFits(
        this.total('session_id = ?', input.sessionId) + amount,
        policy.limits.sessionAtomic,
        'session',
      );
      if (delegation)
        this.assertFits(
          this.total('agent_id = ?', input.agentId) + amount,
          delegation.maximumAtomic,
          'delegation',
        );

      this.database
        .prepare(
          `insert into operations (
            idempotency_key, request_hash, requirement_hash, model, agent_id, session_id,
            maximum_atomic, state, hour_bucket, day_bucket, created_at, updated_at,
            reservation_expires_at, policy_hash
          ) values (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          input.requestHash,
          input.requirementHash,
          input.model,
          input.agentId,
          input.sessionId,
          amount,
          hourBucket,
          dayBucket,
          BigInt(input.now),
          BigInt(input.now),
          BigInt(input.now + policy.reservationTtlMs),
          policy.hash,
        );
      const operation = this.get(input.idempotencyKey);
      if (!operation) throw new Error('reservation_insert_failed');
      return operation;
    });
    return transaction.immediate();
  }

  public markAuthorized(
    idempotencyKey: string,
    requestHash: string,
    requirementHash: string,
    now = Date.now(),
  ): LocalOperation {
    const transaction = this.database.transaction(() => {
      const operation = this.requireMatching(idempotencyKey, requestHash, requirementHash);
      if (operation.state === 'authorized') return operation;
      if (operation.state !== 'signing')
        throw new IdempotencyConflict('reservation is not available for authorization');
      this.database
        .prepare(
          `update operations set state = 'authorized', updated_at = ? where idempotency_key = ?`,
        )
        .run(BigInt(now), idempotencyKey);
      return this.require(idempotencyKey);
    });
    return transaction.immediate();
  }

  public claimAuthorization(
    idempotencyKey: string,
    requestHash: string,
    requirementHash: string,
    now = Date.now(),
  ): LocalOperation {
    const transaction = this.database.transaction(() => {
      const operation = this.requireMatching(idempotencyKey, requestHash, requirementHash);
      if (operation.state !== 'reserved')
        throw new IdempotencyConflict('authorization was already claimed');
      this.database
        .prepare(
          `update operations set state = 'signing', updated_at = ? where idempotency_key = ?`,
        )
        .run(BigInt(now), idempotencyKey);
      return this.require(idempotencyKey);
    });
    return transaction.immediate();
  }

  public commitSpent(
    idempotencyKey: string,
    actualAtomic: bigint,
    receipt: VerifiedReceipt,
    now = Date.now(),
  ): LocalOperation {
    atomic(actualAtomic, 'actual settlement');
    const transaction = this.database.transaction(() => {
      const operation = this.require(idempotencyKey);
      if (operation.state === 'spent') {
        if (operation.actualAtomic !== actualAtomic)
          throw new IdempotencyConflict('settlement amount changed for a completed operation');
        return operation;
      }
      if (!['authorized', 'unknown'].includes(operation.state))
        throw new IdempotencyConflict('operation cannot be committed from its current state');
      if (actualAtomic > operation.maximumAtomic)
        throw new AuthorizationAboveLocalCap('settlement exceeds the signed maximum');
      this.database
        .prepare(
          `update operations set state = 'spent', actual_atomic = ?, receipt_json = ?, updated_at = ?
           where idempotency_key = ?`,
        )
        .run(actualAtomic, canonicalJson(receipt), BigInt(now), idempotencyKey);
      return this.require(idempotencyKey);
    });
    return transaction.immediate();
  }

  public markUnknown(idempotencyKey: string, now = Date.now()): LocalOperation {
    const transaction = this.database.transaction(() => {
      const operation = this.require(idempotencyKey);
      if (operation.state === 'spent' || operation.state === 'released') return operation;
      this.database
        .prepare(
          `update operations set state = 'unknown', updated_at = ? where idempotency_key = ?`,
        )
        .run(BigInt(now), idempotencyKey);
      return this.require(idempotencyKey);
    });
    return transaction.immediate();
  }

  public releaseDefiniteFailure(idempotencyKey: string, now = Date.now()): LocalOperation {
    const transaction = this.database.transaction(() => {
      const operation = this.require(idempotencyKey);
      if (operation.state === 'spent' || operation.state === 'unknown') return operation;
      this.database
        .prepare(
          `update operations set state = 'released', updated_at = ? where idempotency_key = ?`,
        )
        .run(BigInt(now), idempotencyKey);
      return this.require(idempotencyKey);
    });
    return transaction.immediate();
  }

  public get(idempotencyKey: string): LocalOperation | null {
    const row = this.database
      .prepare('select * from operations where idempotency_key = ?')
      .get(idempotencyKey) as OperationRow | undefined;
    return row ? asOperation(row) : null;
  }

  public receipt(idempotencyKey: string): LocalOperation['receipt'] {
    return this.get(idempotencyKey)?.receipt ?? null;
  }

  public spendSummary(sessionId: string, agentId: string, now = Date.now()): LocalSpendSummary {
    if (!Number.isSafeInteger(now) || now <= 0)
      throw new PaymentPolicyRejected('spend-summary clock is invalid');
    return {
      sessionAtomic: this.total('session_id = ?', sessionId),
      hourAtomic: this.total('hour_bucket = ?', BigInt(Math.floor(now / 3_600_000))),
      dayAtomic: this.total('day_bucket = ?', BigInt(Math.floor(now / 86_400_000))),
      delegationAtomic: this.currentPolicy().delegations?.some(
        (delegation) => delegation.agentId === agentId,
      )
        ? this.total('agent_id = ?', agentId)
        : null,
    };
  }

  /** Read the cross-process authoritative policy for the next authorization. */
  public currentPolicy(): EffectiveBuyerPolicy {
    const row = this.database
      .prepare(
        `select p.policy_json as policy_json from runtime_metadata m
         join policy_history p on p.policy_hash = m.value where m.key = 'policy_hash'`,
      )
      .get() as { policy_json: string } | undefined;
    if (!row) throw new PaymentPolicyRejected('persisted buyer policy is unavailable');
    return deserializePolicy(row.policy_json);
  }

  public policyForOperation(idempotencyKey: string): EffectiveBuyerPolicy {
    const row = this.database
      .prepare(
        `select p.policy_json as policy_json from operations o
         join policy_history p on p.policy_hash = o.policy_hash
         where o.idempotency_key = ?`,
      )
      .get(idempotencyKey) as { policy_json: string } | undefined;
    if (!row) throw new IdempotencyConflict('operation policy snapshot is unavailable');
    return deserializePolicy(row.policy_json);
  }

  public bindWalletAddress(address: `0x${string}`): void {
    const normalized = address.toLowerCase();
    const transaction = this.database.transaction(() => {
      const row = this.database
        .prepare("select value from runtime_metadata where key = 'wallet_address'")
        .get() as { value: string } | undefined;
      if (row && row.value !== normalized)
        throw new PaymentPolicyRejected('wallet differs from the persisted runtime binding');
      if (!row)
        this.database
          .prepare("insert into runtime_metadata (key, value) values ('wallet_address', ?)")
          .run(normalized);
    });
    transaction.immediate();
  }

  /** Agents may only narrow authority; every process observes the change on its next call. */
  public restrictPolicy(next: EffectiveBuyerPolicy, now = Date.now()): void {
    const verified = validateEffectiveBuyerPolicy(next);
    const transaction = this.database.transaction(() => {
      const current = this.currentPolicy();
      if (!isPolicyRestriction(current, verified))
        throw new PaymentPolicyRejected('policy change widens authority and requires a human');
      this.persistPolicy(verified, now);
    });
    transaction.immediate();
  }

  /** Admin-only surface: accepts a one-use proof minted after wallet passphrase verification. */
  public replacePolicy(
    next: EffectiveBuyerPolicy,
    authorization: HumanAuthorization,
    now = Date.now(),
  ): void {
    const verified = validateEffectiveBuyerPolicy(next);
    const wallet = this.database
      .prepare("select value from runtime_metadata where key = 'wallet_address'")
      .get() as { value: string } | undefined;
    if (!wallet || wallet.value !== authorization.walletAddress.toLowerCase())
      throw new PaymentPolicyRejected('human authentication is not bound to this runtime wallet');
    if (authorization.intent !== `policy:${verified.hash}`)
      throw new PaymentPolicyRejected('human authentication is not bound to this policy');
    consumeHumanAuthorization(authorization);
    const transaction = this.database.transaction(() => this.persistPolicy(verified, now));
    transaction.immediate();
  }

  public replaceWalletBinding(address: `0x${string}`, authorization: HumanAuthorization): void {
    if (authorization.walletAddress.toLowerCase() !== address.toLowerCase())
      throw new PaymentPolicyRejected('human authentication does not match the replacement wallet');
    if (authorization.intent !== `wallet:${address.toLowerCase()}`)
      throw new PaymentPolicyRejected('human authentication is not bound to wallet replacement');
    consumeHumanAuthorization(authorization);
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `insert into runtime_metadata (key, value) values ('wallet_address', ?)
           on conflict(key) do update set value = excluded.value`,
        )
        .run(address.toLowerCase());
    });
    transaction.immediate();
  }

  public releaseStalePreAuthorizations(now = Date.now()): number {
    const result = this.database
      .prepare(
        `update operations set state = 'released', updated_at = ?
         where state in ('reserved', 'signing') and reservation_expires_at <= ?`,
      )
      .run(BigInt(now), BigInt(now));
    return result.changes;
  }

  private migrate(initialPolicy: EffectiveBuyerPolicy): void {
    const version = Number(this.database.pragma('user_version', { simple: true }));
    if (version > 2) throw new PaymentPolicyRejected('ledger schema is newer than this runtime');
    if (version === 0) {
      this.database.exec(`
      create table if not exists runtime_metadata (
        key text primary key,
        value text not null
      ) strict;
      create table if not exists policy_history (
        policy_hash text primary key,
        policy_json text not null,
        created_at integer not null
      ) strict;
      create table if not exists operations (
        idempotency_key text primary key,
        request_hash text not null,
        requirement_hash text not null,
        model text not null,
        agent_id text not null,
        session_id text not null,
        maximum_atomic integer not null check(maximum_atomic > 0),
        actual_atomic integer check(actual_atomic is null or actual_atomic >= 0),
        state text not null check(state in ('reserved','signing','authorized','spent','released','unknown')),
        hour_bucket integer not null,
        day_bucket integer not null,
        created_at integer not null,
        updated_at integer not null,
        reservation_expires_at integer not null,
        receipt_json text,
        policy_hash text not null references policy_history(policy_hash),
        check(actual_atomic is null or actual_atomic <= maximum_atomic),
        check((state = 'spent' and actual_atomic is not null and receipt_json is not null)
          or state != 'spent')
      ) strict;
      create index if not exists operations_hour on operations(hour_bucket, state);
      create index if not exists operations_day on operations(day_bucket, state);
      create index if not exists operations_session on operations(session_id, state);
      create index if not exists operations_agent on operations(agent_id, state);
      pragma user_version = 2;
    `);
      return;
    }
    if (version === 1) {
      const bound = this.database
        .prepare("select value from runtime_metadata where key = 'policy_hash'")
        .get() as { value: string } | undefined;
      if (!bound || bound.value !== initialPolicy.hash)
        throw new PaymentPolicyRejected('legacy ledger policy does not match the supplied policy');
      const transaction = this.database.transaction(() => {
        this.database.exec(`
          create table if not exists policy_history (
            policy_hash text primary key,
            policy_json text not null,
            created_at integer not null
          ) strict;
        `);
        this.database
          .prepare(
            `insert into policy_history (policy_hash, policy_json, created_at) values (?, ?, ?)`,
          )
          .run(initialPolicy.hash, serializePolicy(initialPolicy), BigInt(Date.now()));
        this.database.exec(`
          alter table operations rename to operations_v1;
          create table operations (
            idempotency_key text primary key,
            request_hash text not null,
            requirement_hash text not null,
            model text not null,
            agent_id text not null,
            session_id text not null,
            maximum_atomic integer not null check(maximum_atomic > 0),
            actual_atomic integer check(actual_atomic is null or actual_atomic >= 0),
            state text not null check(state in ('reserved','signing','authorized','spent','released','unknown')),
            hour_bucket integer not null,
            day_bucket integer not null,
            created_at integer not null,
            updated_at integer not null,
            reservation_expires_at integer not null,
            receipt_json text,
            policy_hash text not null references policy_history(policy_hash),
            check(actual_atomic is null or actual_atomic <= maximum_atomic),
            check((state = 'spent' and actual_atomic is not null and receipt_json is not null)
              or state != 'spent')
          ) strict;
        `);
        this.database
          .prepare(
            `insert into operations (
              idempotency_key, request_hash, requirement_hash, model, agent_id, session_id,
              maximum_atomic, actual_atomic, state, hour_bucket, day_bucket, created_at,
              updated_at, reservation_expires_at, receipt_json, policy_hash
            ) select idempotency_key, request_hash, requirement_hash, model, agent_id, session_id,
              maximum_atomic, actual_atomic, state, hour_bucket, day_bucket, created_at,
              updated_at, reservation_expires_at, receipt_json, ? from operations_v1`,
          )
          .run(initialPolicy.hash);
        this.database.exec(`
          drop table operations_v1;
          create index operations_hour on operations(hour_bucket, state);
          create index operations_day on operations(day_bucket, state);
          create index operations_session on operations(session_id, state);
          create index operations_agent on operations(agent_id, state);
          pragma user_version = 2;
        `);
      });
      transaction.immediate();
    }
  }

  private bindPolicy(policy: EffectiveBuyerPolicy): void {
    const row = this.database
      .prepare("select value from runtime_metadata where key = 'policy_hash'")
      .get() as { value: string } | undefined;
    if (row && row.value !== policy.hash)
      throw new PaymentPolicyRejected('runtime policy differs from the persisted immutable policy');
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `insert into policy_history (policy_hash, policy_json, created_at) values (?, ?, ?)
           on conflict(policy_hash) do nothing`,
        )
        .run(policy.hash, serializePolicy(policy), BigInt(Date.now()));
      if (!row)
        this.database
          .prepare("insert into runtime_metadata (key, value) values ('policy_hash', ?)")
          .run(policy.hash);
      this.database
        .prepare('update operations set policy_hash = ? where policy_hash is null')
        .run(policy.hash);
    });
    transaction.immediate();
  }

  private persistPolicy(policy: EffectiveBuyerPolicy, now: number): void {
    if (!Number.isSafeInteger(now) || now <= 0)
      throw new PaymentPolicyRejected('policy clock is invalid');
    this.database
      .prepare(
        `insert into policy_history (policy_hash, policy_json, created_at) values (?, ?, ?)
         on conflict(policy_hash) do nothing`,
      )
      .run(policy.hash, serializePolicy(policy), BigInt(now));
    this.database
      .prepare("update runtime_metadata set value = ? where key = 'policy_hash'")
      .run(policy.hash);
  }

  private require(idempotencyKey: string): LocalOperation {
    const operation = this.get(idempotencyKey);
    if (!operation) throw new IdempotencyConflict('local operation does not exist');
    return operation;
  }

  private requireMatching(
    idempotencyKey: string,
    requestHash: string,
    requirementHash: string,
  ): LocalOperation {
    const operation = this.require(idempotencyKey);
    if (operation.requestHash !== requestHash || operation.requirementHash !== requirementHash)
      throw new IdempotencyConflict();
    return operation;
  }

  private total(predicate: string, value: string | bigint): bigint {
    const row = this.database
      .prepare(
        `select coalesce(sum(case when state = 'spent' then actual_atomic else maximum_atomic end), 0)
          as total from operations where state in ('reserved','signing','authorized','spent','unknown')
          and ${predicate}`,
      )
      .get(value) as TotalRow;
    return row.total;
  }

  private assertFits(total: bigint, cap: bigint, scope: string): void {
    if (total > cap) throw new AuthorizationAboveLocalCap(`${scope} budget exceeded`);
  }
}
