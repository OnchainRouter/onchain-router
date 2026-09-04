# Onchain Router Local Proxy

`@onchainrouter/proxy` is the loopback OpenAI-compatible adapter for Buyer Runtime. It lets an
OpenAI-compatible client use paid Onchain Router chat without implementing x402. The proxy exposes:

- `GET /v1/models` — live models intersected with the human-owned local policy;
- `GET /v1/pricing` and `GET /v1/audio/voices` — free discovery;
- `POST /v1/chat/completions` — non-streaming paid chat, or session-isolated reuse of a paid answer.
- `POST /v1/messages`, `/v1/images/generations`, `/v1/audio/speech`, and
  `/v1/audio/transcriptions` — bounded JSON requests through the same Buyer Runtime.

The process always binds to `127.0.0.1`, rejects browser/CORS requests and unexpected `Host`
headers, and requires a 256-bit non-wallet bearer stored in an owner-only file. It has no wallet,
policy, receipt-token, signing, payment-configuration, or arbitrary proxy endpoint.
Setup, unlock, funding, policy changes, and receipt inspection remain direct CLI/SDK actions.

## Release status

Version `0.2.0` is the stable npm release for the `onchainrouter.dev` domain cutover. It is not a claim of qualification
across every OpenAI-compatible client. Keep it bound to loopback and preserve the bearer, Host,
browser, body, and idempotency controls.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- the matching Onchain Router CLI and Buyer Runtime;
- an already-created, currently unlocked buyer profile;
- an OpenAI-compatible client that supports a custom base URL, bearer, non-streaming JSON, and
  disabled automatic retries.

This is a single-user local adapter, not a hosted gateway. It must not be exposed through port
forwarding, a reverse proxy, a tunnel, a container host bind, or a public network interface.

Speech returns hosted-audio JSON, not the OpenAI SDK's binary audio response. Transcription uses
MP3 Base64 JSON with `acknowledge_provider_retention: true`, not multipart upload. Those audio
methods are therefore not drop-in binary/multipart OpenAI replacements. Images use hosted URLs
by default; all media bypasses caching. Live catalog limits remain authoritative.

## Installation

Install the stable release explicitly:

```bash
npm install --global @onchainrouter/proxy@0.2.0
onchain-router-proxy --version
```

To build the exact published source:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm buyer:deps
pnpm exec turbo run build --filter=@onchainrouter/proxy...
```

## Quick start

Build the private artifact, complete Buyer Runtime setup/unlock in a human terminal, then start the
proxy:

```bash
pnpm --filter @onchainrouter/proxy build
onchain-router setup
onchain-router unlock
node apps/buyer-proxy/dist/index.js
```

The first start creates `~/.onchain-router/proxy-token` with owner-only permissions. Startup prints
only its path, never its value. `--print-config` returns the loopback base URL, token-file path,
endpoints, streaming rule, and idempotency header without reading or revealing the bearer:

```bash
node apps/buyer-proxy/dist/index.js --print-config
```

No option can change the listener host. `--port` accepts a local TCP port and defaults to `8402`.

## Official OpenAI TypeScript client

Only the base URL, API key source, and model differ from an ordinary non-streaming OpenAI call.
Read the local bearer directly into the client process; do not print it or put it in source control.
Use a stable `Idempotency-Key` for each logical paid request and reuse that same key only with the
identical request.

```ts
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8402/v1',
  apiKey: readFileSync(`${process.env.HOME}/.onchain-router/proxy-token`, 'utf8'),
  defaultHeaders: { 'Idempotency-Key': crypto.randomUUID() },
  maxRetries: 0,
});

