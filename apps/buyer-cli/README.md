# Onchain Router CLI

Create a dedicated buyer wallet, set USDC budgets, unlock a short-lived signer, discover live AI
models, pay x402 challenges, recover lost responses, and inspect verified receipts from one
terminal command: `onchain-router`.

The CLI is the supported human-authority surface for wallet setup/import, passphrase rotation,
unlock, funding guidance, and policy widening. SDKs, MCP, the Agent Skill, and the local proxy reuse
the same Buyer Runtime rather than implementing another payment stack. The core also has encrypted
backup/restore primitives.

## Release status

Version `0.1.3` is the stable npm release for the `onchainrouter.dev` domain cutover. Run every authority-changing
command in a human-controlled terminal.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- a dedicated Base wallet funded with enough USDC for the intended calls; ordinary exact payments
  need no Base ETH or token approval;
- direct access to a human terminal for secret and policy prompts.

Windows is not yet a supported host. Payments use Base mainnet USDC only. The CLI discovers the
current USDC contract, recipient, models, voices, and prices from the canonical service.

## Installation

Install the stable release explicitly:

```bash
npm install --global @agenticfi/onchain-router-cli@0.1.3
onchain-router --version
```

To build and run the exact published source:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm buyer:deps
pnpm exec turbo run build --filter=@agenticfi/onchain-router-cli...
node apps/buyer-cli/dist/index.js --help
```

Use `node apps/buyer-cli/dist/index.js` in place of `onchain-router` for every source command below.

## Quick start

```bash
onchain-router setup \
  --origin https://onchainrouter.dev \
  --models gemini-3.6-flash \
  --agent founder-cli-smoke \
  --per-call-usdc 0.02 \
  --session-usdc 0.06 \
  --hour-usdc 0.06 \
  --day-usdc 0.10 \
  --max-output-tokens 512 \
  --confirm-each true \
  --wallet-mode create \
  --yes
onchain-router funding
onchain-router policy show
onchain-router unlock
onchain-router models
onchain-router pricing
onchain-router chat "Explain x402 in two sentences." --model gemini-3.6-flash --max-output-tokens 256
onchain-router lock
```

`setup` creates or imports an encrypted dedicated wallet. The flags above provide every non-secret
choice in one copyable command; passphrases and imported wallet material remain private, no-echo
terminal prompts. Omit any flag to answer that choice interactively. `funding` prints the public
Base address and guidance; it does not transfer funds.

The 512-token policy ceiling leaves room for models that use internal reasoning tokens before
returning visible text. Individual requests may choose a lower value, but very small ceilings can
produce a definite-unpaid `empty_provider_response`.

Wallet import and passphrase entry are direct, no-echo interactions. Never supply a private key,
seed phrase, passphrase, or signer capability through command arguments, environment variables,
stdin from an agent, source control, or a script.

## Commands

```text
onchain-router setup [--origin URL] [--profile DIR] [--models A,B] [--agent ID]
                     [--per-call-usdc N] [--session-usdc N] [--hour-usdc N]
                     [--day-usdc N] [--max-output-tokens N]
                     [--confirm-each true|false] [--wallet-mode create|import] [--yes]
onchain-router unlock [--agent ID] [--idle-seconds N] [--session-seconds N]
onchain-router lock | status | balance | funding | models | pricing | voices
onchain-router wallet rotate-passphrase
onchain-router policy show
onchain-router policy set [--scheme exact] [--models A,B] [--per-call-usdc N] [--session-usdc N]
                          [--hour-usdc N] [--day-usdc N]
                          [--max-output-tokens N] [--confirm-each true|false]
onchain-router chat "prompt" --model MODEL [--max-output-tokens N]
onchain-router image | speak | messages --idempotency-key KEY < request.json
onchain-router transcribe --file AUDIO.mp3 --model MODEL --idempotency-key KEY
onchain-router receipt IDEMPOTENCY_KEY
onchain-router doctor [--out FILE]
```

New profiles use `exact`. A profile created by an older alpha with `upto` is locked from signing;
migrate it once with `onchain-router policy set --profile DIR --scheme exact`. The command requires
the wallet passphrase and preserves the wallet, models, delegations, and monetary limits.

Add `--json` for a stable versioned automation envelope. Use a separate `--profile DIR` when a
human intentionally maintains more than one isolated buyer. Do not let model-supplied text select
the profile or executable.

If a passphrase may have been disclosed, lock the wallet and rotate it in a human-controlled
terminal. All three prompts are hidden, the wallet address stays unchanged, and both the active and
last-good vault copies are re-encrypted under the new passphrase:

```bash
onchain-router lock --profile YOUR_PROFILE
onchain-router wallet rotate-passphrase --profile YOUR_PROFILE
```

Replace any separately exported encrypted backups yourself; the CLI cannot locate external copies.

## Stable idempotency keys

Create and retain one key before each logical paid request. Reuse it only with the identical body.
For shell automation:

```bash
REQUEST_ID="$(node -p 'require("node:crypto").randomUUID()')"
printf '%s\n' "$REQUEST_ID" > request-id.txt
onchain-router chat "Hello" \
  --model gemini-3.6-flash \
  --max-output-tokens 128 \
  --idempotency-key "$REQUEST_ID"
