# Upstream audit record

The constraint-first selection architecture was reviewed against BlockRun `router-core` under the
MIT License:

- repository: `https://github.com/BlockRunAI/router-core`
- audited commit: `5d911879d7f1eddf93d513b08798998320272cc8`
- license SHA-256: `37f4169b05a63735761d006857ac1a94eaf087fecf07b1948f872a375efbb48f`
- reviewed tool-intent SHA-256: `081b3ab3a7d8310265262ef1e650534facc5cf7de0fc9f13915c433277aaad05`
- reviewed rules SHA-256: `83f2fd2b809a856fbb5715b191b8bcccaaad981c062a7b822e1ccce3c1d6fc0b`

This package is a clean local implementation. It does not import the upstream model catalog,
benchmark priors, branding, telemetry, float-based cost calculation, hard-coded fee, or portfolio
selector. Only the bounded architectural ideas of deterministic classification followed by hard
constraints informed the design.

The separate client boundary was reviewed against ClawRouter under the MIT License:

- repository: `https://github.com/BlockRunAI/ClawRouter`
- audited commit: `477413a30c163782f8d475451aa1aba5219b4c22`
- license SHA-256: `d97c86c56bddf57d6439abd69a468733a01b7142e850c60918fb41b65c9d894a`

ClawRouter's wallet generation, raw-key configuration, BlockRun endpoints, Base/Solana payment
stack, retries, streaming, catalog, branding, telemetry, and broad tool surface are explicitly not
used. The separate Onchain Router OpenClaw adapter uses only the provider/plugin registration shape
and delegates payment execution to the loopback Buyer Runtime proxy.