const result = await client.chat.completions.create({
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'Explain this contract.' }],
  max_tokens: 512,
  stream: false,
});
```

The official TypeScript SDK contract is covered by repository tests. Other OpenAI-compatible
clients use the same three settings:

```text
base URL:  http://127.0.0.1:8402/v1
API key:   contents of ~/.onchain-router/proxy-token
model:     one ID returned by GET /v1/models
```

An omitted idempotency header receives a generated key in
`x-onchain-router-idempotency-key`, which is enough for a normal completed response. A caller that
needs safe lost-response/restart recovery must set and retain its own stable key before sending the
request; a key learned only from a lost response cannot be recovered. The proxy never retries a
paid request by itself.

## Response caching

Eligible identical text requests without a caller-supplied idempotency key reuse verified answers
for up to ten minutes in process memory. The cache is isolated by wallet, agent, session, policy,
origin, and catalog, bounded to 200 entries / 1 MiB per body / 16 MiB serialized data, and cleared
on shutdown. Live discovery and unlocked-broker checks run before hits. No disk cache, prompt log,
cross-customer reuse, tool/media caching, or additional payment lifecycle is introduced.

Use `Cache-Control: no-cache` to refresh, `Cache-Control: no-store` or JSON `cache: false` /
`no_cache: true` to bypass, and `--no-cache` to disable the process cache. Explicit idempotency keys
always bypass it; the recovery-safe SDK example above intentionally uses that path. Concurrent
fresh misses are not coalesced. Refresh for a new stochastic sample or time-sensitive information.

A hit retains the original response body and source idempotency key. It reports
`x-onchain-router-cache: HIT`, `x-onchain-router-outcome: CachedResponse`,
`x-onchain-router-charge-atomic: 0`, `x-onchain-router-source-receipt-id`, and cache age/expiry
headers. There is no new payment or receipt; ordinary payment/receipt headers are omitted, and
body usage describes the original inference. Misses report `MISS`; excluded requests report
`BYPASS`. Responses remain HTTP `Cache-Control: no-store`. See the canonical
[proxy guide](https://onchainrouter.dev/docs/proxy) for details. Direct SDK, CLI, MCP, public API,
and provider cached-token pricing are unchanged.

## Result and failure contract

A paid successful response body is the original OpenAI-compatible chat completion. Headers include the
idempotency key, outcome, receipt ID, Base network, authorized maximum, actual atomic USDC amount,
and transaction. They never include the receipt capability or payment signature.

Errors use an OpenAI-compatible `error` object plus `onchain_router.outcome` and
`onchain_router.retry`. Provider-unknown and settlement-unknown outcomes are HTTP `409` with
`retry: human_review` and `x-should-retry: false`, never a generic retryable `5xx`. Every error
suppresses the official OpenAI client's automatic retries. A disconnect before Buyer Runtime
handoff is cancelled; a disconnect afterward does not interrupt financial finalization. Recover
manually with the same idempotency key and identical body.

## Security

- Use a dedicated low-balance wallet and conservative human-owned policy.
- Keep the proxy on `127.0.0.1`; do not weaken Host, bearer, browser, CORS, or body checks.
- Keep the owner-only bearer file out of source control, logs, screenshots, prompts, and shared
  configuration. It is not the wallet key, but it authorizes local access to an unlocked buyer.
- Set `maxRetries: 0` in higher-level clients and retain one stable idempotency key per logical paid
  request.
- Keep setup, unlock, funding, backup/restore, policy widening, and receipt-capability access outside
  the proxy.
- Treat model output and request content as untrusted; neither can change origin, recipient,
  network, asset, maximum, or wallet authority.
- Review the [proxy threat model](https://github.com/OnchainRouter/onchain-router/blob/main/apps/buyer-proxy/buyer-proxy-threat-model.md) before adding an endpoint or client.

Report security issues using the repository [`SECURITY.md`](https://github.com/OnchainRouter/onchain-router/blob/main/SECURITY.md).

## Troubleshooting

- Proxy will not start: run `onchain-router doctor`, confirm the buyer is unlocked, and check that
  the port is free.
- HTTP `401`: reread the owner-only token file inside the client process; do not paste or print it.
- Host/CORS/browser rejection: use a local server-side client. Browser access is intentionally
  unsupported.
- Model or media option rejected: refresh `/v1/models`, `/v1/pricing`, and `/v1/audio/voices`.
- Unexpected additional request: disable client retries and confirm `maxRetries: 0` is effective.
- Lost or ambiguous response: keep the exact key/body and inspect the local receipt through the CLI
  or SDK; do not create a new request.
- Unexpected cache hit: add a caller-owned idempotency key or `Cache-Control: no-store`; use
  `--no-cache` to disable caching for the whole proxy process.

## Support

Documentation: <https://onchainrouter.dev/docs/proxy>

Issues: <https://github.com/OnchainRouter/onchain-router/issues>

Include the package version, client/version, OS, Node version, response status, sanitized outcome,
and redacted `doctor` output. Never attach the bearer, wallet material, request content, payment
signatures, receipt capabilities, or hosted media URLs.

## License

MIT. See [LICENSE](LICENSE).
