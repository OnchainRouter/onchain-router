import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload } from '@x402/core/types';
import { PERMIT2_ADDRESS, getPermit2AllowanceReadParams, toClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  asBuyerRuntimeError,
  BuyerRuntimeError,
  InsufficientFunds,
  Permit2ApprovalOutcomeUnknown,
  Permit2ApprovalRequired,
  RuntimeUnavailable,
  type BuyerOutcomeCode,
  type RetryDirective,
  WalletLocked,
} from './errors.js';
import { ensurePrivateDirectory, pathExists } from './filesystem.js';
import type { LocalSpendLedger } from './ledger.js';
import { createBoundedPermit2ApprovalTx } from './permit2.js';
import {
  isPolicyRestriction,
  validateEffectiveBuyerPolicy,
  validatePaymentRequirement,
} from './policy.js';
import type {
  BrokerAuthorizationRequest,
  EffectiveBuyerPolicy,
  PaymentAuthorizer,
  Permit2ApprovalResult,
  Permit2Status,
} from './types.js';
import { unlockWalletForBroker } from './vault.js';
import type { WalletVault } from './vault.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
interface BrokerRequest {
  readonly id: string;
  readonly capability: string;
  readonly action: 'status' | 'authorize' | 'permit2Status' | 'approvePermit2' | 'lock';
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

export interface Permit2Operations {
  allowance(owner: `0x${string}`, asset: `0x${string}`): Promise<bigint>;
  nativeBalance(owner: `0x${string}`): Promise<bigint>;
  approve(
    asset: `0x${string}`,
    amountAtomic: bigint,
  ): Promise<{
    readonly transactionHash: `0x${string}`;
    readonly status: 'success' | 'reverted';
  }>;
}

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
  /** Test-only chain boundary. Production always constructs the account-bound Base clients. */
  readonly testPermit2Operations?: Permit2Operations;
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
    !['status', 'authorize', 'permit2Status', 'approvePermit2', 'lock'].includes(
      candidate.action ?? '',
    )
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
  private permit2Operations: Permit2Operations | null = null;

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
    const readClient = createPublicClient({
      chain: base,
      transport: http('https://mainnet.base.org'),
    });
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http('https://mainnet.base.org'),
    });
    const signer = toClientEvmSigner(account);
    this.schemeClient =
      policy.schemes[0] === 'exact'
        ? new x402Client().register(policy.network, new ExactEvmScheme(signer))
        : new x402Client().register(policy.network, new UptoEvmScheme(signer));
    this.permit2Operations =
      policy.schemes[0] === 'upto'
        ? (this.options.testPermit2Operations ??
          Object.freeze({
            allowance: async (owner: `0x${string}`, asset: `0x${string}`) =>
              await readClient.readContract(
                getPermit2AllowanceReadParams({
                  tokenAddress: asset,
                  ownerAddress: owner,
                }),
              ),
            nativeBalance: async (owner: `0x${string}`) =>
              await readClient.getBalance({ address: owner }),
            approve: async (asset: `0x${string}`, amountAtomic: bigint) => {
              const transactionHash = await walletClient.sendTransaction(
                createBoundedPermit2ApprovalTx(asset, amountAtomic),
              );
              let receipt;
              try {
                receipt = await readClient.waitForTransactionReceipt({
                  hash: transactionHash,
                  confirmations: 1,
                  timeout: 120_000,
                });
              } catch {
                throw new Permit2ApprovalOutcomeUnknown(
                  'Permit2 approval was submitted but its receipt is unavailable; run `onchain-router permit2 status` before any new approval',
                  transactionHash,
                );
              }
              return { transactionHash, status: receipt.status };
            },
          }))
        : null;
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
    this.permit2Operations = null;
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
      if (request.action === 'permit2Status')
        return { id, ok: true, result: await this.readPermit2Status() };
      if (request.action === 'approvePermit2')
        return { id, ok: true, result: await this.approvePermit2() };
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
      if (policy.schemes[0] === 'upto') {
        const permit2 = this.permit2Operations;
        const owner = this.address;
        if (!permit2 || !owner) throw new WalletLocked();
        let allowance: bigint;
        try {
          allowance = await permit2.allowance(owner, policy.asset);
        } catch {
          this.options.ledger.releaseDefiniteFailure(authorization.idempotencyKey, this.now());
          throw new RuntimeUnavailable(
            'Permit2 allowance could not be read; no payment signature was created',
          );
        }
        if (allowance < validated.amountAtomic) {
          this.options.ledger.releaseDefiniteFailure(authorization.idempotencyKey, this.now());
          throw new Permit2ApprovalRequired(
            'Permit2 approval is required for this legacy upto profile; migrate to exact or run `onchain-router permit2 approve`',
          );
        }
      }
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

  private async readPermit2Status(): Promise<Permit2Status> {
    const operations = this.permit2Operations;
    const policy = this.sessionPolicy;
    const owner = this.address;
    if (!operations || !policy || !owner) throw new WalletLocked();
    const [allowance, nativeBalance] = await Promise.all([
      operations.allowance(owner, policy.asset),
      operations.nativeBalance(owner),
    ]);
    return {
      object: 'permit2_status',
      network: policy.network,
      owner,
      asset: policy.asset,
      spender: PERMIT2_ADDRESS,
      allowanceAtomic: allowance.toString(),
      requiredAtomic: policy.limits.dayAtomic.toString(),
      approved: allowance >= policy.limits.dayAtomic,
      nativeBalanceWei: nativeBalance.toString(),
    };
  }

  private async approvePermit2(): Promise<Permit2ApprovalResult> {
    const before = await this.readPermit2Status();
    if (before.approved)
      return { ...before, object: 'permit2_approval', outcome: 'already_approved' };
    if (BigInt(before.nativeBalanceWei) === 0n)
      throw new InsufficientFunds(
        'Base ETH is required once to pay gas for the canonical Permit2 approval',
      );
    const operations = this.permit2Operations;
    const policy = this.sessionPolicy;
    if (!operations || !policy) throw new WalletLocked();
    let transaction;
    try {
      transaction = await operations.approve(policy.asset, policy.limits.dayAtomic);
    } catch (error) {
      const safe = asBuyerRuntimeError(error);
      if (safe.code === 'InsufficientFunds' || safe.code === 'Permit2ApprovalOutcomeUnknown')
        throw safe;
      throw new Permit2ApprovalOutcomeUnknown(
        'Permit2 approval outcome is unknown; run `onchain-router permit2 status` before any new approval',
      );
    }
    if (transaction.status !== 'success')
      throw new Permit2ApprovalRequired(
        'Permit2 approval transaction reverted; inspect the wallet and Base gas before approving again',
        transaction.transactionHash,
      );
    let after: Permit2Status;
    try {
      after = await this.readPermit2Status();
    } catch {
      throw new Permit2ApprovalOutcomeUnknown(
        'Permit2 approval confirmed but the resulting allowance could not be read; run `onchain-router permit2 status` before any new approval',
        transaction.transactionHash,
      );
    }
    if (!after.approved)
      throw new Permit2ApprovalOutcomeUnknown(
        'Permit2 approval confirmed but the required allowance is not visible; run `onchain-router permit2 status` before any new approval',
        transaction.transactionHash,
      );
    return {
      ...after,
      object: 'permit2_approval',
      outcome: 'approved',
      transactionHash: transaction.transactionHash,
    };
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

  public async permit2Status(): Promise<Permit2Status> {
    return (await this.call('permit2Status')) as Permit2Status;
  }

  public async approvePermit2(): Promise<Permit2ApprovalResult> {
    return (await this.call('approvePermit2')) as Permit2ApprovalResult;
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