```

Prefer JSON on stdin for automation so prompts do not enter shell history. Never blindly retry
`ProviderOutcomeUnknown` or `SettlementOutcomeUnknown`; recover with the original key:

```bash
onchain-router receipt "$REQUEST_ID"
```

## Media and Messages

Refresh `models`, `pricing`, and `voices` before selecting a model or option. `image`, `speak`, and
`messages` accept a bounded JSON object on stdin.

```bash
REQUEST_ID="$(node -p 'require("node:crypto").randomUUID()')"
printf '%s' '{
  "model":"gemini-3.1-flash-lite-image",
  "prompt":"A geometric blue bridge on a white background",
  "image_size":"1K",
  "aspect_ratio":"1:1",
  "response_format":"url"
}' | onchain-router image --idempotency-key "$REQUEST_ID"
```

```bash
REQUEST_ID="$(node -p 'require("node:crypto").randomUUID()')"
printf '%s' '{
  "model":"elevenlabs/flash-v2.5",
  "input":"Hello from Onchain Router.",
  "response_format":"mp3"
}' | onchain-router speak --idempotency-key "$REQUEST_ID"
```

Image URLs currently expire after seven days; speech URLs currently expire after 24 hours. Both
are bearer capabilities and should be downloaded before expiry without being logged or published.

Transcription reads one bounded, owner-readable regular MP3 file. It rejects symlinks and arbitrary
URLs and asks the human to acknowledge that ElevenLabs may retain uploaded audio and transcripts
independently of Onchain Router staging deletion:

```bash
REQUEST_ID="$(node -p 'require("node:crypto").randomUUID()')"
onchain-router transcribe \
  --file speech.mp3 \
  --model elevenlabs/scribe-v2 \
  --idempotency-key "$REQUEST_ID"
```

Do not upload sensitive or third-party audio without permission.

## Payment and output contract

The CLI previews and validates the live 402 challenge against human-owned policy before signing.
Successful JSON includes the result, idempotency key, verified receipt, Base network, signed exact
amount, matching atomic USDC settlement, and settlement transaction. It never settles above the
signed amount and never releases a response before the result, settlement, and receipt are durable.

The public API uses a request-specific exact amount. For text, `max-output-tokens` affects that
price, so choose a realistic limit. Use live `/v1/pricing` and the challenge for current pricing.
All accounting uses integer atomic USDC; the CLI never uses floating point for financial state.

## Security

- Use a dedicated low-balance wallet with conservative per-call/session/hour/day limits.
- Keep the default profile and backups owner-only; never sync them into a repository or shared
  cloud folder.
- Unlock for the shortest useful session and run `onchain-router lock` afterward.
- Keep `--confirm-each true` when an unattended agent should not approve every payment.
- Never log prompts, completions, wallet material, payment signatures, complete payment payloads,
  receipt capabilities, or hosted media URLs.
- Review `onchain-router doctor` output before sharing it; the command is designed to be redacted.

Report security issues using the repository [`SECURITY.md`](https://github.com/AgenticFI/onchain-router-clients/blob/main/SECURITY.md).

## Troubleshooting

- `wallet is locked`: run `onchain-router unlock` directly, not through an agent.
- Passphrase disclosed: lock immediately and run `wallet rotate-passphrase` in your own terminal;
  never place either passphrase in arguments, shell history, chat, logs, or source control.
- Insufficient USDC: use `onchain-router funding` and verify the connected wallet is on Base.
- Legacy profile rejected: authenticate and run
  `onchain-router policy set --profile YOUR_PROFILE --scheme exact`, then unlock and retry with a
  fresh idempotency key. The migration preserves the wallet and every policy limit.
- Model or option rejected: refresh `models`, `pricing`, and `voices`, then compare with `policy show`.
- Budget rejected: lower the request or have the human review policy; never silently widen it.
- Lost or ambiguous response: keep the same key/body and run `receipt`; do not create a new key.
- Native SQLite build error in a source checkout: use a supported Node version and rerun
  `pnpm buyer:deps`.

## Support

Documentation: <https://onchainrouter.dev/docs/cli>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Attach the CLI version, OS, Node version, sanitized outcome code, and redacted `doctor` output.
Never attach wallet material, prompts, completions, signatures, or receipt capabilities.

## License

MIT. See [LICENSE](LICENSE).
