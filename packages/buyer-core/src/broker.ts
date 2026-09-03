import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import {
  asBuyerRuntimeError,
  BuyerRuntimeError,
  PaymentPolicyRejected,
  type BuyerOutcomeCode,
  type RetryDirective,
  WalletLocked,
} from './errors.js';
import { ensurePrivateDirectory, pathExists } from './filesystem.js';
import type { LocalSpendLedger } from './ledger.js';
import {
  isPolicyRestriction,
  validateEffectiveBuyerPolicy,
  validatePaymentRequirement,
} from './policy.js';
import type {
  BrokerAuthorizationRequest,
  EffectiveBuyerPolicy,
  PaymentAuthorizer,
} from './types.js';
import { unlockWalletForBroker } from './vault.js';
import type { WalletVault } from './vault.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
interface BrokerRequest {
  readonly id: string;
  readonly capability: string;
  readonly action: 'status' | 'authorize' | 'lock';
  readonly payload?: unknown;
}

type BrokerResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly code: BuyerOutcomeCode;
        readonly retry: RetryDirective;
        readonly message: string;
        readonly reference?: string;
      };
    };

export interface SignerBrokerOptions {
  readonly socketPath: string;
  readonly vault: WalletVault;
  readonly ledger: LocalSpendLedger;
  /** Human-reviewed immutable maximum for this unlock session. */
  readonly policy: EffectiveBuyerPolicy;
  readonly agentId: string;
  readonly idleTimeoutMs?: number;
  readonly absoluteTimeoutMs?: number;
  readonly now?: () => number;
}

