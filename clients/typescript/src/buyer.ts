import type {
  BuyerRequest,
  BuyerResult,
  EffectiveBuyerPolicy,
  PaymentConfirmation,
  VerifiedReceipt,
} from '@agenticfi/onchain-router-buyer-core';
import {
  BuyerRuntime,
  PaymentPolicyRejected,
  SignerBrokerClient,
  WalletLocked,
} from '@agenticfi/onchain-router-buyer-core';
import {
  DeterministicSmartRouter,
  createRoutingPolicy,
  type RouteDecision,
  type RouteHealth,
  type RouteModel,
  type RouteProfile,
  type RouteWeights,
} from '@agenticfi/onchain-router-routing';
import { LocalSpendLedger } from '@agenticfi/onchain-router-buyer-core/admin';
import { OnchainRouterDiscovery } from './discovery.js';
import {
  MEDIA_ENDPOINTS,
  prepareMediaBody,
  validateMediaCatalog,
  type MediaEndpoint,
  type ImageRequest,
  type SpeechRequest,
  type TranscriptionRequest,
} from './media.js';
import {
  buyerProfilePaths,
  readBuyerSession,
  removeBuyerSession,
  type BuyerProfilePaths,
} from './profile.js';

export const PAID_JSON_ENDPOINTS = [
  '/v1/chat/completions',
  '/v1/messages',
  '/v1/images/generations',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
] as const;

export type PaidJsonEndpoint = (typeof PAID_JSON_ENDPOINTS)[number];

export interface OnchainRouterBuyerOptions {
  readonly profileDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly receiptAttempts?: number;
  readonly confirmPayment?: (confirmation: PaymentConfirmation) => Promise<boolean>;
}

export interface BuyerStatus {
  readonly address: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly policy: ReturnType<typeof serializePolicy>;
  readonly spend: {
    readonly sessionAtomic: string;
    readonly hourAtomic: string;
    readonly dayAtomic: string;
    readonly delegationAtomic: string | null;
  };
}

export interface RoutedChatOptions {
  readonly profile?: RouteProfile;
  readonly models: readonly RouteModel[];
  readonly health?: readonly RouteHealth[];
  readonly estimatedInputTokens?: number;
  readonly allowedModels?: readonly string[];
  readonly maximumCandidates?: number;
  readonly maximumHealthAgeMs?: number;
  readonly unknownHealthBasisPoints?: number;
  readonly weights?: Readonly<Record<RouteProfile, RouteWeights>>;
}

export interface RoutedBuyerResult {
  readonly routing: RouteDecision;
  readonly result: BuyerResult;
  /** Content-free association to the verified durable server receipt; not a second payment proof. */
  readonly routingReceipt: RoutingReceiptEvidence | null;
}

export const ROUTING_RECEIPT_EVIDENCE_VERSION =
  'onchain-router-routing-receipt-evidence/v1' as const;

export interface RoutingReceiptEvidence {
  readonly version: typeof ROUTING_RECEIPT_EVIDENCE_VERSION;
  readonly associationStatus: 'verified' | 'model_mismatch' | 'catalog_mismatch';
  readonly receiptId: string;
  readonly model: string;
  readonly receiptModel: string | null;
  readonly modelMatches: boolean;
  readonly quoteCatalogVersion: string;
  readonly receiptCatalogVersion: string | null;
  readonly catalogVersionsMatch: boolean;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly explanation: string;
  readonly payment: {
    readonly network: string;
    readonly maximumAtomic: string;
    readonly actualAtomic: string;
    readonly transaction: string;
  };
}

