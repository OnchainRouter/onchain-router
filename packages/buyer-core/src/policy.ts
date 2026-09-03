import { getAddress } from 'viem';
import { validatePaymentRequired } from '@x402/core/schemas';
import type { PaymentRequired } from '@x402/core/types';
import {
  AuthorizationAboveLocalCap,
  type BuyerRuntimeError,
  PaymentPolicyRejected,
  UnexpectedAsset,
  UnexpectedRecipient,
  UnsupportedNetwork,
} from './errors.js';
import { canonicalHash } from './canonical.js';
import {
  MAX_SQLITE_INTEGER,
  type BuyerPolicy,
  type EffectiveBuyerPolicy,
  type ValidatedPaymentRequirement,
} from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function normalizedAddress(
  value: string,
  ErrorType: new (message?: string) => BuyerRuntimeError,
): `0x${string}` {
  try {
    const normalized = getAddress(value);
    const body = value.slice(2);
    const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixedCase && normalized !== value)
      throw new PaymentPolicyRejected('policy address has an invalid checksum');
    return normalized;
  } catch {
    throw new ErrorType('policy address has an invalid checksum');
  }
}

function positiveAtomic(value: bigint, label: string): void {
  if (value <= 0n || value > MAX_SQLITE_INTEGER)
    throw new PaymentPolicyRejected(`${label} must be a positive signed 64-bit integer`);
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentPolicyRejected('canonical origin is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new PaymentPolicyRejected('canonical origin must be a credential-free HTTPS origin');
  if (url.pathname !== '/' || value.endsWith('/'))
    throw new PaymentPolicyRejected('canonical origin must not contain a path or trailing slash');
  return url.origin;
}

export function createBuyerPolicy(input: BuyerPolicy): EffectiveBuyerPolicy {
  const origin = canonicalOrigin(input.canonicalOrigin);
  if (input.network !== 'eip155:8453')
    throw new UnsupportedNetwork('Buyer Runtime v1 supports Base mainnet only');
  if (!ADDRESS.test(input.asset)) throw new UnexpectedAsset('policy asset is not an EVM address');
  if (input.schemes.length !== 1 || (input.schemes[0] !== 'exact' && input.schemes[0] !== 'upto'))
    throw new PaymentPolicyRejected('Buyer Runtime supports one official x402 EVM scheme');
  if (input.recipients.length === 0 || input.recipients.some((value) => !ADDRESS.test(value)))
    throw new UnexpectedRecipient('policy requires at least one valid recipient');
  if (input.models.length === 0 || input.models.some((value) => !MODEL.test(value)))
    throw new PaymentPolicyRejected('policy requires valid explicit model aliases');
  positiveAtomic(input.limits.perCallAtomic, 'per-call cap');
  positiveAtomic(input.limits.sessionAtomic, 'session cap');
  positiveAtomic(input.limits.hourAtomic, 'hour cap');
  positiveAtomic(input.limits.dayAtomic, 'day cap');
  if (
    input.limits.sessionAtomic < input.limits.perCallAtomic ||
    input.limits.hourAtomic < input.limits.perCallAtomic ||
    input.limits.dayAtomic < input.limits.perCallAtomic
  )
    throw new PaymentPolicyRejected('aggregate caps cannot be below the per-call cap');
  if (!Number.isSafeInteger(input.sessionDurationMs) || input.sessionDurationMs <= 0)
    throw new PaymentPolicyRejected('session duration is invalid');
  if (!Number.isSafeInteger(input.reservationTtlMs) || input.reservationTtlMs < 1_000)
    throw new PaymentPolicyRejected('reservation TTL is invalid');
  if (
    !Number.isSafeInteger(input.maximumAuthorizationSeconds) ||
    input.maximumAuthorizationSeconds <= 0
  )
    throw new PaymentPolicyRejected('authorization lifetime is invalid');
  if (!Number.isSafeInteger(input.maximumOutputTokens) || input.maximumOutputTokens <= 0)
    throw new PaymentPolicyRejected('maximum output tokens is invalid');
  if (typeof input.requirePerCallConfirmation !== 'boolean')
    throw new PaymentPolicyRejected('per-call confirmation policy is invalid');

  const recipients = Object.freeze(
    [
      ...new Set(input.recipients.map((value) => normalizedAddress(value, UnexpectedRecipient))),
    ].sort(),
  );
  const models = Object.freeze([...new Set(input.models)].sort());
  const delegationIds = new Set<string>();
  const delegations = Object.freeze(
    [...(input.delegations ?? [])]
      .map((delegation) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(delegation.agentId))
          throw new PaymentPolicyRejected('delegation agent ID is invalid');
        if (delegationIds.has(delegation.agentId))
          throw new PaymentPolicyRejected('delegation agent IDs must be unique');
        delegationIds.add(delegation.agentId);
        positiveAtomic(delegation.maximumAtomic, 'delegation cap');
        return Object.freeze({
          agentId: delegation.agentId,
          maximumAtomic: delegation.maximumAtomic,
          ...(delegation.revoked === undefined ? {} : { revoked: delegation.revoked }),
        });
      })
      .sort((left, right) => left.agentId.localeCompare(right.agentId)),
  );
  const normalized: BuyerPolicy = {
    canonicalOrigin: origin,
    network: input.network,
    asset: normalizedAddress(input.asset, UnexpectedAsset),
    recipients,
    schemes: Object.freeze([input.schemes[0]] as ['exact'] | ['upto']),
    models,
    delegations,
    limits: Object.freeze({ ...input.limits }),
    sessionDurationMs: input.sessionDurationMs,
    reservationTtlMs: input.reservationTtlMs,
    maximumAuthorizationSeconds: input.maximumAuthorizationSeconds,
    maximumOutputTokens: input.maximumOutputTokens,
    requirePerCallConfirmation: input.requirePerCallConfirmation,
  };
  return Object.freeze({ ...normalized, hash: canonicalHash(normalized) });
}

