# Onchain Router Routing

An experimental, deterministic model-selection library for Onchain Router text requests. It
hard-filters models, asks the live service for request-bound price maxima, and selects exactly one
model before the Buyer Runtime starts an x402 payment.

Routing is advisory. It does not own a wallet, sign or settle payments, call an AI provider, retry
a request, or authorize fallback. The human-owned Buyer Runtime policy remains final.

## Release status

Version `0.2.1` is the stable npm package release for the `onchainrouter.dev` domain cutover. Routing remains experimental and advisory: it cannot
sign, spend, retry a paid route, or widen Buyer Runtime policy. Do not describe it as
production-ready automatic routing.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- a `RouteQuotePort` backed by authoritative request-bound quotes;
- an operator-reviewed model allowlist and fixed-point quality priors.

All money is `bigint` internally and decimal atomic-unit strings at serialized boundaries. Never
use JavaScript floating point for USDC or token accounting.

## Installation

Install the stable package explicitly:

```bash
npm install @onchainrouter/routing@0.2.1
```

To build and test the exact published source:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @onchainrouter/routing build
pnpm --filter @onchainrouter/routing test
```

## Quick start

The quote port below is intentionally a placeholder. In an Onchain Router integration it must call
the canonical service's free `/v1/quotes` endpoint with the identical request that will later be
paid. Do not substitute a local price estimate.

```ts
import {
  DeterministicSmartRouter,
  createRoutingPolicy,
  type RouteModel,
  type RouteQuotePort,
} from '@onchainrouter/routing';

const models: RouteModel[] = [
  {
    id: 'model-from-live-catalog',
    enabled: true,
    category: 'text_generation',
    capabilities: ['text', 'json'],
    maximumOutputTokens: 8192,
    qualityBasisPoints: { general: 8000, code: 8200, reasoning: 7800 },
  },
];

const policy = createRoutingPolicy({
  allowedModels: models.map(({ id }) => id),
  maximumCandidates: 8,
  maximumHealthAgeMs: 60_000,
  unknownHealthBasisPoints: 5_000,
});

const quotes: RouteQuotePort = {
  async quote(input) {
    // Fetch one authoritative, unexpired quote for input.request and input.model.
    return {
      model: input.model,
      maximumAtomic: 25_000n,
      catalogVersion: 'catalog-version-from-quote',
      expiresAt: Date.now() + 30_000,
    };
  },
};

const decision = await new DeterministicSmartRouter(policy, quotes).route({
  endpoint: '/v1/chat/completions',
  kind: 'openai',
  profile: 'auto',
  body: {
    messages: [{ role: 'user', content: 'Return one JSON object.' }],
    max_tokens: 256,
  },
  models,
  localMaximumAtomic: 100_000n,
});

console.log(decision.selectedModel, decision.selectedMaximumAtomic);
```

Application developers should normally use `OnchainRouterBuyer.routedChat()` from
`@onchainrouter/client`; it connects routing to the ordinary Buyer Runtime payment and receipt
path without creating a second wallet or settlement implementation.

## Decision contract

The router applies this order:

1. enforce the immutable model allowlist and capability, context, and output constraints;
2. exclude fresh unavailable health while treating stale health as unknown;
3. obtain an authoritative maximum for every eligible candidate;
4. reject expired, failed, over-cap, or catalog-drifting quotes;
5. rank the remaining candidates with integer quality, cost, latency, reliability, and preference
   scores;
6. return one selected model and a content-free explanation.

`fallbackAuthorized` is always `false`. Prompt text is classification input only; it cannot change
the origin, allowlist, network, asset, recipient, maximum, quote port, or fallback behavior.

## Qualification limits

The repository includes versioned calibration and held-out benchmark machinery, but the current
held-out qualification did not meet every quality threshold. Historical reports are retained as
evidence and must not be tuned or rerun as fresh evidence. Do not advertise cost savings, quality
gains, or production automatic routing until RTE-003 passes with a newly frozen suite.

Provider-backed benchmark functions can consume provider credits. They are deliberately separate
from automated tests and must only run under an explicit call budget. They never exercise x402 or
USDC settlement.

## Security

- Derive eligible models from live discovery intersected with the local Buyer Runtime policy.
- Bind quotes to the exact request, model, endpoint, origin, and catalog version.
- Reject selection when every route is unavailable, unquoted, expired, over the local cap, or on a
  different catalog version.
- Never route around `ProviderOutcomeUnknown` or `SettlementOutcomeUnknown` with another model.
- Keep prompts, completions, wallet identifiers, and signatures out of routing evidence and logs.
- Review the [routing threat model](https://github.com/OnchainRouter/onchain-router/blob/main/packages/routing/routing-threat-model.md) before adding a quote or health port.

Report security issues using the repository [`SECURITY.md`](https://github.com/OnchainRouter/onchain-router/blob/main/SECURITY.md).

## Troubleshooting

- `no eligible routes`: compare live capabilities and output/context limits with the immutable
  allowlist.
- `no usable bounded quote`: refresh discovery and quotes; do not fall back to estimated pricing.
- `catalog version`: discard the whole decision and re-quote every eligible candidate.
- `over_local_maximum`: lower the request or ask the human to review policy outside the agent path.
- Unexpected selection: inspect the content-free `routes`, `exclusions`, policy hash, quote maxima,
  and fixed-point priors; never log the prompt to debug routing.

## Support

Documentation: <https://onchainrouter.dev/docs/routing>

Issues: <https://github.com/OnchainRouter/onchain-router/issues>

Include the package version, policy hash, catalog version, sanitized exclusions, and an exact
reproduction without user content.

## License

MIT. See [LICENSE](LICENSE).
