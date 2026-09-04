# Choose an Onchain Router entry point

<!-- Generated from scripts/fixtures/agent-entrypoints.v1.json by scripts/generate-agent-entry-docs.mjs. -->

> This public source release targets npm adapter version `0.1.3`. Review `/docs/installation`, `/products.json`, the live `latest` dist-tag, and registry provenance before installing. Package availability does not grant permission to create, import, fund, unlock, or spend from a wallet.

## Choose one primary path

| Use                      | Choose it when                                                                                       | Current capability categories                                     | Authority boundary                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Focused MCP              | The agent host supports local stdio MCP and should receive narrow native tools.                      | text_generation, image_generation, text_to_speech, speech_to_text | Nine bounded tools; every payment uses the shared Buyer Runtime.                                           |
| Loopback proxy           | An OpenAI-compatible client can set a local base URL and API key but cannot perform x402.            | text_generation, image_generation, text_to_speech, speech_to_text | Authenticated loopback, five non-streaming paid JSON routes; speech returns hosted JSON, not binary audio. |
| TypeScript or Python SDK | Application code needs typed discovery, all paid JSON endpoints, recovery, and receipts.             | text_generation, image_generation, text_to_speech, speech_to_text | Calls an already-unlocked Buyer Runtime and has no wallet-secret constructor.                              |
| Buyer CLI                | A human is setting up, unlocking, funding, changing policy, diagnosing, or running shell automation. | text_generation, image_generation, text_to_speech, speech_to_text | Human wallet authority plus bounded JSON media and explicit owned-file MP3 upload.                         |
| Portable Agent Skill     | The agent host supports portable skills and can invoke an installed local Buyer CLI.                 | text_generation, image_generation, text_to_speech, speech_to_text | Thin CLI-only workflows; no independent wallet or payment implementation.                                  |

All five adapters expose all five paid JSON endpoints. Media uses live model/option validation and the same durable buyer lifecycle. MCP provides nine narrow tools: discovery, chat, messages, images, speech, transcriptions, voices, wallet status, and receipt lookup. MCP limits MP3 Base64 to 1,048,576 characters; portable skill JSON is bounded to 1,000,000 bytes. CLI/SDK/proxy accept at most 25 MiB decoded MP3. The CLI explicit-file path rejects symlinks, special files, non-owned files, and changed files. Speech-to-text requires human permission for provider-retained audio/transcript processing and local `acknowledge_provider_retention: true`; the SDK removes that flag before sending the API request. Images default to hosted URLs. The proxy returns hosted speech JSON, not OpenAI binary audio, and does not yet support multipart transcription. Do not claim those transport forms work.

## One shared contract

- Canonical origin: `https://onchainrouter.dev`.
- Network: Base mainnet `eip155:8453`.
- Asset: official Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Models and prices: always read `/v1/models` and `/v1/pricing`; never copy a price or assume an alias remains enabled.
- Paid endpoints: `/v1/chat/completions`, `/v1/messages`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`.
- Example text model at generation time: `gemini-3.6-flash`. Confirm it against live discovery before a call.
- Idempotency: create one stable key before the unpaid request and retain it through signing, recovery, and receipt lookup.
- Inspection: empty, incomplete, or malformed unsigned JSON returns a discovery-only 402. Do not sign an inspection challenge; submit a valid body to obtain the request-specific exact price first.
- Success: return `ok`, `outcome`, `idempotencyKey`, `body`, `receipt`, `payment`.
- Failure: return `ok`, `outcome`, `retry`, `idempotencyKey`, `message`, `reference` without secret-bearing diagnostics.

Every adapter delegates wallet custody, integer-atomic budgets, official x402 payment, ambiguity, recovery, and receipt verification to Buyer Runtime. None may contain a second signer or payment implementation.

The private loopback proxy additionally reuses eligible identical text answers within one wallet/agent/session/policy/catalog for up to ten minutes in bounded memory. Explicit idempotency keys bypass this cache and retain the durable recovery path; keep using them when recovery is required. A cache hit is the proxy-only outcome `CachedResponse`, with `x-onchain-router-cache: HIT`, `x-onchain-router-charge-atomic: 0`, the original source idempotency key, and `x-onchain-router-source-receipt-id`. It is not a new Buyer Runtime success, receipt, or settlement; body usage refers to the original inference. Ordinary payment/receipt headers are omitted on hits. Use `Cache-Control: no-cache` to refresh, `Cache-Control: no-store` or JSON `cache: false` / `no_cache: true` to bypass, or proxy `--no-cache` to disable. Tools/media are excluded. Direct SDK/CLI/MCP/public API and provider cached-token pricing are unchanged.

## Human-owned setup

The following actions are human-only and must run in a direct terminal:

- wallet create or import
- wallet unlock
- funding
- legacy `upto` to `exact` policy migration
- policy widening
- confirmation-policy changes
- backup or restore
- key rotation
- wallet export or exit

Do not send a wallet key, seed phrase, passphrase, broker capability, payment payload, or receipt capability through an agent tool, prompt, environment value, or HTTP request.

Repository-built preview commands are:

| Entry point              | Artifact                                      | Inspect or start                                       |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| Focused MCP              | `@agenticfi/onchain-router-mcp`               | `node apps/buyer-mcp/dist/index.js --print-config`     |
| Loopback proxy           | `@agenticfi/onchain-router-proxy`             | `node apps/buyer-proxy/dist/index.js --print-config`   |
| TypeScript or Python SDK | `@agenticfi/onchain-router or onchain-router` | `OnchainRouterBuyer.connect() or OnchainRouterBuyer()` |
| Buyer CLI                | `@agenticfi/onchain-router-cli`               | `onchain-router help`                                  |
| Portable Agent Skill     | `skills/onchain-router`                       | `node scripts/models.mjs`                              |

Publication commands are deliberately absent. Source checkout commands are evidence for private review, not a public installation promise.

## Stable outcomes

| Outcome                       | Retry directive              |
| ----------------------------- | ---------------------------- |
| `PaymentPolicyRejected`       | `do_not_retry`               |
| `UnsupportedNetwork`          | `do_not_retry`               |
| `UnexpectedAsset`             | `do_not_retry`               |
| `UnexpectedRecipient`         | `do_not_retry`               |
| `AuthorizationAboveLocalCap`  | `do_not_retry`               |
| `InsufficientFunds`           | `retry_unpaid_request`       |
| `PaymentVerificationRejected` | `retry_unpaid_request`       |
| `ProviderOutcomeUnknown`      | `human_review`               |
| `SettlementOutcomeUnknown`    | `human_review`               |
| `IdempotencyConflict`         | `do_not_retry`               |
| `ResultRecoveryExpired`       | `do_not_retry`               |
| `ReceiptVerificationFailed`   | `retry_same_idempotency_key` |
| `WalletLocked`                | `unlock_wallet`              |
| `RuntimeUnavailable`          | `retry_same_idempotency_key` |

`ProviderOutcomeUnknown` and `SettlementOutcomeUnknown` always require human review. A `retry_same_idempotency_key` directive means identical request and identical key; it never authorizes a fresh logical request. `WalletLocked` requires a direct human unlock.

## Receipt and output

Return the requested content, selected model, normalized usage, signed exact atomic USDC amount, Base network, transaction, and verified receipt. Hosted media URLs are bearer capabilities: disclose their expiry but avoid logs or public messages containing the complete URL. A receipt proves Onchain Router's settlement and attested usage; it is not an upstream-provider attestation.
