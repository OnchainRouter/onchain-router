import { classifyTask, requiredCapabilities } from './classifier.js';
import { basisPoints, createRoutingPolicy, routingPolicyHash } from './policy.js';
import {
  ROUTING_PORT_VERSION,
  RoutingRejected,
  type RankedRoute,
  type RouteDecision,
  type RouteExclusion,
  type RouteHealth,
  type RouteModel,
  type RouteQuotePort,
  type RouteRequest,
  type RouteTask,
  type RoutingPolicy,
  type SmartRoutingPort,
} from './types.js';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CATALOG_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface EligibleModel {
  readonly model: RouteModel;
  readonly health: RouteHealth | undefined;
  readonly healthState: 'fresh' | 'stale' | 'unknown';
}

interface QuotedModel extends EligibleModel {
  readonly maximumAtomic: bigint;
  readonly catalogVersion: string;
}

export class DeterministicSmartRouter implements SmartRoutingPort {
  public readonly version = ROUTING_PORT_VERSION;
  private readonly policy: RoutingPolicy;
  private readonly quotes: RouteQuotePort;

  public constructor(policy: RoutingPolicy, quotes: RouteQuotePort) {
    routingPolicyHash(policy);
    this.policy = createRoutingPolicy({
      allowedModels: policy.allowedModels,
      maximumCandidates: policy.maximumCandidates,
      maximumHealthAgeMs: policy.maximumHealthAgeMs,
      unknownHealthBasisPoints: policy.unknownHealthBasisPoints,
      weights: policy.weights,
    });
    this.quotes = quotes;
  }

  public async route(request: RouteRequest): Promise<RouteDecision> {
    const now = request.now ?? Date.now();
    validateRequest(request, now);
    const task = classifyTask(request);
    const required = requiredCapabilities(request);
    const exclusions: RouteExclusion[] = [];
    const health = new Map((request.health ?? []).map((item) => [item.model, item]));
    const allowlist = new Set(this.policy.allowedModels);
    const candidates: EligibleModel[] = [];

    for (const model of [...request.models].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const exclusion = hardFilter(
        model,
        request,
        allowlist,
        required,
        health.get(model.id),
        now,
        this.policy.maximumHealthAgeMs,
      );
      if (exclusion) {
        exclusions.push({ model: model.id, code: exclusion });
        continue;
      }
      const snapshot = health.get(model.id);
      const healthState = snapshot
        ? now - snapshot.observedAt <= this.policy.maximumHealthAgeMs
          ? 'fresh'
          : 'stale'
        : 'unknown';
      candidates.push({ model, health: snapshot, healthState });
    }

    if (candidates.length === 0)
      throw new RoutingRejected('no route passed hard constraints', exclusions);
    if (candidates.length > this.policy.maximumCandidates)
      throw new RoutingRejected('eligible routes exceed the bounded quote fan-out', exclusions);

    const quoted = await Promise.all(
      candidates.map(async (candidate): Promise<QuotedModel | null> => {
        try {
          const quote = await this.quotes.quote({
            kind: request.kind,
            endpoint: request.endpoint,
            model: candidate.model.id,
            request: Object.freeze({ ...request.body, model: candidate.model.id }),
          });
          if (quote.model !== candidate.model.id || quote.maximumAtomic <= 0n) {
            exclusions.push({ model: candidate.model.id, code: 'quote_failed' });
            return null;
          }
          if (!CATALOG_VERSION.test(quote.catalogVersion)) {
            exclusions.push({ model: candidate.model.id, code: 'quote_failed' });
            return null;
          }
          if (quote.expiresAt <= now) {
            exclusions.push({ model: candidate.model.id, code: 'quote_expired' });
            return null;
          }
          if (quote.maximumAtomic > request.localMaximumAtomic) {
            exclusions.push({ model: candidate.model.id, code: 'over_local_maximum' });
            return null;
          }
          return {
            ...candidate,
            maximumAtomic: quote.maximumAtomic,
            catalogVersion: quote.catalogVersion,
          };
        } catch {
          exclusions.push({ model: candidate.model.id, code: 'quote_failed' });
          return null;
        }
      }),
    );
    const usable = quoted.filter((candidate): candidate is QuotedModel => candidate !== null);
    if (usable.length === 0)
      throw new RoutingRejected('no route has a usable bounded quote', exclusions);
    const catalogVersions = new Set(usable.map((candidate) => candidate.catalogVersion));
    if (catalogVersions.size !== 1) {
      for (const candidate of usable)
        exclusions.push({ model: candidate.model.id, code: 'catalog_drift' });
      throw new RoutingRejected('route quotes do not share one catalog version', exclusions);
    }

    const routes = rank(usable, task, request.profile, this.policy);
    const selected = routes[0];
    if (!selected) throw new RoutingRejected('routing ranker returned no route', exclusions);
    const routeSetMaximum = usable.reduce(
      (maximum, candidate) =>
        candidate.maximumAtomic > maximum ? candidate.maximumAtomic : maximum,
      0n,
    );
    const catalogVersion = usable[0]?.catalogVersion;
    if (!catalogVersion) throw new RoutingRejected('routing quote omitted catalog version');
    return Object.freeze({
      portVersion: ROUTING_PORT_VERSION,
      policyVersion: this.policy.version,
      policyHash: routingPolicyHash(this.policy),
      catalogVersion,
      profile: request.profile,
      task,
      selectedModel: selected.model,
      selectedMaximumAtomic: selected.maximumAtomic,
      routeSetMaximumAtomic: routeSetMaximum.toString(),
      fallbackAuthorized: false,
      routes: Object.freeze(routes),
      exclusions: Object.freeze(
        [...exclusions].sort(
          (left, right) =>
            left.model.localeCompare(right.model) || left.code.localeCompare(right.code),
        ),
      ),
      explanation: `Selected ${selected.model} for ${task}/${request.profile}; ${routes.length} bounded route${routes.length === 1 ? '' : 's'}; catalog ${catalogVersion.slice(0, 12)}; fallback disabled.`,
    });
  }
}