/** Render content-free routing and verified payment evidence for a human receipt view. */
export function formatRoutingReceiptEvidence(evidence: RoutingReceiptEvidence): string {
  return [
    `Routing receipt ${evidence.receiptId}`,
    `Association: ${evidence.associationStatus}`,
    `Model: ${evidence.model}`,
    `Catalog: ${evidence.quoteCatalogVersion}`,
    `Policy: ${evidence.policyVersion} (${evidence.policyHash.slice(0, 12)})`,
    `Payment: ${evidence.payment.actualAtomic}/${evidence.payment.maximumAtomic} atomic USDC on ${evidence.payment.network}`,
    `Transaction: ${evidence.payment.transaction}`,
    `Selection: ${evidence.explanation}`,
  ].join('\n');
}

const MAX_ROUTED_BODY_BYTES = 4 * 1024 * 1024;

function snapshotRoutedBody(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw new PaymentPolicyRejected('routed request body must be JSON serializable');
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_ROUTED_BODY_BYTES)
    throw new PaymentPolicyRejected('routed request body exceeds the local size limit');
  const value = JSON.parse(encoded) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PaymentPolicyRejected('routed request body must be a JSON object');
  return value as Readonly<Record<string, unknown>>;
}

function brokerStatus(value: unknown): {
  address: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
} {
  if (typeof value !== 'object' || value === null)
    throw new WalletLocked('signer broker returned an invalid status');
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['address'] !== 'string' ||
    typeof candidate['idleExpiresAt'] !== 'number' ||
    !Number.isSafeInteger(candidate['idleExpiresAt']) ||
    typeof candidate['absoluteExpiresAt'] !== 'number' ||
    !Number.isSafeInteger(candidate['absoluteExpiresAt'])
  )
    throw new WalletLocked('signer broker returned an invalid status');
  return {
    address: candidate['address'],
    idleExpiresAt: candidate['idleExpiresAt'],
    absoluteExpiresAt: candidate['absoluteExpiresAt'],
  };
}

function serializePolicy(policy: EffectiveBuyerPolicy) {
  return {
    canonicalOrigin: policy.canonicalOrigin,
    network: policy.network,
    asset: policy.asset,
    recipients: [...policy.recipients],
    schemes: [...policy.schemes],
    models: [...policy.models],
    limits: {
      perCallAtomic: policy.limits.perCallAtomic.toString(),
      sessionAtomic: policy.limits.sessionAtomic.toString(),
      hourAtomic: policy.limits.hourAtomic.toString(),
      dayAtomic: policy.limits.dayAtomic.toString(),
    },
    delegations: (policy.delegations ?? []).map((delegation) => ({
      agentId: delegation.agentId,
      maximumAtomic: delegation.maximumAtomic.toString(),
      revoked: delegation.revoked ?? false,
    })),
    sessionDurationMs: policy.sessionDurationMs,
    reservationTtlMs: policy.reservationTtlMs,
    maximumAuthorizationSeconds: policy.maximumAuthorizationSeconds,
    maximumOutputTokens: policy.maximumOutputTokens,
    requirePerCallConfirmation: policy.requirePerCallConfirmation,
    hash: policy.hash,
  };
}

export class OnchainRouterBuyer {
  public readonly discovery: OnchainRouterDiscovery;
  public readonly paths: BuyerProfilePaths;
  private closed = false;

