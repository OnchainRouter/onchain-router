# Stable client release scope

Version `0.1.3` is the stable domain-cutover release for the MIT-licensed client boundary and
aligns every buyer surface with the production x402 v2 `exact` EIP-3009 contract.

## Included

- `@agenticfi/onchain-router-buyer-core`
- `@agenticfi/onchain-router-routing`
- `@agenticfi/onchain-router`
- `@agenticfi/onchain-router-cli`
- `@agenticfi/onchain-router-mcp`
- `@agenticfi/onchain-router-proxy`
- Python SDK source and deterministic wheel builder
- Onchain Router Agent Skill

## Excluded

- proprietary AgenticFI gateway, provider adapters, keys, and production configuration;
- Workbench/website source;
- production deployment or configuration mutation;
- wallet initialization, import, funding, unlock, or any USDC payment during publication;
- a claim that experimental smart routing is production-ready.

The npm release uses the default `latest` dist-tag, exact version `0.1.3`, inspected tarballs, and
provenance. Registry metadata, not this source file, is authoritative for publication status.
Publication uses the existing repository-scoped npm credential stored only in GitHub Actions.