function hardFilter(
  model: RouteModel,
  request: RouteRequest,
  allowlist: ReadonlySet<string>,
  required: ReadonlySet<string>,
  health: RouteHealth | undefined,
  now: number,
  maximumHealthAgeMs: number,
): RouteExclusion['code'] | null {
  if (!MODEL.test(model.id)) return 'not_allowed';
  if (!model.enabled) return 'disabled';
  if (!allowlist.has(model.id)) return 'not_allowed';
  if (model.category !== 'text_generation') return 'wrong_category';
  if ([...required].some((capability) => !model.capabilities.includes(capability as never)))
    return 'missing_capability';
  const maximumOutput = request.body['max_tokens'] ?? request.body['max_completion_tokens'];
  if (
    typeof maximumOutput === 'number' &&
    Number.isSafeInteger(maximumOutput) &&
    maximumOutput > model.maximumOutputTokens
  )
    return 'output_limit';
  if (
    model.maximumContextTokens !== undefined &&
    request.estimatedInputTokens !== undefined &&
    request.estimatedInputTokens + outputTokens(request.body) > model.maximumContextTokens
  )
    return 'context_limit';
  if (
    health?.status === 'unavailable' &&
    now >= health.observedAt &&
    now - health.observedAt <= maximumHealthAgeMs
  )
    return 'fresh_unavailable';
  return null;
}

