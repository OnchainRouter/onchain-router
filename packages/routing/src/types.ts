export const ROUTING_POLICY_VERSION = 'onchain-router-routing/v1' as const;
export const ROUTING_PORT_VERSION = 'onchain-router-routing-port/v1' as const;

export type RouteProfile = 'eco' | 'auto' | 'premium';
export type RouteTask = 'general' | 'code' | 'reasoning' | 'tool-use' | 'vision';
export type RouteCapability = 'text' | 'tools' | 'json' | 'vision';
export type RouteEndpoint = '/v1/chat/completions' | '/v1/messages';
export type RouteKind = 'openai' | 'anthropic';

export interface RouteModel {
  readonly id: string;
  readonly enabled: boolean;
  readonly category: 'text_generation';
  readonly capabilities: readonly RouteCapability[];
  readonly maximumOutputTokens: number;
  readonly maximumContextTokens?: number;
  /** Local, operator-reviewed task quality prior from 0 to 10,000. */
  readonly qualityBasisPoints: Readonly<Partial<Record<RouteTask, number>>>;
  /** Optional local preference from 0 to 10,000. It must not bypass hard filters. */
  readonly preferenceBasisPoints?: number;
}

export interface RouteHealth {
  readonly model: string;
  readonly status: 'available' | 'unavailable';
  readonly observedAt: number;
  readonly latencyMs: number;
  readonly successBasisPoints: number;
}

export interface RouteQuoteInput {
  readonly kind: RouteKind;
  readonly endpoint: RouteEndpoint;
  readonly model: string;
  readonly request: Readonly<Record<string, unknown>>;
}

export interface RouteQuote {
  readonly model: string;
  readonly maximumAtomic: bigint;
  readonly catalogVersion: string;
  readonly expiresAt: number;
}

export interface RouteQuotePort {
  quote(input: RouteQuoteInput): Promise<RouteQuote>;
}

export interface RouteWeights {
  readonly quality: number;
  readonly cost: number;
  readonly latency: number;
  readonly reliability: number;
  readonly preference: number;
}

export interface RoutingPolicy {
  readonly version: typeof ROUTING_POLICY_VERSION;
  readonly allowedModels: readonly string[];
  readonly maximumCandidates: number;
  readonly maximumHealthAgeMs: number;
  readonly unknownHealthBasisPoints: number;
  readonly weights: Readonly<Record<RouteProfile, RouteWeights>>;
}

export interface RouteRequest {
  readonly endpoint: RouteEndpoint;
  readonly kind: RouteKind;
  readonly profile: RouteProfile;
  readonly body: Readonly<Record<string, unknown>>;
  readonly models: readonly RouteModel[];
  readonly health?: readonly RouteHealth[];
  /** The already-authorized local Buyer Runtime per-call ceiling. */
  readonly localMaximumAtomic: bigint;
  readonly estimatedInputTokens?: number;
  readonly now?: number;
}

export type RouteExclusionCode =
  | 'disabled'
  | 'not_allowed'
  | 'wrong_category'
  | 'missing_capability'
  | 'output_limit'
  | 'context_limit'
  | 'fresh_unavailable'
  | 'quote_failed'
  | 'quote_expired'
  | 'catalog_drift'
  | 'over_local_maximum';

export interface RouteExclusion {
  readonly model: string;
  readonly code: RouteExclusionCode;
}

export interface RankedRoute {
  readonly model: string;
  readonly maximumAtomic: string;
  readonly score: string;
  readonly qualityBasisPoints: number;
  readonly costBasisPoints: number;
  readonly latencyBasisPoints: number;
  readonly reliabilityBasisPoints: number;
  readonly preferenceBasisPoints: number;
  readonly health: 'fresh' | 'stale' | 'unknown';
}

export interface RouteDecision {
  readonly portVersion: typeof ROUTING_PORT_VERSION;
  readonly policyVersion: typeof ROUTING_POLICY_VERSION;
  readonly policyHash: string;
  readonly catalogVersion: string;
  readonly profile: RouteProfile;
  readonly task: RouteTask;
  readonly selectedModel: string;
  readonly selectedMaximumAtomic: string;
  /** Maximum of every quoted route retained in the advisory route set. */
  readonly routeSetMaximumAtomic: string;
  readonly fallbackAuthorized: false;
  readonly routes: readonly RankedRoute[];
  readonly exclusions: readonly RouteExclusion[];
  /** Content-free, compact rationale safe to associate with a receipt. */
  readonly explanation: string;
}

export interface SmartRoutingPort {
  readonly version: typeof ROUTING_PORT_VERSION;
  route(request: RouteRequest): Promise<RouteDecision>;
}

export class RoutingRejected extends Error {
  public constructor(
    message: string,
    public readonly exclusions: readonly RouteExclusion[] = [],
  ) {
    super(message);
    this.name = 'RoutingRejected';
  }
}
