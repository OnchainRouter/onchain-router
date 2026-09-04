# Changelog

All notable changes to the public Onchain Router client packages are documented here.

## 0.1.3 - 2026-09-04

### Changed

- Move the canonical production API and documentation origin to `https://onchainrouter.dev`.
- Update CLI defaults, package metadata, installation examples, MCP configuration, and the portable
  Agent Skill to use the new origin while preserving the exact/EIP-3009 payment contract.
- Publish the client packages through npm's normal `latest` channel and retire the earlier `alpha`
  distribution tag.

### Security

- Keep the release limited to the existing MIT client boundary. No wallet material, payment
  payloads, backend source, or production credentials are included.

## 0.1.2 - 2026-09-03

### Added

- Add a hidden-prompt `wallet rotate-passphrase` command that preserves the address and re-encrypts
  both active and last-good vault copies so a disclosed old passphrase no longer opens either copy.

### Changed

- Reduce all buyer surfaces to the production x402 v2 `exact` EIP-3009 contract.
- Remove the legacy approval commands, SDK methods, broker actions, chain RPC reads, and approval
  transaction builder. Older `upto` profiles remain readable only for an explicit,
  wallet-authenticated `policy set --scheme exact` migration that preserves the wallet and limits.

### Fixed

- Accept the standard x402 v2 `exact` settlement response when its optional `amount` field is
  absent, and verify the durable receipt against the fixed signed amount instead.
- Make `doctor` detect a stale local payment scheme and print the exact migration command instead
  of allowing a false-green diagnostic.
- Replace the misleading `upto scheme is required` failure with actionable, definite-unpaid
  guidance and classify a server-side payer quarantine as a non-retriable policy rejection.
- Accept the production fixed `amount` quote field while retaining bounded compatibility with the
  earlier `maximumAmount` response.

## 0.1.1 - 2026-09-03

### Added

- Explicit `permit2 status` and human-confirmed `permit2 approve` CLI commands for first-use Base
  USDC allowance setup.
- TypeScript and Buyer Runtime methods for reading and submitting a finite, policy-bounded approval
  to canonical Permit2.
- Copyable setup flags for every non-secret choice while keeping passphrases and imported wallet
  material in private terminal prompts.

### Fixed

- Reject paid-request signing before a sufficient Permit2 allowance exists, with safe retry guidance.
- Preserve safe x402 facilitator rejection codes instead of returning an unhelpful `unknown` error.
- Clarify that the buyer pays Base ETH gas for the separate approval transaction.

## 0.1.0 - 2026-09-01

### Added

- Public-alpha Buyer Runtime with encrypted wallet storage, integer budgets, official x402 `upto`
  payment handling, ambiguous-outcome recovery, and verified durable receipts.
- TypeScript and Python SDKs, human CLI, focused MCP server, authenticated loopback proxy, and Agent
  Skill for text, image, speech, and transcription requests.
- Experimental deterministic smart routing that remains subordinate to Buyer Runtime policy.
- Pinned CI, tarball inspection, manual npm alpha publication, MIT licensing, security policy, and
  package-specific self-service documentation.
