import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { BuyerOutcomeCode, RetryDirective } from './errors.js';

export const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

export interface LocalSpendLimits {
  readonly perCallAtomic: bigint;
  readonly sessionAtomic: bigint;
  readonly hourAtomic: bigint;
  readonly dayAtomic: bigint;
}

export interface AgentDelegation {
  readonly agentId: string;
  readonly maximumAtomic: bigint;
  readonly revoked?: boolean;
}

export interface BuyerPolicy {
  readonly canonicalOrigin: string;
  readonly network: `eip155:${number}`;
  readonly asset: `0x${string}`;
  readonly recipients: readonly `0x${string}`[];
  /** One explicitly approved x402 scheme. New profiles default to exact. */
  readonly schemes: readonly ['exact'] | readonly ['upto'];
  readonly models: readonly string[];
  readonly limits: LocalSpendLimits;
  readonly delegations?: readonly AgentDelegation[];
  readonly sessionDurationMs: number;
  readonly reservationTtlMs: number;
  readonly maximumAuthorizationSeconds: number;
  readonly maximumOutputTokens: number;
  readonly requirePerCallConfirmation: boolean;
}

export interface EffectiveBuyerPolicy extends BuyerPolicy {
  readonly hash: string;
}

export interface BuyerRequest {
  readonly url: string;
  readonly body: unknown;
  readonly model: string;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ValidatedPaymentRequirement {
  readonly paymentRequired: PaymentRequired;
  readonly requirement: PaymentRequirements;
  readonly requirementHash: string;
  readonly amountAtomic: bigint;
  readonly resourceUrl: string;
}

export interface PaymentConfirmation {
  readonly origin: string;
  readonly model: string;
  readonly network: string;
  readonly asset: string;
  readonly recipient: string;
  readonly scheme: 'exact' | 'upto';
  readonly maximumAtomic: string;
}

export interface BrokerAuthorizationRequest {
  readonly paymentRequired: PaymentRequired;
  readonly requestUrl: string;
  readonly model: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requirementHash: string;
  readonly agentId: string;
  readonly sessionId: string;
}

export interface PaymentAuthorizer {
  readonly address: `0x${string}`;
  /** Human-selected delegation identity bound to this broker capability. */
  readonly agentId: string;
  /** Broker-generated identity; adapters cannot reset the session budget. */
  readonly sessionId: string;
  authorize(request: BrokerAuthorizationRequest): Promise<PaymentPayload>;
}

export interface Permit2Status {
  readonly object: 'permit2_status';
  readonly network: `eip155:${number}`;
  readonly owner: `0x${string}`;
  readonly asset: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly allowanceAtomic: string;
  readonly requiredAtomic: string;
  readonly approved: boolean;
  readonly nativeBalanceWei: string;
}

export interface Permit2ApprovalResult extends Omit<Permit2Status, 'object'> {
  readonly object: 'permit2_approval';
  readonly outcome: 'already_approved' | 'approved';
  readonly transactionHash?: `0x${string}`;
}

export interface VerifiedReceipt {
  readonly id: string;
  readonly operationId: string;
  readonly catalogVersion: string | null;
  readonly model: string | null;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly settlement: {
    readonly success: true;
    readonly transaction: string;
    readonly network: string;
    readonly payer: string;
  };
  readonly maximumAmount: string;
  readonly actualAmount: string;
}

export interface BuyerSuccess {
  readonly ok: true;
  readonly outcome: 'Completed' | 'RecoveredSuccess';
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly receipt: VerifiedReceipt;
  readonly payment: {
    readonly network: string;
    readonly asset: string;
    readonly recipient: string;
    readonly authorizedMaximumAtomic: string;
    readonly actualAtomic: string;
    readonly transaction: string;
  };
}

export interface BuyerFailure {
  readonly ok: false;
  readonly outcome: BuyerOutcomeCode;
  readonly retry: RetryDirective;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly reference?: string;
}

export type BuyerResult = BuyerSuccess | BuyerFailure;

export interface LocalOperation {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requirementHash: string;
  readonly model: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly maximumAtomic: bigint;
  readonly actualAtomic: bigint | null;
  readonly state: 'reserved' | 'signing' | 'authorized' | 'spent' | 'released' | 'unknown';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reservationExpiresAt: number;
  readonly receipt: VerifiedReceipt | null;
  readonly policyHash: string;
}

export interface LocalSpendSummary {
  readonly sessionAtomic: bigint;
  readonly hourAtomic: bigint;
  readonly dayAtomic: bigint;
  readonly delegationAtomic: bigint | null;
}

export interface ReservationInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requirementHash: string;
  readonly model: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly maximumAtomic: bigint;
  readonly now: number;
}