  private constructor(
    paths: BuyerProfilePaths,
    private readonly ledger: LocalSpendLedger,
    private readonly authorizer: SignerBrokerClient,
    private readonly runtime: BuyerRuntime,
    fetchImplementation?: typeof fetch,
  ) {
    this.paths = paths;
    this.discovery = new OnchainRouterDiscovery(ledger.currentPolicy().canonicalOrigin, {
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  public static async connect(
    options: OnchainRouterBuyerOptions = {},
  ): Promise<OnchainRouterBuyer> {
    const paths = buyerProfilePaths(options.profileDirectory);
    const session = await readBuyerSession(paths.directory);
    if (!session) throw new WalletLocked('buyer wallet is locked');
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    try {
      const authorizer = new SignerBrokerClient(session);
      await authorizer.status();
      const runtime = new BuyerRuntime({
        ledger,
        authorizer,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.receiptAttempts ? { receiptAttempts: options.receiptAttempts } : {}),
        ...(options.confirmPayment ? { confirmPayment: options.confirmPayment } : {}),
      });
      return new OnchainRouterBuyer(paths, ledger, authorizer, runtime, options.fetch);
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  public async status(): Promise<BuyerStatus> {
    this.assertOpen();
    const broker = brokerStatus(await this.authorizer.status());
    const policy = this.ledger.currentPolicy();
    const spend = this.ledger.spendSummary(this.authorizer.sessionId, this.authorizer.agentId);
    return {
      address: this.authorizer.address,
      agentId: this.authorizer.agentId,
      sessionId: this.authorizer.sessionId,
      idleExpiresAt: broker.idleExpiresAt,
      absoluteExpiresAt: broker.absoluteExpiresAt,
      policy: serializePolicy(policy),
      spend: {
        sessionAtomic: spend.sessionAtomic.toString(),
        hourAtomic: spend.hourAtomic.toString(),
        dayAtomic: spend.dayAtomic.toString(),
        delegationAtomic: spend.delegationAtomic?.toString() ?? null,
      },
    };
  }

  public async chat(
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<BuyerResult> {
    return await this.execute('/v1/chat/completions', body, idempotencyKey);
  }

  /**
   * Select one explicit model from local policy and authoritative free quotes, then delegate the
   * complete x402 lifecycle to Buyer Runtime. Candidate routes are advisory and are never retried.
   */
  public async routedChat(
    body: Readonly<Record<string, unknown>>,
    options: RoutedChatOptions,
    idempotencyKey?: string,
  ): Promise<RoutedBuyerResult> {
    this.assertOpen();
    const requestBody = snapshotRoutedBody(body);
    const buyerPolicy = this.ledger.currentPolicy();
    const requested = new Set(options.allowedModels ?? options.models.map((model) => model.id));
    const allowedModels = buyerPolicy.models.filter((model) => requested.has(model));
    if (allowedModels.length === 0)
      throw new PaymentPolicyRejected('no routing model is allowed by Buyer Runtime policy');
    const routingPolicy = createRoutingPolicy({
      allowedModels,
      maximumCandidates: options.maximumCandidates ?? Math.min(8, allowedModels.length),
      maximumHealthAgeMs: options.maximumHealthAgeMs ?? 60_000,
      unknownHealthBasisPoints: options.unknownHealthBasisPoints ?? 5_000,
      ...(options.weights ? { weights: options.weights } : {}),
    });
    const quoteTokens = new Map<string, string>();
    const router = new DeterministicSmartRouter(routingPolicy, {
      quote: async (input) => {
        const quote = await this.discovery.quote(input.kind, input.request);
        quoteTokens.set(input.model, quote.token);
        return {
          model: input.model,
          maximumAtomic: quote.maximumAtomic,
          catalogVersion: quote.catalogVersion,
          expiresAt: quote.expiresAt,
        };
      },
    });
    const routing = await router.route({
      endpoint: '/v1/chat/completions',
      kind: 'openai',
      profile: options.profile ?? 'auto',
      body: requestBody,
      models: options.models,
      ...(options.health ? { health: options.health } : {}),
      localMaximumAtomic: buyerPolicy.limits.perCallAtomic,
      ...(options.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: options.estimatedInputTokens }
        : {}),
    });
    if (!allowedModels.includes(routing.selectedModel))
      throw new PaymentPolicyRejected('router selected a model outside Buyer Runtime policy');
    if (BigInt(routing.routeSetMaximumAtomic) > buyerPolicy.limits.perCallAtomic)
      throw new PaymentPolicyRejected('router returned a route set above the local per-call cap');
    const quoteToken = quoteTokens.get(routing.selectedModel);
    if (!quoteToken)
      throw new PaymentPolicyRejected('selected route omitted its request-bound quote token');
    const result = await this.execute(
      '/v1/chat/completions',
      { ...requestBody, model: routing.selectedModel },
      idempotencyKey,
      { 'x-quote-token': quoteToken },
    );
    const routingReceipt = result.ok
      ? Object.freeze({
          version: ROUTING_RECEIPT_EVIDENCE_VERSION,
          associationStatus:
            result.receipt.model !== routing.selectedModel
              ? ('model_mismatch' as const)
              : result.receipt.catalogVersion !== routing.catalogVersion
                ? ('catalog_mismatch' as const)
                : ('verified' as const),
          receiptId: result.receipt.id,
          model: routing.selectedModel,
          receiptModel: result.receipt.model,
          modelMatches: result.receipt.model === routing.selectedModel,
          quoteCatalogVersion: routing.catalogVersion,
          receiptCatalogVersion: result.receipt.catalogVersion,
          catalogVersionsMatch: result.receipt.catalogVersion === routing.catalogVersion,
          policyVersion: routing.policyVersion,
          policyHash: routing.policyHash,
          explanation: routing.explanation,
          payment: Object.freeze({
            network: result.receipt.settlement.network,
            maximumAtomic: result.receipt.maximumAmount,
            actualAtomic: result.receipt.actualAmount,
            transaction: result.receipt.settlement.transaction,
          }),
        })
      : null;
    return Object.freeze({ routing, result, routingReceipt });
  }

  public async messages(
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<BuyerResult> {
    return await this.execute('/v1/messages', body, idempotencyKey, {
      'anthropic-version': '2023-06-01',
    });
  }

  public async images(body: ImageRequest, idempotencyKey?: string): Promise<BuyerResult> {
    return await this.execute('/v1/images/generations', body, idempotencyKey);
  }

  public async speech(body: SpeechRequest, idempotencyKey?: string): Promise<BuyerResult> {
    return await this.execute('/v1/audio/speech', body, idempotencyKey);
  }

  public async transcriptions(
    body: TranscriptionRequest,
    idempotencyKey?: string,
  ): Promise<BuyerResult> {
    return await this.execute('/v1/audio/transcriptions', body, idempotencyKey);
  }

  public async execute(
    endpoint: PaidJsonEndpoint,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<BuyerResult> {
    this.assertOpen();
    if (!PAID_JSON_ENDPOINTS.includes(endpoint))
      throw new PaymentPolicyRejected('paid endpoint is not supported by this SDK');
    const model = body['model'];
    if (typeof model !== 'string')
      throw new PaymentPolicyRejected('paid request requires an explicit model');
    const policy = this.ledger.currentPolicy();
    let preparedBody = body;
    if (MEDIA_ENDPOINTS.includes(endpoint as MediaEndpoint)) {
      preparedBody = prepareMediaBody(endpoint as MediaEndpoint, body);
      const previous = idempotencyKey ? this.ledger.get(idempotencyKey) : null;
      // Advisory catalog availability must not strand an already-authorized request. Runtime
      // still enforces the original request hash, live human policy, and durable receipt.
      if (!previous || previous.state === 'reserved' || previous.state === 'released')
        validateMediaCatalog(
          endpoint as MediaEndpoint,
          preparedBody,
          await this.discovery.models(),
        );
    }
    const request: BuyerRequest = {
      url: `${policy.canonicalOrigin}${endpoint}`,
      body: preparedBody,
      model,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(headers ? { headers } : {}),
    };
    return await this.runtime.execute(request);
  }

  public receipt(idempotencyKey: string): VerifiedReceipt | null {
    this.assertOpen();
    return this.ledger.receipt(idempotencyKey);
  }

  public async lock(): Promise<void> {
    if (this.closed) return;
    try {
      await this.authorizer.lock();
    } finally {
      await removeBuyerSession(this.paths.directory).catch(() => undefined);
      this.close();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ledger.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new WalletLocked('buyer SDK is closed');
  }
}
