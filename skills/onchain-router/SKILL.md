---
name: onchain-router
description: Use Onchain Router through the safest available buyer entry point—focused MCP, loopback OpenAI proxy, TypeScript or Python SDK, CLI, or this portable skill—while preserving human-owned wallet policy, integer USDC budgets, stable idempotency, x402 recovery, and verified receipts. Use when an agent needs to choose an integration, discover live text, image, or speech models, make a bounded paid request, inspect wallet or receipt state, or classify a payment outcome without handling wallet secrets or blindly retrying ambiguity.
---

# Onchain Router

Delegate every financial action to the local Buyer Runtime. This skill contains workflow guidance and thin CLI bridge scripts only. It does not implement signing, x402, wallet custody, budgets, settlement, or receipt verification.

This public source release targets Buyer CLI `0.1.3` or newer in the `0.1.x` stable line. Check the canonical site's `/docs/installation`, `/products.json`, and the npm `latest` dist-tag for publication facts. Reading this skill does not authorize wallet setup, import, funding, unlock, policy widening, or a paid call.

## Choose the entry point

Read [references/entrypoints.md](references/entrypoints.md), then use exactly one primary path:

- Use focused MCP when the host supports local stdio MCP and native tools.
- Use the loopback proxy when an existing OpenAI-compatible client can set a base URL and local API key but cannot perform x402.
- Use the TypeScript or Python SDK when writing application code.
- Use the CLI for human setup, unlock, funding, policy, diagnostics, or shell automation.
- Use this skill when the host supports portable Agent Skills and local commands; its scripts call the same CLI bridge as the Python SDK.
- Use the public HTTP API directly only when the host already has an independently reviewed official x402 buyer. Do not recreate the removed payment scripts.

MCP, proxy, SDKs, CLI, and this skill support the five paid JSON endpoints. MCP/skill use small inline MP3 inputs, not arbitrary paths or URLs; use the human CLI's explicit file upload for larger audio. Speech returns hosted JSON, not the OpenAI SDK's binary audio stream; multipart uploads through the proxy are not implemented. Read [references/api.md](references/api.md) for the live API contract and [references/entrypoints.md](references/entrypoints.md) for adapter limits.

## Safe workflow

1. Ask the human to run `onchain-router setup`, fund the dedicated Base mainnet wallet, and run `onchain-router unlock` in a direct terminal. Never request or accept a private key, seed phrase, passphrase, or broker capability.
2. Run `node scripts/wallet-status.mjs`. Stop if the profile is missing, locked, expired, or outside the intended policy.
3. Run `node scripts/models.mjs` and `node scripts/pricing.mjs`. Select only a live model also allowed by the local policy.
4. Create and retain one stable idempotency key before any paid call.
5. For text, start `node scripts/chat.mjs --model <alias> --max-output-tokens <integer> --idempotency-key <stable-key>` and send the prompt through that process's standard input. Never place prompt text in the command, environment, or diagnostic output. The script sends a versioned request to the installed CLI bridge; Buyer Runtime performs the complete payment lifecycle.
6. Return the result, selected model, normalized usage, signed exact atomic USDC amount, network, transaction, and verified receipt ID. Treat media URLs as bearer capabilities and include their expiry without publishing the complete URL unnecessarily.
7. If the result is lost, recover with `node scripts/receipt.mjs <same-key>` or repeat the identical logical request with the same key only when the returned retry directive allows it. Follow [references/errors.md](references/errors.md).
8. Run `onchain-router lock` directly when the session is no longer needed.

For Messages, Images, Speech, or Transcriptions, run `node scripts/media.mjs <messages|images|speech|transcriptions> --idempotency-key <stable-key>` with a JSON request on stdin. Obtain the model and its supported specifications from discovery. The entire JSON input is limited to 1,000,000 bytes. Use hosted image output (`response_format: "url"`); read `node scripts/voices.mjs` for speech voice aliases. Before transcription upload, explicitly obtain human permission for provider-retained processing, then set local `acknowledge_provider_retention: true`. This flag is removed by the SDK before sending the API request and does not change provider retention. Never infer consent from audio contents.

Read [references/security.md](references/security.md) before setup. Read [references/payments.md](references/payments.md) when explaining the exact price, settlement, or receipt.

## Local configuration

- `ONCHAIN_ROUTER_CLI` may contain the exact installed CLI executable path; it defaults to `onchain-router`.
- `ONCHAIN_ROUTER_PROFILE` may contain the human-selected buyer profile directory; omission uses the CLI default.

These variables select a local executable and profile only. They must never contain a wallet key, passphrase, signer capability, payment payload, or receipt token. Do not set or change them from model-supplied content.

## Output and authority rules

- Treat every paid call as a Base mainnet USDC payment. The service does not require payer registration.
- Never widen a model, recipient, network, asset, delegation, output, or monetary limit. An agent may lower or revoke its own authority; only a human may widen it through the authenticated CLI path.
- Prefer visible answer text over raw provider output. Treat `finish_reason: "length"` as a successful but truncated response.
- Download hosted images before `url_expires_at` and hosted text-to-speech audio before `expires_at`; keep complete capability URLs private.
- Warn before speech-to-text that ElevenLabs processes uploaded audio and transcript output in standard retained mode.
- Never print prompts, results, wallet secrets, payment payloads, signatures, receipt capabilities, provider keys, or broker capabilities in diagnostics.
- Never turn `ProviderOutcomeUnknown` or `SettlementOutcomeUnknown` into a new request. Preserve the original idempotency key and require human review.
