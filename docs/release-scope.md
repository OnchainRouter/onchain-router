# Public alpha release scope

Version `0.1.2` publishes the MIT-licensed client boundary as a bounded public alpha and aligns all
buyer surfaces with the production x402 v2 `exact` EIP-3009 contract.

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
- a claim that experimental smart routing is production-ready;
- promotion of the npm packages to `latest`.

The npm release uses the `alpha` dist-tag, exact version `0.1.2`, inspected tarballs, and provenance.
The first publication may use a short-lived granular npm token stored only in GitHub Actions. After
package creation, configure npm trusted publishing for this repository and remove the bootstrap
token.
