# Payment and receipt semantics

HTTP 402 is the expected first response inside Buyer Runtime. The local CLI, SDKs, MCP, proxy, and skill delegate requirement validation, official x402 signing, identical-body retry, durable recovery, and receipt verification to that one implementation. Do not parse, sign, or retry the challenge again in an adapter.

A caller that already uses the public HTTP API directly must use reviewed official x402 primitives, validate the live requirement, and preserve the identical body and idempotency identity. The portable skill no longer supplies an independent direct-payment runtime.

The supported payment network is Base mainnet (`eip155:8453`), and settlement uses USDC.

The authorization maximum is request-specific: text reserves output through `max_tokens`, TTS uses a conservative character bound, STT uses locally inspected audio duration, and image generation uses the selected specification price. Actual settlement uses normalized token, character, or audio-duration usage—or the successful image price—plus cataloged fees and the disclosed minimum. It never exceeds the signed maximum.

Return the settlement amount from the standard `PAYMENT-RESPONSE`, plus `X-Receipt-ID` and transaction hash. Do not treat the quote or maximum as the actual charge.

The payment transaction proves settlement. The usage portion of the receipt is an Onchain Router attestation based on normalized provider usage.
