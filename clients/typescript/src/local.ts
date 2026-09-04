import {
  BuyerRuntimeError,
  PaymentPolicyRejected,
  type EffectiveBuyerPolicy,
  type VerifiedReceipt,
} from '@onchainrouter/buyer-core';
import { LocalSpendLedger, WalletVault, pathExists } from '@onchainrouter/buyer-core/admin';
import { OnchainRouterBuyer, type BuyerStatus, type OnchainRouterBuyerOptions } from './buyer.js';
import {
  OnchainRouterDiscovery,
  type ModelCatalog,
  type PricingCatalog,
  type WalletBalance,
} from './discovery.js';
import { buyerProfilePaths } from './profile.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SerializedBuyerPolicy {
  readonly canonicalOrigin: string;
  readonly network: string;
  readonly asset: string;
  readonly recipients: readonly string[];
  readonly schemes: readonly string[];
  readonly models: readonly string[];
  readonly limits: {
    readonly perCallAtomic: string;
    readonly sessionAtomic: string;
    readonly hourAtomic: string;
    readonly dayAtomic: string;
  };
  readonly delegations: ReadonlyArray<{
    readonly agentId: string;
    readonly maximumAtomic: string;
    readonly revoked: boolean;
  }>;
  readonly sessionDurationMs: number;
  readonly reservationTtlMs: number;
  readonly maximumAuthorizationSeconds: number;
  readonly maximumOutputTokens: number;
  readonly requirePerCallConfirmation: boolean;
  readonly hash: string;
}

export interface BuyerProfileInspection {
  readonly initialized: boolean;
  readonly locked: boolean;
  readonly profileDirectory: string;
  readonly address: string | null;
  readonly agentId: string | null;
  readonly idleExpiresAt: number | null;
  readonly absoluteExpiresAt: number | null;
  readonly policy: SerializedBuyerPolicy | null;
  readonly spend: BuyerStatus['spend'] | null;
  readonly balance: WalletBalance | null;
  readonly balanceStatus: 'available' | 'unavailable' | 'not_initialized' | 'not_requested';
}

export interface BuyerCatalogInspection {
  readonly models: ModelCatalog;
  readonly pricing: PricingCatalog;
  readonly policy: SerializedBuyerPolicy;
}

export interface InspectBuyerProfileOptions extends OnchainRouterBuyerOptions {
  readonly includeBalance?: boolean;
}

export function serializeBuyerPolicy(policy: EffectiveBuyerPolicy): SerializedBuyerPolicy {
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

/**
 * Read the non-secret local buyer state needed by thin agent adapters.
 *
 * This does not unlock a wallet, return broker authentication material, or mutate policy. A
 * malformed session descriptor remains a hard error instead of being presented
 * as an ordinary locked wallet.
 */
export async function inspectBuyerProfile(
  options: InspectBuyerProfileOptions = {},
): Promise<BuyerProfileInspection> {
  const paths = buyerProfilePaths(options.profileDirectory);
  const wallet = await new WalletVault({ directory: paths.walletDirectory }).status();
  if (!wallet.initialized || !wallet.address) {
    return {
      initialized: false,
      locked: true,
      profileDirectory: paths.directory,
      address: null,
      agentId: null,
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      policy: null,
      spend: null,
      balance: null,
      balanceStatus: 'not_initialized',
    };
  }
  if (!(await pathExists(paths.ledgerPath)))
    throw new PaymentPolicyRejected('buyer profile has no authoritative spend ledger');

  const ledger = new LocalSpendLedger(paths.ledgerPath);
  let policy: EffectiveBuyerPolicy;
  try {
    policy = ledger.currentPolicy();
  } finally {
    ledger.close();
  }

  let locked = true;
  let active: BuyerStatus | null = null;
  try {
    const buyer = await OnchainRouterBuyer.connect(options);
    try {
      active = await buyer.status();
      locked = false;
    } finally {
      buyer.close();
    }
  } catch (error) {
    if (!(error instanceof BuyerRuntimeError) || error.code !== 'WalletLocked') throw error;
  }

  if (active && active.address.toLowerCase() !== wallet.address.toLowerCase())
    throw new PaymentPolicyRejected('buyer broker address does not match the encrypted wallet');

  let balance: WalletBalance | null = null;
  let balanceStatus: BuyerProfileInspection['balanceStatus'] = 'not_requested';
  if (options.includeBalance !== false) {
    balanceStatus = 'unavailable';
    try {
      balance = await new OnchainRouterDiscovery(policy.canonicalOrigin, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }).balance(wallet.address);
      balanceStatus = 'available';
    } catch (error) {
      if (!(error instanceof BuyerRuntimeError)) throw error;
    }
  }

  return {
    initialized: true,
    locked,
    profileDirectory: paths.directory,
    address: wallet.address,
    agentId: active?.agentId ?? null,
    idleExpiresAt: active?.idleExpiresAt ?? null,
    absoluteExpiresAt: active?.absoluteExpiresAt ?? null,
    policy: serializeBuyerPolicy(policy),
    spend: active?.spend ?? null,
    balance,
    balanceStatus,
  };
}

/** Return the live public catalog together with the local policy that constrains its use. */
export async function inspectBuyerCatalog(
  options: OnchainRouterBuyerOptions = {},
): Promise<BuyerCatalogInspection> {
  const paths = buyerProfilePaths(options.profileDirectory);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  let policy: EffectiveBuyerPolicy;
  try {
    policy = ledger.currentPolicy();
  } finally {
    ledger.close();
  }
  const discovery = new OnchainRouterDiscovery(policy.canonicalOrigin, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const [models, pricing] = await Promise.all([discovery.models(), discovery.pricing()]);
  return { models, pricing, policy: serializeBuyerPolicy(policy) };
}

/** Retrieve a receipt already verified and committed by Buyer Runtime. */
export function readBuyerReceipt(
  idempotencyKey: string,
  options: Pick<OnchainRouterBuyerOptions, 'profileDirectory'> = {},
): VerifiedReceipt | null {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey))
    throw new PaymentPolicyRejected('idempotency key is invalid');
  const paths = buyerProfilePaths(options.profileDirectory);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    return ledger.receipt(idempotencyKey);
  } finally {
    ledger.close();
  }
}
