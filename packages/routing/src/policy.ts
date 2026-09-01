import { createHash } from 'node:crypto';
import {
  ROUTING_POLICY_VERSION,
  RoutingRejected,
  type RouteProfile,
  type RouteWeights,
  type RoutingPolicy,
} from './types.js';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PROFILES: readonly RouteProfile[] = ['eco', 'auto', 'premium'];

export const DEFAULT_ROUTE_WEIGHTS: Readonly<Record<RouteProfile, RouteWeights>> = {
  eco: { quality: 15, cost: 50, latency: 15, reliability: 15, preference: 5 },
  auto: { quality: 50, cost: 10, latency: 15, reliability: 20, preference: 5 },
  premium: { quality: 55, cost: 5, latency: 10, reliability: 25, preference: 5 },
};

export function createRoutingPolicy(
  input: Omit<RoutingPolicy, 'version' | 'weights'> & {
    readonly weights?: RoutingPolicy['weights'];
  },
): RoutingPolicy {
  const policy: RoutingPolicy = {
    ...input,
    version: ROUTING_POLICY_VERSION,
    weights: input.weights ?? DEFAULT_ROUTE_WEIGHTS,
  };
  validatePolicy(policy);
  return Object.freeze({
    ...policy,
    allowedModels: Object.freeze([...new Set(policy.allowedModels)].sort()),
    weights: Object.freeze({
      eco: Object.freeze({ ...policy.weights.eco }),
      auto: Object.freeze({ ...policy.weights.auto }),
      premium: Object.freeze({ ...policy.weights.premium }),
    }),
  });
}

export function routingPolicyHash(policy: RoutingPolicy): string {
  validatePolicy(policy);
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

function validatePolicy(policy: RoutingPolicy): void {
  if (policy.version !== ROUTING_POLICY_VERSION)
    throw new RoutingRejected('routing policy version is unsupported');
  if (policy.allowedModels.length === 0 || policy.allowedModels.some((model) => !MODEL.test(model)))
    throw new RoutingRejected('routing policy model allowlist is invalid');
  if (
    !Number.isSafeInteger(policy.maximumCandidates) ||
    policy.maximumCandidates < 1 ||
    policy.maximumCandidates > 16
  )
    throw new RoutingRejected('routing candidate limit must be between one and sixteen');
  if (
    !Number.isSafeInteger(policy.maximumHealthAgeMs) ||
    policy.maximumHealthAgeMs < 1_000 ||
    policy.maximumHealthAgeMs > 3_600_000
  )
    throw new RoutingRejected('routing health age is invalid');
  basisPoints(policy.unknownHealthBasisPoints, 'unknown health score');
  for (const profile of PROFILES) {
    const weights = policy.weights[profile];
    const values: readonly number[] = [
      weights.quality,
      weights.cost,
      weights.latency,
      weights.reliability,
      weights.preference,
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new RoutingRejected(`routing weights for ${profile} are invalid`);
    if (values.reduce((total, value) => total + value, 0) !== 100)
      throw new RoutingRejected(`routing weights for ${profile} must sum to 100`);
  }
}

export function basisPoints(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000)
    throw new RoutingRejected(`${label} must be an integer from zero to ten thousand`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
