# Security Policy

Onchain Router handles wallet authority, USDC budgets, x402 payments, hosted-media capabilities,
and durable receipts. Please report suspected vulnerabilities privately so they can be investigated
without exposing users or funds.

## Supported versions

| Version                                       | Status                                                 |
| --------------------------------------------- | ------------------------------------------------------ |
| Production API at `https://onchainrouter.dev` | Supported                                              |
| Current `0.1.x` npm stable release            | Supported while listed as current in the release notes |
| Older commits and locally modified builds     | Best effort                                            |

The current `0.1.x` npm packages use the default `latest` dist-tag. Registry presence, provenance, and supported
versions must be verified against the canonical documentation and release page rather than inferred
from a package name.

## Report a vulnerability

Email **saren@agenticfi.wtf** with the subject `Onchain Router security report`.

Include only what is necessary to reproduce the issue:

- affected endpoint, package, version, and commit when known;
- environment and configuration with secrets removed;
- impact and the smallest safe reproduction;
- sanitized request/response metadata, outcome code, or transaction hash when relevant;
- whether exploitation could move funds, bypass policy, expose content, or cross a tenant boundary.

Do **not** email or post private keys, seed phrases, passphrases, payment signatures, complete
payment payloads, receipt capabilities, provider credentials, prompts, completions, uploaded
media, hosted-media capability URLs, or other personal data. If sensitive evidence is essential,
first ask for a secure transfer method and wait for confirmation.

Please do not open a public GitHub issue for an unpatched vulnerability.

## Coordinated disclosure

We aim to acknowledge reports within three business days, but as a one-person team response times
can vary. We will validate scope, assess financial and privacy impact, provide updates when
practical, and coordinate a disclosure date after a fix is available. Reports involving active
fund movement, wallet authority, secret exposure, or payment replay are prioritized.

Please avoid:

- accessing or changing data that is not yours;
- moving funds or settling a payment beyond the minimum necessary for an explicitly authorized
  test;
- denial of service, social engineering, phishing, spam, or physical attacks;
- persistence, destructive actions, or public disclosure before remediation;
- automated testing that creates paid requests without an explicit spending budget.

## Security design references

- [Buyer Runtime threat model](packages/buyer-core/buyer-core-threat-model.md)
- [Local proxy threat model](apps/buyer-proxy/buyer-proxy-threat-model.md)
- [Smart-routing threat model](packages/routing/routing-threat-model.md)
- [Stable client release scope](docs/release-scope.md)

Security reports do not authorize production access, wallet use, provider calls, package
publication, or deployment.
