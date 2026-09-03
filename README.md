# Onchain Router Clients

Open-source clients for agents that discover AI capabilities, pay x402 challenges with USDC on
Base, enforce local budgets, recover ambiguous requests, and retain a verified receipt for every
completed payment.

This source tree is the `0.1.2` bounded-alpha candidate. Check the npm `alpha` tag before assuming
that exact version is published. Smart routing is experimental; the Buyer Runtime remains the
authority for wallet access, model allowlists, recipients, output limits, and integer-atomic spend
budgets.

## Choose a surface

| Surface        | Package or path                                  | Use it when                                                                   |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| TypeScript SDK | `@agenticfi/onchain-router`                      | Your Node.js application needs typed discovery and paid API calls             |
| Buyer CLI      | `@agenticfi/onchain-router-cli`                  | A human needs to create/unlock a wallet, set budgets, or inspect receipts     |
| MCP server     | `@agenticfi/onchain-router-mcp`                  | Claude, Cursor, ChatGPT, or another MCP client should call the API as tools   |
| Local proxy    | `@agenticfi/onchain-router-proxy`                | An OpenAI-compatible client needs one loopback base URL                       |
| Buyer Runtime  | `@agenticfi/onchain-router-buyer-core`           | You are building another trusted local adapter                                |
| Smart routing  | `@agenticfi/onchain-router-routing`              | You need deterministic, constraint-first model selection before payment       |
| Python SDK     | `onchain-router` source package                  | Python should delegate payment execution to the local CLI                     |
| Agent Skill    | [`skills/onchain-router`](skills/onchain-router) | A coding agent should follow the supported commands and retry rules           |

The public HTTP API and documentation are at [llm.agenticfi.wtf](https://llm.agenticfi.wtf).

## Fastest safe start

Requirements: Node.js 20.18 or newer, macOS or Linux, and a human-controlled terminal.

```bash
npm install --global @agenticfi/onchain-router-cli@0.1.2
onchain-router --version
onchain-router setup
onchain-router policy show
onchain-router unlock
onchain-router models
```

The dedicated buyer wallet needs Base USDC for API payments. The public x402 v2 `exact` EIP-3009
flow signs the USDC authorization offchain, so there is no separate gas-funding or token-approval
step.

`setup`, wallet import, funding, unlock, and policy widening are human-authority actions. Do not run
them unattended and never paste a wallet key, seed phrase, passphrase, payment payload, or receipt
capability into an agent prompt, command argument, environment variable, log, or issue.

After setup and unlock, install the application surface you need:

```bash
npm install @agenticfi/onchain-router@0.1.2
```

```ts
import { OnchainRouterBuyer } from '@agenticfi/onchain-router';

const buyer = await OnchainRouterBuyer.connect();
try {
  const result = await buyer.chat({
    model: 'gemini-3.6-flash',
    messages: [{ role: 'user', content: 'Explain x402 in one sentence.' }],
    max_tokens: 128,
  });

  if (!result.ok) throw new Error(`${result.outcome}: ${result.message}`);
  console.log(result.body);
  console.log(result.receipt.id, result.payment.actualAtomic);
} finally {
  buyer.close();
}
```

Read the [TypeScript SDK guide](clients/typescript/README.md) for the complete API and recovery
contract. Every product directory has its own installation, quick-start, security, troubleshooting,
and support guide.

## What the Buyer Runtime guarantees

- Wallet secrets stay inside an encrypted, owner-only local profile and short-lived signer broker.
- A request must match the human-approved HTTPS origin, Base network, USDC asset, recipient, model,
  output limit, and per-call/session/hour/day budget before signing.
- Money and token limits use integers, never floating point.
- The official x402 v2 `exact` EIP-3009 challenge is validated before authorization.
- A paid request is not blindly retried after an ambiguous provider or settlement outcome.
- A result is not released until settlement evidence and the durable server receipt are verified.
- Recovery reuses the exact idempotency identity and request; it does not create another spend.
- MCP and proxy adapters cannot initialize/import a wallet or widen policy.

See the [Buyer Runtime threat model](packages/buyer-core/buyer-core-threat-model.md),
[proxy threat model](apps/buyer-proxy/buyer-proxy-threat-model.md), and
[security policy](SECURITY.md).

## Supported API capabilities

The high-level SDK, CLI, MCP server, and proxy share one Buyer Runtime and currently support:

- `POST /v1/chat/completions` — OpenAI-compatible text;
- `POST /v1/messages` — Anthropic-compatible text;
- `POST /v1/images/generations` — image generation;
- `POST /v1/audio/speech` — text to speech;
- `POST /v1/audio/transcriptions` — speech to text;
- free discovery for models, pricing, voices, balance, quotes, and payment contracts;
- local receipt inspection and same-idempotency recovery.

The live discovery documents are authoritative. Do not hard-code model availability, prices, the
USDC contract, recipient, or output formats from examples.

## MCP and OpenAI-compatible clients

For MCP clients:

```bash
npm install --global @agenticfi/onchain-router-mcp@0.1.2
onchain-router-mcp --print-config
```

For OpenAI-compatible clients:

```bash
npm install --global @agenticfi/onchain-router-proxy@0.1.2
onchain-router-proxy --print-config
```

The proxy binds only to `127.0.0.1`, rejects browser-origin requests, and requires an owner-only
local bearer. See the [MCP guide](apps/buyer-mcp/README.md) and
[proxy guide](apps/buyer-proxy/README.md).

## Repository layout

```text
packages/buyer-core    Wallet, policy, budgets, x402 execution, recovery, receipts
packages/routing       Experimental deterministic routing
clients/typescript     High-level TypeScript SDK
clients/python         Thin Python-to-CLI SDK
apps/buyer-cli         Human authority and command-line use
apps/buyer-mcp         Focused MCP tools
apps/buyer-proxy       Authenticated loopback OpenAI-compatible proxy
skills/onchain-router  Agent instructions and scripts
```

This repository intentionally excludes the proprietary AgenticFI gateway, provider credentials,
production deployment configuration, and Workbench.

## Develop and verify

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm deps:native
pnpm verify
pnpm pack:alpha
```

`pnpm pack:alpha` builds and inspects the six npm tarballs, rejects workspace dependency markers,
forbidden files, and common credential formats, then writes SHA-256 hashes under
`.artifacts/npm/manifest.json`.

## Release policy

- Release `0.1.2` only under the npm `alpha` dist-tag, not `latest`.
- npm publication is manual from the pinned GitHub Actions workflow after CI passes.
- The initial bootstrap uses a short-lived granular npm automation token stored only as a GitHub
  Actions secret and requests npm provenance. It should be replaced by npm trusted publishing after
  each package exists.
- This repository release does not deploy production, create/import/fund a wallet, or spend USDC.

See [docs/release-scope.md](docs/release-scope.md) for the exact public-alpha boundary.

## Support and security

Use [GitHub Issues](https://github.com/AgenticFI/onchain-router-clients/issues) for sanitized bugs and
feature requests. Do not attach prompts, completions, wallet material, payment signatures, receipt
capabilities, or hosted-media URLs.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License and provenance

The client code is MIT licensed. Individual packages include their own license copy. The routing
package also includes an [upstream audit record](packages/routing/UPSTREAM.md) documenting the
open-source architectural review and clean local implementation.
