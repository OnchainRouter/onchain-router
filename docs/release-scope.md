# Stable client release scope

Version `0.2.1` is the stable domain-cutover and existing-profile migration release for the MIT-licensed client boundary and
aligns every buyer surface with the production x402 v2 `exact` EIP-3009 contract.

## Included

- `@onchainrouter/buyer-core`
- `@onchainrouter/routing`
- `@onchainrouter/client`
- `@onchainrouter/cli`
- `@onchainrouter/mcp`
- `@onchainrouter/proxy`
- Python SDK source and deterministic wheel builder
- Onchain Router Agent Skill

## Excluded

- proprietary production gateway, provider adapters, keys, and production configuration;
- Workbench/website source;
- production deployment or configuration mutation;
- wallet initialization, import, funding, unlock, or any USDC payment during publication;
- a claim that experimental smart routing is production-ready.

The npm release uses the default `latest` dist-tag, exact version `0.2.1`, inspected tarballs, and
provenance. Registry metadata, not this source file, is authoritative for publication status.
Publication prefers npm trusted publishing with a short-lived GitHub OIDC identity. A repository
token is accepted only as a bootstrap fallback and is never included in a package.
