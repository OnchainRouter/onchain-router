export type BuyerOutcomeCode =
  | 'PaymentPolicyRejected'
  | 'UnsupportedNetwork'
  | 'UnexpectedAsset'
  | 'UnexpectedRecipient'
  | 'AuthorizationAboveLocalCap'
  | 'InsufficientFunds'
  | 'PaymentVerificationRejected'
  | 'ProviderOutcomeUnknown'
  | 'SettlementOutcomeUnknown'
  | 'IdempotencyConflict'
  | 'ResultRecoveryExpired'
  | 'ReceiptVerificationFailed'
  | 'WalletLocked'
  | 'RuntimeUnavailable';

export type RetryDirective =
  | 'do_not_retry'
  | 'retry_unpaid_request'
  | 'retry_same_idempotency_key'
  | 'unlock_wallet'
  | 'human_review';

export class BuyerRuntimeError extends Error {
  public constructor(
    public readonly code: BuyerOutcomeCode,
    public readonly retry: RetryDirective,
    message: string,
    public readonly reference?: string,
  ) {
    super(message);
    this.name = code;
  }
}

function defineError(
  code: BuyerOutcomeCode,
  retry: RetryDirective,
): new (message?: string, reference?: string) => BuyerRuntimeError {
  return class extends BuyerRuntimeError {
    public constructor(message: string = code, reference?: string) {
      super(code, retry, message, reference);
      this.name = code;
    }
  };
}

export const PaymentPolicyRejected = defineError('PaymentPolicyRejected', 'do_not_retry');
export const UnsupportedNetwork = defineError('UnsupportedNetwork', 'do_not_retry');
export const UnexpectedAsset = defineError('UnexpectedAsset', 'do_not_retry');
export const UnexpectedRecipient = defineError('UnexpectedRecipient', 'do_not_retry');
export const AuthorizationAboveLocalCap = defineError('AuthorizationAboveLocalCap', 'do_not_retry');
export const InsufficientFunds = defineError('InsufficientFunds', 'retry_unpaid_request');
export const PaymentVerificationRejected = defineError(
  'PaymentVerificationRejected',
  'retry_unpaid_request',
);
export const ProviderOutcomeUnknown = defineError('ProviderOutcomeUnknown', 'human_review');
export const SettlementOutcomeUnknown = defineError('SettlementOutcomeUnknown', 'human_review');
export const IdempotencyConflict = defineError('IdempotencyConflict', 'do_not_retry');
export const ResultRecoveryExpired = defineError('ResultRecoveryExpired', 'do_not_retry');
export const ReceiptVerificationFailed = defineError(
  'ReceiptVerificationFailed',
  'retry_same_idempotency_key',
);
export const WalletLocked = defineError('WalletLocked', 'unlock_wallet');
export const RuntimeUnavailable = defineError('RuntimeUnavailable', 'retry_same_idempotency_key');

export function asBuyerRuntimeError(error: unknown): BuyerRuntimeError {
  if (error instanceof BuyerRuntimeError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('insufficient') && (message.includes('balance') || message.includes('fund')))
    return new InsufficientFunds();
  return new RuntimeUnavailable();
}