function outputTokens(body: Readonly<Record<string, unknown>>): number {
  const value = body['max_tokens'] ?? body['max_completion_tokens'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function rank(
  candidates: readonly QuotedModel[],
  task: RouteTask,
  profile: RouteRequest['profile'],
  policy: RoutingPolicy,
): RankedRoute[] {
  const minimumCost = candidates.reduce(
    (minimum, candidate) => (candidate.maximumAtomic < minimum ? candidate.maximumAtomic : minimum),
    candidates[0]?.maximumAtomic ?? 1n,
  );
  const freshLatencies = candidates
    .filter((candidate) => candidate.healthState === 'fresh')
    .map((candidate) => candidate.health?.latencyMs ?? 0)
    .filter((value) => value > 0);
  const minimumLatency = freshLatencies.length > 0 ? Math.min(...freshLatencies) : null;
  const weights = policy.weights[profile];
  return candidates
    .map((candidate): RankedRoute => {
      const quality = basisPoints(
        candidate.model.qualityBasisPoints[task] ??
          candidate.model.qualityBasisPoints.general ??
          5_000,
        `${candidate.model.id} quality`,
      );
      const cost = Number((minimumCost * 10_000n) / candidate.maximumAtomic);
      const fresh = candidate.healthState === 'fresh' ? candidate.health : undefined;
      const latency =
        fresh && minimumLatency !== null
          ? Math.min(10_000, Math.floor((minimumLatency * 10_000) / Math.max(1, fresh.latencyMs)))
          : policy.unknownHealthBasisPoints;
      const reliability = fresh
        ? basisPoints(fresh.successBasisPoints, `${candidate.model.id} reliability`)
        : policy.unknownHealthBasisPoints;
      const preference = basisPoints(
        candidate.model.preferenceBasisPoints ?? 5_000,
        `${candidate.model.id} preference`,
      );
      const score =
        BigInt(quality * weights.quality) +
        BigInt(cost * weights.cost) +
        BigInt(latency * weights.latency) +
        BigInt(reliability * weights.reliability) +
        BigInt(preference * weights.preference);
      return {
        model: candidate.model.id,
        maximumAtomic: candidate.maximumAtomic.toString(),
        score: score.toString(),
        qualityBasisPoints: quality,
        costBasisPoints: cost,
        latencyBasisPoints: latency,
        reliabilityBasisPoints: reliability,
        preferenceBasisPoints: preference,
        health: candidate.healthState,
      };
    })
    .sort(
      (left, right) =>
        compareIntegerStrings(right.score, left.score) ||
        compareIntegerStrings(left.maximumAtomic, right.maximumAtomic) ||
        left.model.localeCompare(right.model),
    );
}

function compareIntegerStrings(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateRequest(request: RouteRequest, now: number): void {
  if (request.kind === 'openai' && request.endpoint !== '/v1/chat/completions')
    throw new RoutingRejected('OpenAI routing requires the chat completions endpoint');
  if (request.kind === 'anthropic' && request.endpoint !== '/v1/messages')
    throw new RoutingRejected('Anthropic routing requires the messages endpoint');
  if (request.localMaximumAtomic <= 0n)
    throw new RoutingRejected('local routing maximum must be positive');
  if (
    request.estimatedInputTokens !== undefined &&
    (!Number.isSafeInteger(request.estimatedInputTokens) || request.estimatedInputTokens < 0)
  )
    throw new RoutingRejected('estimated input tokens are invalid');
  if (request.now !== undefined && (!Number.isSafeInteger(request.now) || request.now <= 0))
    throw new RoutingRejected('routing clock is invalid');
  const modelIds = new Set<string>();
  for (const model of request.models) {
    if (modelIds.has(model.id)) throw new RoutingRejected(`duplicate routing model ${model.id}`);
    modelIds.add(model.id);
    if (!Number.isSafeInteger(model.maximumOutputTokens) || model.maximumOutputTokens < 1)
      throw new RoutingRejected(`${model.id} maximum output tokens are invalid`);
    if (
      model.maximumContextTokens !== undefined &&
      (!Number.isSafeInteger(model.maximumContextTokens) || model.maximumContextTokens < 1)
    )
      throw new RoutingRejected(`${model.id} context limit is invalid`);
  }
  const healthModels = new Set<string>();
  for (const item of request.health ?? []) {
    if (healthModels.has(item.model))
      throw new RoutingRejected(`duplicate health snapshot for ${item.model}`);
    healthModels.add(item.model);
    if (
      !Number.isSafeInteger(item.observedAt) ||
      item.observedAt > now ||
      !Number.isSafeInteger(item.latencyMs) ||
      item.latencyMs < 0
    )
      throw new RoutingRejected(`${item.model} health snapshot is invalid`);
    basisPoints(item.successBasisPoints, `${item.model} health reliability`);
  }
}
