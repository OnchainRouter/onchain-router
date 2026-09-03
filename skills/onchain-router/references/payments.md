# Payment and receipt semantics

HTTP 402 is the expected first response inside Buyer Runtime. The local CLI, SDKs, MCP, proxy, and skill delegate requirement validation, official x402 signing, identical-body retry, durable recovery, and receipt verification to that one implementation. Do not parse, sign, or retry the challenge again in an adapter.

An empty, incomplete, or malformed unsigned JSON probe can receive an inspection-only 402. Do not sign it. Submit a valid request body and let Buyer Runtime obtain and validate the request-specific challenge before authorizing payment.

A caller that already uses the public HTTP API directly must use reviewed official x402 primitives, validate the live requirement, and preserve the identical body and idempotency identity. The portable skill no longer supplies an independent direct-payment runtime.

The supported payment network is Base mainnet (`eip155:8453`), and settlement uses USDC through the official x402 v2 `exact` EIP-3009 scheme. An ordinary payment requires Base USDC only, not Base ETH or a token approval.

The exact amount is request-specific: text prices a conservative input estimate plus 10% of `max_tokens`, TTS uses validated character length, STT uses locally inspected audio duration, and image generation uses the selected specification price. The published minimum and fixed fee apply. Provider-reported usage remains receipt and cost-control evidence; it does not create a later refund.

Return the settlement amount from the standard `PAYMENT-RESPONSE`, plus `X-Receipt-ID` and transaction hash. Confirm that it agrees with the signed exact amount.

The payment transaction proves settlement. The usage portion of the receipt is an Onchain Router attestation based on normalized provider usage.