/** Rebuild and hash-check an object crossing an admin or process boundary. */
export function validateEffectiveBuyerPolicy(input: EffectiveBuyerPolicy): EffectiveBuyerPolicy {
  const normalized = createBuyerPolicy(input);
  if (normalized.hash !== input.hash)
    throw new PaymentPolicyRejected('effective buyer policy hash does not match its contents');
  return normalized;
}

function isSubset(next: readonly string[], current: readonly string[]): boolean {
  return next.every((value) => current.includes(value));
}

/** True only when next cannot authorize anything outside the immutable envelope. */
export function isPolicyRestriction(
  envelope: EffectiveBuyerPolicy,
  next: EffectiveBuyerPolicy,
): boolean {
  if (
    envelope.canonicalOrigin !== next.canonicalOrigin ||
    envelope.network !== next.network ||
    envelope.asset.toLowerCase() !== next.asset.toLowerCase() ||
    !isSubset(next.schemes, envelope.schemes) ||
    !isSubset(
      next.recipients.map((value) => value.toLowerCase()),
      envelope.recipients.map((value) => value.toLowerCase()),
    ) ||
    !isSubset(next.models, envelope.models) ||
    next.limits.perCallAtomic > envelope.limits.perCallAtomic ||
    next.limits.sessionAtomic > envelope.limits.sessionAtomic ||
    next.limits.hourAtomic > envelope.limits.hourAtomic ||
    next.limits.dayAtomic > envelope.limits.dayAtomic ||
    next.sessionDurationMs > envelope.sessionDurationMs ||
    next.reservationTtlMs > envelope.reservationTtlMs ||
    next.maximumAuthorizationSeconds > envelope.maximumAuthorizationSeconds ||
    next.maximumOutputTokens > envelope.maximumOutputTokens ||
    (envelope.requirePerCallConfirmation && !next.requirePerCallConfirmation)
  )
    return false;

  const envelopeDelegations = new Map(
    (envelope.delegations ?? []).map((delegation) => [delegation.agentId, delegation]),
  );
  if (envelopeDelegations.size > 0 && !next.delegations) return false;
  return (next.delegations ?? []).every((delegation) => {
    const previous = envelopeDelegations.get(delegation.agentId);
    if (!previous) return envelopeDelegations.size === 0;
    return (
      delegation.maximumAtomic <= previous.maximumAtomic &&
      !(previous.revoked === true && delegation.revoked !== true)
    );
  });
}

