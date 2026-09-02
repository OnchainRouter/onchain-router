# Onchain Router Buyer Runtime

The security and payment engine shared by the Onchain Router CLI, SDKs, MCP server, Agent Skill,
and loopback proxy. It keeps wallet authority and USDC limits in one local runtime so each
integration does not invent its own payment lifecycle.

Use a higher-level package unless you are developing an Onchain Router adapter:

- applications: `@agenticfi/onchain-router` or the Python `onchain-router` package;
- humans and shell automation: `@agenticfi/onchain-router-cli`;
- tool-capable agents: `@agenticfi/onchain-router-mcp`;
- OpenAI-compatible clients: `@agenticfi/onchain-router-proxy`.

## Release status

Version `0.1.1` is a bounded public alpha published under the npm `alpha` dist-tag. It is not the
stable `latest` line. Installing source or a package does not authorize wallet setup, import,
funding, unlock, policy widening, or a paid request.

## What it owns

- encrypted local EVM wallet storage and restore;
- an expiring, owner-only signer broker;
- immutable human-approved network, recipient, model, output, and spend policy;
- cross-process integer-atomic USDC reservations in SQLite;
- official x402 v2 `upto` payment verification and signing;
- same-idempotency-key recovery after a lost response;
- verification and durable storage of server receipts before releasing a result.

It does not call an AI provider directly, expose wallet keys, log prompts or completions, or permit
an agent to widen policy. Redis is not used for local financial correctness.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- the matching Onchain Router `0.1.x` client packages;
- a dedicated Base wallet funded with enough USDC for the intended calls.

Windows is not yet a supported host. Live network, asset, recipient, models, and pricing must be
read from `https://llm.agenticfi.wtf/.well-known/x402`, `/v1/models`, and `/v1/pricing` rather than
hard-coded.

## Installation

Install the bounded alpha explicitly:

```bash
npm install @agenticfi/onchain-router-buyer-core@alpha
```

To build the exact candidate from this repository now:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm buyer:deps
pnpm --filter @agenticfi/onchain-router-buyer-core build
pnpm --filter @agenticfi/onchain-router-buyer-core test
```

`pnpm buyer:deps` is the explicit native-build step for the pinned `better-sqlite3` dependency.

## Quick start

Do not initialize this low-level runtime in ordinary application code. Complete human-authority
setup through the matching CLI, then connect through a high-level SDK:

```bash
onchain-router setup
onchain-router funding
onchain-router unlock
onchain-router status
```

```ts
import { OnchainRouterBuyer } from '@agenticfi/onchain-router';

const buyer = await OnchainRouterBuyer.connect();
try {
  console.log(await buyer.status());
} finally {
  buyer.close();
}
```

Setup and unlock ask for secrets through a direct no-echo terminal. Never pass a private key,
seed phrase, passphrase, or signer capability through source code, arguments, environment
variables, agent prompts, MCP tools, or proxy requests.

## Payment and recovery contract

Every logical paid request needs one stable idempotency key. Buyer Runtime validates the live 402
challenge against local policy, reserves the signed maximum in integer atomic USDC, obtains owner
authorization from the short-lived broker, and delegates signing to the official x402 libraries.
It releases a successful result only after settlement and the corresponding receipt are durable.

Before signing a payment, the broker reads the dedicated wallet's Base USDC allowance to canonical
Permit2. An insufficient allowance fails definitely and produces no payment signature. A trusted
human-operated surface can submit a standard ERC-20 approval fixed to official Base USDC and
canonical Permit2, bounded to the reviewed daily policy. The buyer pays the required Base ETH gas.

The success result includes `Completed` or `RecoveredSuccess`, the idempotency key, response body,
verified receipt, authorized maximum, actual amount, Base network, recipient, and settlement
transaction. A known failed inference is not settled.

`ProviderOutcomeUnknown` and `SettlementOutcomeUnknown` are not generic retryable errors. Preserve
the original idempotency key and identical request, inspect the local receipt, and require human
review when the returned retry directive says so. Never submit a new key to work around ambiguity.

## Security

- Use a dedicated low-balance wallet; do not reuse a treasury or personal wallet.
- Keep profile, wallet, ledger, session, backup, and proxy-token files owner-only.
- Let only the CLI perform setup, import, unlock, funding guidance, and policy widening. Keep the
  lower-level encrypted backup/restore procedure owner-only; a polished public CLI rotation flow is
  not yet claimed.
- Keep the signer session short and run `onchain-router lock` when work is complete.
- Treat hosted media URLs and receipt capabilities as bearer secrets.
- Review the [Buyer Runtime threat model](https://github.com/AgenticFI/onchain-router-clients/blob/main/packages/buyer-core/buyer-core-threat-model.md) before building an adapter.

Security issues should be reported privately using the process in the repository
[`SECURITY.md`](https://github.com/AgenticFI/onchain-router-clients/blob/main/SECURITY.md). Do not include wallet material, payment signatures, prompts,
completions, or receipt capabilities in an issue.

## Troubleshooting

- `WalletLocked`: run `onchain-router unlock` in a human terminal and retry only if no paid handoff
  occurred.
- Policy or budget rejection: inspect `onchain-router policy show` and `onchain-router status`; do
  not silently widen a limit.
- Catalog or model rejection: refresh `onchain-router models` and choose an enabled model allowed by
  local policy.
- Ambiguous outcome: use `onchain-router receipt <IDEMPOTENCY_KEY>` and follow the exact retry
  directive.
- Native SQLite build failure: use a supported Node version, then rerun `pnpm buyer:deps`.

## Support

Documentation: <https://llm.agenticfi.wtf/docs/buyer-runtime>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Include the package version, OS, Node version, sanitized outcome code, and a redacted diagnostic
report. Never attach secrets or request/response content.

## License

MIT. See [LICENSE](LICENSE).
