# Onchain Router TypeScript SDK

Build applications that discover live AI models and make policy-bounded x402 payments in USDC
without putting wallet secrets in application code. The SDK connects to the local Buyer Runtime,
which owns signing, budgets, recovery, and verified receipts.

One client covers five paid JSON routes:

- OpenAI-compatible chat completions;
- Anthropic-compatible messages;
- image generation with hosted output;
- text-to-speech with hosted MP3 output;
- speech-to-text from bounded MP3 Base64.

It also exposes free models, pricing, voices, balance, payment-contract, and quote discovery.

## Release status

Version `0.2.1` is the stable npm release for the `onchainrouter.dev` domain cutover. Installation does not authorize
wallet setup, funding, unlock, policy widening, or a paid request.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- the matching `onchain-router` CLI for setup and unlock;
- a dedicated Base wallet funded with enough USDC for the intended calls.

The Buyer Runtime supports Base mainnet only. Discover the live network, USDC contract, recipient,
model catalog, capabilities, and pricing at request time; do not hard-code them from an example.

## Installation

Install the stable release explicitly:

```bash
npm install @onchainrouter/client@0.2.1
```

To build the exact published source:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm buyer:deps
pnpm exec turbo run build --filter=@onchainrouter/client...
pnpm --filter @onchainrouter/client test
```

## One-time wallet setup

Run authority-changing commands directly in a human terminal:

```bash
onchain-router setup
onchain-router funding
onchain-router policy show
onchain-router unlock
```

Setup creates or imports an encrypted dedicated wallet and asks the human to approve models and
integer USDC limits. Neither `OnchainRouterBuyer.connect()` nor any paid method accepts a private
key, seed phrase, passphrase, or broker capability.

## Quick start

Run `onchain-router models` immediately before choosing a model. The illustrative model below must
still be present in live discovery and allowed by the local policy.

```ts
import { randomUUID } from 'node:crypto';
import { OnchainRouterBuyer } from '@onchainrouter/client';

const buyer = await OnchainRouterBuyer.connect();
const requestKey = randomUUID(); // persist this for recovery

try {
  const models = await buyer.discovery.models();
  console.log(models);

  const result = await buyer.chat(
    {
      model: 'gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Explain x402 in two sentences.' }],
      max_tokens: 256,
      stream: false,
    },
    requestKey,
  );

  if (!result.ok) {
    console.error(result.outcome, result.retry, result.reference);
    // Follow result.retry. Never replace requestKey after an ambiguous handoff.
  } else {
    console.log(result.body);
    console.log({
      receipt: result.receipt.id,
      actualAtomic: result.payment.actualAtomic,
      maximumAtomic: result.payment.authorizedMaximumAtomic,
      transaction: result.payment.transaction,
    });
  }
} finally {
  buyer.close();
}
```

`close()` releases local resources but does not end the signer session. Use `await buyer.lock()` or
the human CLI's `onchain-router lock` when the session should end.

The SDK exposes one payment path: x402 v2 `exact` EIP-3009 with Base USDC. Legacy profile migration
is intentionally available only through the human-owned CLI, not application code.

## Discovery

```ts
const models = await buyer.discovery.models();
const pricing = await buyer.discovery.pricing();
const voices = await buyer.discovery.voices();
const balance = await buyer.discovery.balance('0xYourBaseAddress');
```

Discovery is free. Treat it as authoritative and refresh it instead of assuming a model, voice,
size, price, or provider stays enabled. `discovery.quote()` returns the short-lived fixed amount
bound to one exact request.

## Media examples

Image output is a hosted bearer URL and currently expires after seven days:

```ts
const image = await buyer.images(
  {
    model: 'gemini-3.1-flash-lite-image',
    prompt: 'A geometric blue bridge on a white background',
    image_size: '1K',
    aspect_ratio: '1:1',
    response_format: 'url',
  },
  randomUUID(),
);
```

Speech output is hosted MP3 JSON and currently expires after 24 hours:

```ts
const speech = await buyer.speech(
  {
    model: 'elevenlabs/flash-v2.5',
    input: 'Hello from Onchain Router.',
    response_format: 'mp3',
  },
  randomUUID(),
);
```

Transcription accepts canonical MP3 Base64, not a path or URL. Explicit acknowledgement is
required because ElevenLabs can retain uploaded audio and transcripts independently of Onchain
Router staging deletion. The acknowledgement is removed before the API request is signed.

```ts
import { readFile } from 'node:fs/promises';

const mp3Bytes = await readFile('speech.mp3');
const transcription = await buyer.transcriptions(
  {
    model: 'elevenlabs/scribe-v2',
    audio_base64: mp3Bytes.toString('base64'),
    response_format: 'json',
    acknowledge_provider_retention: true,
  },
  randomUUID(),
);
```

Always read exact media fields and limits from live discovery. Hosted media URLs are bearer
capabilities: download them before expiry and do not log or publish the complete URL.

## Recovery and receipts

Create one idempotency key before each logical paid request and persist it with the identical
request body. A normal success includes a locally verified durable receipt. If the response is
lost, inspect `buyer.receipt(requestKey)` and repeat only when the typed retry directive permits the
same key and same body.

Never turn `ProviderOutcomeUnknown` or `SettlementOutcomeUnknown` into a fresh payment or an
automatic call to another model. Those outcomes require same-key recovery or human review.

## Experimental smart routing

`buyer.routedChat(body, options, idempotencyKey)` can hard-filter models, obtain authoritative
maxima, and select one explicit route with integer-only scoring before using the ordinary Buyer
Runtime. The return value contains a content-free decision, the normal `BuyerResult`, and on
success a receipt association.

This feature remains experimental: the current held-out qualification has not passed every quality
threshold. Fallback is always disabled, and no cost-saving or quality claim should be inferred.
Explicit model selection through `buyer.chat()` remains the supported default.

## Security

- Use a dedicated low-balance wallet and conservative per-call/session/hour/day policy.
- Keep setup, import, unlock, funding guidance, and policy widening in the direct CLI. Keep the
  lower-level encrypted backup/restore procedure owner-only.
- Never pass wallet secrets through SDK constructors, source control, environment variables,
  prompts, logs, issue reports, or telemetry.
- Never log prompts, completions, payment signatures, receipt capabilities, or complete media URLs.
- Set a stable idempotency key and disable higher-layer automatic retries around paid methods.
- Treat `finish_reason: "length"` as a paid, truncated success rather than a reason to retry.

Report security issues using the repository [`SECURITY.md`](https://github.com/OnchainRouter/onchain-router/blob/main/SECURITY.md).

## Troubleshooting

- `WalletLocked`: run `onchain-router unlock` in a human terminal.
- Model or option rejected: refresh models, pricing, or voices and compare them with local policy.
- Budget rejected: inspect `onchain-router status` and `onchain-router policy show`; do not widen it
  inside an agent.
- Ambiguous result: preserve the original key/body, inspect the local receipt, and follow
  `result.retry`.
- `onchain-router` not found: install/build the matching CLI and ensure it is on `PATH`.
- Media response too large: use supported hosted output instead of an arbitrarily large inline
  response.

## Support

Documentation: <https://onchainrouter.dev/docs/sdk-examples>

Issues: <https://github.com/OnchainRouter/onchain-router/issues>

Include the SDK version, Node version, OS, sanitized outcome code, and redacted diagnostics. Never
attach wallet material, user content, signatures, or receipt capabilities.

## License

MIT. See [LICENSE](LICENSE).
