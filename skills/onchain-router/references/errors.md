# Error and retry policy

All local adapters return the Buyer Runtime outcome plus a retry directive. Correct malformed input or local policy deliberately; do not infer retry safety from HTTP status alone. Treat HTTP 402 inside Buyer Runtime as the normal authorization step, not an error exposed for an adapter to reimplement.

Stop on `AuthorizationAboveLocalCap` or `PaymentPolicyRejected`. Reduce the request only when it remains within the existing human-owned model, output, recipient, and monetary envelope; an agent may not widen policy. Hourly, daily, session, and delegation exhaustion require reset or operator review.

Retry `empty_provider_response` only after increasing `max_tokens`; the known unusable inference is not customer-settled. Treat `finish_reason: "length"` as a paid, valid, truncated response rather than an error.

Never create a new paid request after `provider_outcome_unknown`, `settlement_unknown`, a post-authorization timeout, or a lost connection. Retry the identical request with the same idempotency identity to recover durable state, then wait for receipt/reconciliation or operator resolution.

HTTP 409 means an idempotency key was reused with a different effective request. Do not override it.

The stable local outcomes are `PaymentPolicyRejected`, `UnsupportedNetwork`, `UnexpectedAsset`, `UnexpectedRecipient`, `AuthorizationAboveLocalCap`, `InsufficientFunds`, `PaymentVerificationRejected`, `ProviderOutcomeUnknown`, `SettlementOutcomeUnknown`, `IdempotencyConflict`, `ResultRecoveryExpired`, `ReceiptVerificationFailed`, `WalletLocked`, and `RuntimeUnavailable`. `ProviderOutcomeUnknown` and `SettlementOutcomeUnknown` always require human review. `WalletLocked` requires direct human unlock. A `retry_same_idempotency_key` directive never authorizes changing the request or generating a new key.