export interface SignerBrokerSession {
  readonly address: `0x${string}`;
  readonly agentId: string;
  readonly sessionId: string;
  readonly socketPath: string;
  readonly capability: string;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

function capabilityHash(value: string): Buffer {
  return createHash('sha256').update('onchain-router:signer-session:v1:').update(value).digest();
}

function safeCapabilityEqual(left: Buffer, presented: string): boolean {
  const right = capabilityHash(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeLine(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )}\n`;
}

function parseAuthorization(value: unknown): BrokerAuthorizationRequest {
  if (typeof value !== 'object' || value === null)
    throw new WalletLocked('authorization payload is invalid');
  const candidate = value as Partial<BrokerAuthorizationRequest>;
  if (
    typeof candidate.paymentRequired !== 'object' ||
    candidate.paymentRequired === null ||
    typeof candidate.requestUrl !== 'string' ||
    typeof candidate.model !== 'string' ||
    typeof candidate.idempotencyKey !== 'string' ||
    typeof candidate.requestHash !== 'string' ||
    typeof candidate.requirementHash !== 'string' ||
    typeof candidate.agentId !== 'string' ||
    typeof candidate.sessionId !== 'string'
  )
    throw new WalletLocked('authorization payload is invalid');
  return candidate as BrokerAuthorizationRequest;
}

function parseBrokerRequest(value: unknown): BrokerRequest {
  if (typeof value !== 'object' || value === null) throw new WalletLocked('invalid broker request');
  const candidate = value as Partial<BrokerRequest>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.capability !== 'string' ||
    !['status', 'authorize', 'lock'].includes(candidate.action ?? '')
  )
    throw new WalletLocked('invalid broker request');
  return candidate as BrokerRequest;
}

export class SignerBroker {
  private server: Server | null = null;
  private capabilityDigest: Buffer | null = null;
  private address: `0x${string}` | null = null;
  private schemeClient: x402Client | null = null;
  private idleExpiresAt = 0;
  private absoluteExpiresAt = 0;
  private expiryTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly sockets = new Set<Socket>();
  private sessionId: string | null = null;
  private sessionPolicy: EffectiveBuyerPolicy | null = null;

  public constructor(private readonly options: SignerBrokerOptions) {
    this.now = options.now ?? Date.now;
  }

  public async start(passphrase: string): Promise<SignerBrokerSession> {
    if (this.server) throw new WalletLocked('signer broker is already running');
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 5 * 60_000;
    const absoluteTimeoutMs = this.options.absoluteTimeoutMs ?? 30 * 60_000;
    const policy = this.options.ledger.currentPolicy();
    const reviewedPolicy = validateEffectiveBuyerPolicy(this.options.policy);
    if (reviewedPolicy.hash !== policy.hash)
      throw new WalletLocked('persisted policy differs from the human-reviewed broker envelope');
    if (policy.schemes[0] !== 'exact')
      throw new PaymentPolicyRejected(
        'legacy upto profiles cannot unlock or spend; run onchain-router policy set --scheme exact',
      );
    if (
      idleTimeoutMs < 1_000 ||
      absoluteTimeoutMs < idleTimeoutMs ||
      absoluteTimeoutMs > policy.sessionDurationMs
    )
      throw new WalletLocked('signer broker expiry configuration is invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(this.options.agentId))
      throw new WalletLocked('signer broker agent identity is invalid');
    const socketPath = resolve(this.options.socketPath);
    await ensurePrivateDirectory(dirname(socketPath));
    await this.removeStaleSocket(socketPath);
    const wallet = await unlockWalletForBroker(this.options.vault, passphrase);
    const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
    this.options.ledger.bindWalletAddress(account.address);
    const signer = toClientEvmSigner(account);
    this.schemeClient = new x402Client().register(policy.network, new ExactEvmScheme(signer));
    this.sessionPolicy = policy;
    this.address = account.address;
    const capability = randomBytes(32).toString('base64url');
    this.capabilityDigest = capabilityHash(capability);
    this.sessionId = randomUUID();
    const now = this.now();
    this.idleExpiresAt = now + idleTimeoutMs;
    this.absoluteExpiresAt = now + absoluteTimeoutMs;
    this.server = createServer((socket) => this.handleSocket(socket));
    try {
      await new Promise<void>((resolveListen, reject) => {
        this.server?.once('error', reject);
        this.server?.listen(socketPath, () => {
          this.server?.off('error', reject);
          resolveListen();
        });
      });
      this.server.on('error', () => void this.stop());
      await chmod(socketPath, 0o600);
    } catch (error) {
      await this.stop();
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new WalletLocked(`signer broker could not start${detail}`);
    }
    this.expiryTimer = setInterval(
      () => {
        if (this.isExpired()) void this.stop();
      },
      Math.min(1_000, Math.max(250, Math.floor(idleTimeoutMs / 2))),
    );
    this.expiryTimer.unref();
    return {
      address: this.address,
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      socketPath,
      capability,
      idleExpiresAt: this.idleExpiresAt,
      absoluteExpiresAt: this.absoluteExpiresAt,
    };
  }

  public async stop(): Promise<void> {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    const server = this.server;
    this.server = null;
    this.capabilityDigest = null;
    this.schemeClient = null;
    this.sessionPolicy = null;
    this.address = null;
    this.sessionId = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server?.listening)
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    await unlink(resolve(this.options.socketPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      void this.processLine(line).then((response) => socket.end(encodeLine(response)));
    });
    socket.on('error', () => undefined);
  }

  private async processLine(line: string): Promise<BrokerResponse> {
    let id = 'invalid';
    try {
      const request = parseBrokerRequest(JSON.parse(line));
      id = request.id;
      this.assertSession(request.capability);
      if (request.action === 'lock') {
        setTimeout(() => void this.stop(), 25).unref();
        return { id, ok: true, result: { locked: true } };
      }
      if (request.action === 'status')
        return {
          id,
          ok: true,
          result: {
            address: this.address,
            idleExpiresAt: this.idleExpiresAt,
            absoluteExpiresAt: this.absoluteExpiresAt,
          },
        };
      const authorization = parseAuthorization(request.payload);
      if (
        authorization.agentId !== this.options.agentId ||
        authorization.sessionId !== this.sessionId
      )
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'authorization identity does not match the broker session',
        );
      const policy = this.options.ledger.currentPolicy();
      const sessionPolicy = this.sessionPolicy;
      if (!sessionPolicy || !isPolicyRestriction(sessionPolicy, policy))
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'current policy exceeds the broker session envelope',
        );
      this.sessionPolicy = policy;
      const validated = validatePaymentRequirement(
        authorization.paymentRequired,
        policy,
        authorization.requestUrl,
        authorization.model,
      );
      if (validated.requirementHash !== authorization.requirementHash)
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'challenge changed before authorization',
        );
      const operation = this.options.ledger.get(authorization.idempotencyKey);
      if (
        !operation ||
        operation.requestHash !== authorization.requestHash ||
        operation.requirementHash !== authorization.requirementHash ||
        operation.maximumAtomic !== validated.amountAtomic ||
        operation.agentId !== authorization.agentId ||
        operation.sessionId !== authorization.sessionId
      )
        throw new BuyerRuntimeError(
          'IdempotencyConflict',
          'do_not_retry',
          'authorization does not match the local reservation',
        );
      const client = this.schemeClient;
      if (!client) throw new WalletLocked();
      this.options.ledger.claimAuthorization(
        authorization.idempotencyKey,
        authorization.requestHash,
        authorization.requirementHash,
        this.now(),
      );
      let payload: PaymentPayload;
      try {
        payload = await client.createPaymentPayload(validated.paymentRequired);
      } catch (error) {
        this.options.ledger.releaseDefiniteFailure(authorization.idempotencyKey, this.now());
        throw error;
      }
      this.options.ledger.markAuthorized(
        authorization.idempotencyKey,
        authorization.requestHash,
        authorization.requirementHash,
        this.now(),
      );
      return { id, ok: true, result: payload };
    } catch (error) {
      const safe = asBuyerRuntimeError(error);
      return {
        id,
        ok: false,
        error: {
          code: safe.code,
          retry: safe.retry,
          message: safe.message,
          ...(safe.reference ? { reference: safe.reference } : {}),
        },
      };
    }
  }

  private assertSession(capability: string): void {
    if (
      !this.server ||
      !this.capabilityDigest ||
      !safeCapabilityEqual(this.capabilityDigest, capability) ||
      this.isExpired()
    )
      throw new WalletLocked();
    const idleTimeout = this.options.idleTimeoutMs ?? 5 * 60_000;
    this.idleExpiresAt = Math.min(this.now() + idleTimeout, this.absoluteExpiresAt);
  }

  private isExpired(): boolean {
    const now = this.now();
    return now >= this.idleExpiresAt || now >= this.absoluteExpiresAt;
  }

  private async removeStaleSocket(path: string): Promise<void> {
    if (!(await pathExists(path))) return;
    const info = await lstat(path);
    if (!info.isSocket() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
      throw new WalletLocked('refusing to replace an unsafe signer socket');
    await unlink(path);
  }
}

export class SignerBrokerClient implements PaymentAuthorizer {
  public readonly address: `0x${string}`;
  public readonly agentId: string;
  public readonly sessionId: string;

  public constructor(
    private readonly session: SignerBrokerSession,
    private readonly timeoutMs = 10_000,
  ) {
    this.address = session.address;
    this.agentId = session.agentId;
    this.sessionId = session.sessionId;
  }

  public async authorize(request: BrokerAuthorizationRequest): Promise<PaymentPayload> {
    return (await this.call('authorize', request)) as PaymentPayload;
  }

  public async status(): Promise<unknown> {
    return await this.call('status');
  }

  public async lock(): Promise<void> {
    await this.call('lock');
  }

  private async call(action: BrokerRequest['action'], payload?: unknown): Promise<unknown> {
    const id = randomUUID();
    const response = await new Promise<BrokerResponse>((resolveResponse, reject) => {
      const socket = createConnection(this.session.socketPath);
      let buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new WalletLocked('signer broker did not respond'));
      }, this.timeoutMs);
      timer.unref();
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        try {
          socket.write(
            encodeLine({
              id,
              capability: this.session.capability,
              action,
              ...(payload ? { payload } : {}),
            }),
          );
        } catch {
          clearTimeout(timer);
          socket.destroy();
          reject(new WalletLocked('signer broker request is not serializable'));
        }
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
          socket.destroy();
          reject(new WalletLocked('signer broker response is too large'));
        }
      });
      socket.once('end', () => {
        clearTimeout(timer);
        try {
          resolveResponse(JSON.parse(buffer.trim()) as BrokerResponse);
        } catch {
          reject(new WalletLocked('signer broker returned malformed data'));
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new WalletLocked(error.name));
      });
    });
    if (response.id !== id || !response.ok) {
      const safe =
        response.id === id && !response.ok
          ? response.error
          : {
              code: 'WalletLocked' as const,
              retry: 'unlock_wallet' as const,
              message: 'WalletLocked',
            };
      throw new BuyerRuntimeError(safe.code, safe.retry, safe.message, safe.reference);
    }
    return response.result;
  }
}