export function validatePaymentRequirement(
  declaration: unknown,
  policy: EffectiveBuyerPolicy,
  requestUrl: string,
  model: string,
): ValidatedPaymentRequirement {
  // The official validator currently exposes a structurally equivalent inferred
  // Zod type whose optional-property annotations are narrower than the public
  // PaymentRequired interface under exactOptionalPropertyTypes.
  const paymentRequired = validatePaymentRequired(declaration) as PaymentRequired;
  if (paymentRequired.x402Version !== 2) throw new PaymentPolicyRejected('x402 v2 is required');
  const requested = new URL(requestUrl);
  if (requested.origin !== policy.canonicalOrigin)
    throw new PaymentPolicyRejected('request origin is outside the approved policy');
  if (paymentRequired.resource.url !== requestUrl)
    throw new PaymentPolicyRejected('challenge resource does not match the requested URL');
  if (!policy.models.includes(model))
    throw new PaymentPolicyRejected('model is outside the approved policy');
  if (paymentRequired.accepts.length !== 1)
    throw new PaymentPolicyRejected('challenge must advertise exactly one payment option');

  const networkCandidates = paymentRequired.accepts.filter(
    (candidate) => candidate.network === policy.network,
  );
  if (networkCandidates.length === 0) throw new UnsupportedNetwork();
  const approvedScheme = policy.schemes[0];
  if (approvedScheme !== 'exact')
    throw new PaymentPolicyRejected(
      'legacy upto profiles cannot spend; run onchain-router policy set --scheme exact',
    );
  const schemeCandidates = networkCandidates.filter((candidate) => candidate.scheme === 'exact');
  if (schemeCandidates.length === 0) {
    const advertisedSchemes = [
      ...new Set(networkCandidates.map((candidate) => candidate.scheme)),
    ].sort();
    throw new PaymentPolicyRejected(
      `profile requires exact but this resource advertises ${advertisedSchemes.join(', ')}`,
    );
  }
  const assetCandidates = schemeCandidates.filter(
    (candidate) => candidate.asset.toLowerCase() === policy.asset.toLowerCase(),
  );
  if (assetCandidates.length === 0) throw new UnexpectedAsset();
  const recipientCandidates = assetCandidates.filter((candidate) =>
    policy.recipients.some(
      (recipient) => recipient.toLowerCase() === candidate.payTo.toLowerCase(),
    ),
  );
  if (recipientCandidates.length === 0) throw new UnexpectedRecipient();
  const requirement = recipientCandidates[0];
  if (!requirement) throw new PaymentPolicyRejected();
  if (!/^\d+$/.test(requirement.amount))
    throw new PaymentPolicyRejected('authorization amount is not an integer');
  const amountAtomic = BigInt(requirement.amount);
  if (amountAtomic <= 0n || amountAtomic > MAX_SQLITE_INTEGER)
    throw new PaymentPolicyRejected('authorization amount is outside the supported integer range');
  if (amountAtomic > policy.limits.perCallAtomic) throw new AuthorizationAboveLocalCap();
  if (requirement.maxTimeoutSeconds > policy.maximumAuthorizationSeconds)
    throw new PaymentPolicyRejected('authorization lifetime exceeds local policy');
  const extra = requirement.extra;
  const extraKeys = extra && typeof extra === 'object' ? Object.keys(extra).sort() : [];
  if (
    !extra ||
    extra['name'] !== 'USD Coin' ||
    extra['version'] !== '2' ||
    extraKeys.join(',') !== ['name', 'version'].sort().join(',')
  )
    throw new PaymentPolicyRejected('challenge has invalid Base USDC EIP-712 metadata');

  return {
    paymentRequired,
    requirement,
    requirementHash: canonicalHash(requirement),
    amountAtomic,
    resourceUrl: paymentRequired.resource.url,
  };
}
