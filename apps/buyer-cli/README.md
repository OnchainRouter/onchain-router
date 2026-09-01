# Onchain Router CLI

Create a dedicated buyer wallet, set USDC budgets, unlock a short-lived signer, discover live AI
models, pay x402 challenges, recover lost responses, and inspect verified receipts from one
terminal command: `onchain-router`.

The CLI is the supported human-authority surface for wallet setup/import, unlock, funding guidance,
and policy widening. SDKs, MCP, the Agent Skill, and the local proxy reuse the same Buyer Runtime
rather than implementing another payment stack. The core has encrypted backup/restore primitives;
a polished public CLI rotation/restore command is not yet claimed.

## Release status

Version `0.1.0` is a bounded public alpha published under the npm `alpha` dist-tag. It is not the
stable `latest` line. Run every authority-changing command in a human-controlled terminal.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- a dedicated Base wallet funded with enough USDC for the intended calls;
- direct access to a human terminal for secret and policy prompts.

Windows is not yet a supported host. Payments use Base mainnet USDC only. The CLI discovers the
current USDC contract, recipient, models, voices, and prices from the canonical service.

## Installation

Install the bounded alpha explicitly:

```bash
npm install --global @agenticfi/onchain-router-cli@alpha
onchain-router --version
```

To build and run the exact source candidate now:

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
onchain-router setup
onchain-router funding
onchain-router policy show
onchain-router unlock
onchain-router models
onchain-router pricing
onchain-router chat "Explain x402 in two sentences." --model gemini-3.6-flash --max-output-tokens 256
onchain-router lock
```

`setup` creates or imports an encrypted dedicated wallet and asks the human to approve the origin,
network, recipient, models, output limit, and per-call/session/hour/day USDC limits. `funding`
prints the public Base address and guidance; it does not transfer funds.

Wallet import and passphrase entry are direct, no-echo interactions. Never supply a private key,
seed phrase, passphrase, or signer capability through command arguments, environment variables,
stdin from an agent, source control, or a script.

## Commands

```text
onchain-router setup [--origin URL] [--profile DIR]
onchain-router unlock [--agent ID] [--idle-seconds N] [--session-seconds N]
onchain-router lock | status | balance | funding | models | pricing | voices
onchain-router policy show
onchain-router policy set [--models A,B] [--per-call-usdc N] [--session-usdc N]
                          [--hour-usdc N] [--day-usdc N]
                          [--max-output-tokens N] [--confirm-each true|false]
onchain-router chat "prompt" --model MODEL [--max-output-tokens N]
onchain-router image | speak | messages --idempotency-key KEY < request.json
onchain-router transcribe --file AUDIO.mp3 --model MODEL --idempotency-key KEY
onchain-router receipt IDEMPOTENCY_KEY
onchain-router doctor [--out FILE]
```

Add `--json` for a stable versioned automation envelope. Use a separate `--profile DIR` when a
human intentionally maintains more than one isolated buyer. Do not let model-supplied text select
the profile or executable.

## Stable idempotency keys

Create and retain one key before each logical paid request. Reuse it only with the identical body.
For shell automation:

```bash
REQUEST_ID="$(uuidgen)"
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
REQUEST_ID="$(uuidgen)"
printf '%s' '{
  "model":"gemini-3.1-flash-lite-image",
  "prompt":"A geometric blue bridge on a white background",
  "image_size":"1K",
  "aspect_ratio":"1:1",
  "response_format":"url"
}' | onchain-router image --idempotency-key "$REQUEST_ID"
```

```bash
REQUEST_ID="$(uuidgen)"
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
REQUEST_ID="$(uuidgen)"
onchain-router transcribe \
  --file speech.mp3 \
  --model elevenlabs/scribe-v2 \
  --idempotency-key "$REQUEST_ID"
```

Do not upload sensitive or third-party audio without permission.

## Payment and output contract

The CLI previews and validates the live 402 challenge against human-owned policy before signing.
Successful JSON includes the result, idempotency key, verified receipt, Base network, authorized
maximum, actual atomic USDC amount, and settlement transaction. It never settles above the signed
maximum and never releases a response before the result, settlement, and receipt are durable.

The authorization maximum is a request-specific safety ceiling, not necessarily the final charge.
Use live `/v1/pricing` and the challenge for current pricing. All accounting uses integer atomic
USDC; the CLI never uses floating point for financial state.

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
- Insufficient USDC: use `onchain-router funding` and verify the connected wallet is on Base.
- Model or option rejected: refresh `models`, `pricing`, and `voices`, then compare with `policy show`.
- Budget rejected: lower the request or have the human review policy; never silently widen it.
- Lost or ambiguous response: keep the same key/body and run `receipt`; do not create a new key.
- Native SQLite build error in a source checkout: use a supported Node version and rerun
  `pnpm buyer:deps`.

## Support

Documentation: <https://llm.agenticfi.wtf/docs/cli>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Attach the CLI version, OS, Node version, sanitized outcome code, and redacted `doctor` output.
Never attach wallet material, prompts, completions, signatures, or receipt capabilities.

## License

MIT. See [LICENSE](LICENSE).
