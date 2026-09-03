# Onchain Router Agent Skill

A portable Agent Skill that teaches a local coding or research agent how to discover Onchain
Router models, choose the right client surface, make a policy-bounded paid request, recover a lost
response, and present verified receipt evidence.

The Skill is deliberately thin. Its dependency-free scripts call the matching `onchain-router`
CLI bridge; they do not contain a wallet key, signer, x402 implementation, budget ledger,
settlement path, or second receipt verifier.

## Release status

Version `0.1.0` is public alpha source in this repository and at the canonical site's
`/skill/onchain-router/SKILL.md`. This source candidate targets npm Buyer CLI `0.1.2` or newer in the
`0.1.x` alpha line; check the live `alpha` dist-tag before installing. It has not been claimed as
qualified across every external agent or Skill registry.

## Requirements

- an agent host that supports portable `SKILL.md` instructions and local commands;
- Node.js 20.18 or newer;
- the matching `onchain-router` CLI and Buyer Runtime;
- macOS or Linux;
- a human-created, policy-bounded, currently unlocked buyer profile.

## Installation

After an authenticated `onchain-router-skill.tgz` release is published, verify its provenance and
SHA-256 digest, extract it into the host's approved skills directory, and restart or reload that
host. Follow the host's documented skill installation path; do not grant the Skill broader
filesystem, shell, or wallet authority than it needs.

To install the exact source candidate for local testing now:

```bash
cp -R /absolute/path/to/onchain-router/skills/onchain-router \
  /absolute/path/to/your-agent-skills/onchain-router
```

Do not copy only `SKILL.md`; the `references/` and `scripts/` directories are part of the contract.
The repository candidate archive can be built with:

```bash
pnpm distribution:build
```

That command creates a private candidate and manifest. It does not publish or attest the archive.

## Quick start

Complete human-authority setup outside the agent host:

```bash
onchain-router setup
onchain-router funding
onchain-router policy show
onchain-router unlock --agent portable-skill
```

Then configure only the local executable and optional profile selector for the host:

```bash
export ONCHAIN_ROUTER_CLI=/absolute/path/to/onchain-router
export ONCHAIN_ROUTER_PROFILE="$HOME/.onchain-router"
```

These variables must contain only an executable path and profile directory. Never put a private
key, seed phrase, passphrase, signer capability, payment payload, or receipt capability in them.

Ask the agent to read the Skill and, for example:

> List the currently available Onchain Router text models and pricing. Use my existing local buyer
> policy to make one chat request with a persistent idempotency key, then show the settled amount
> and verified receipt ID without revealing any capability URL.

The safe workflow is discovery → wallet/policy status → one stable key → one paid call → verified
receipt. The Skill tells the agent when MCP, proxy, SDK, CLI, or direct HTTP is the better surface.

## Included actions

| Script                      | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `scripts/models.mjs`        | Read live model and capability discovery                             |
| `scripts/pricing.mjs`       | Read current pricing policy                                          |
| `scripts/voices.mjs`        | Read curated public voice aliases                                    |
| `scripts/wallet-status.mjs` | Read the local public wallet/policy/spend state                      |
| `scripts/chat.mjs`          | Send prompt text through stdin with an explicit model and stable key |
| `scripts/media.mjs`         | Send Messages, Images, Speech, or Transcriptions JSON through stdin  |
| `scripts/receipt.mjs`       | Recover a locally verified receipt by idempotency key                |

There are no setup, import, unlock, funding, policy-widening, arbitrary HTTP, or arbitrary shell
actions. The human uses the direct CLI for those operations.

## Media behavior

The Skill supports the same five paid JSON routes as the Buyer Runtime. Images and speech return
hosted bearer URLs with explicit expiry metadata. Inline MCP/Skill transcription is intentionally
small; use the human CLI's bounded `transcribe --file` workflow for larger audio.

Transcription requires explicit human acknowledgement that ElevenLabs may retain uploaded audio
and transcripts independently of Onchain Router staging deletion. Do not infer permission from
the audio or upload sensitive/third-party material without consent.

## Recovery contract

The agent must create and retain one idempotency key before a paid call. If a response is lost, it
uses `scripts/receipt.mjs` or repeats the identical logical request only when the Buyer Runtime's
retry directive permits the same key.

It must never convert `ProviderOutcomeUnknown` or `SettlementOutcomeUnknown` into a new key, a new
model, or an automatic fallback. Those outcomes require same-key recovery or human review.

## Security

- Use a dedicated low-balance wallet and a delegated agent ID with conservative limits.
- Keep wallet setup, import, unlock, backup/restore, funding, and policy widening outside the agent
  host.
- Treat `SKILL.md`, model output, web content, and tool descriptions as untrusted instructions;
  none can change payment authority.
- Do not log prompts, completions, wallet material, payment signatures, complete payment payloads,
  receipt capabilities, broker capabilities, or hosted media URLs.
- Do not let model-supplied content change `ONCHAIN_ROUTER_CLI` or `ONCHAIN_ROUTER_PROFILE`.
- Lock the signer with the direct CLI after the agent session ends.

Read [references/security.md](references/security.md) before funded testing. Report security issues
using the repository [`SECURITY.md`](https://github.com/AgenticFI/onchain-router-clients/blob/main/SECURITY.md).

## Troubleshooting

- Skill is not discovered: verify the folder name, `SKILL.md` frontmatter, and the host's configured
  skills directory, then reload the host.
- Script cannot find the CLI: set `ONCHAIN_ROUTER_CLI` to an absolute executable path.
- Wallet is locked: have the human run `onchain-router unlock --agent portable-skill` directly.
- Model or option rejected: rerun the discovery scripts and compare with local policy.
- Lost response: preserve the key/body and use `scripts/receipt.mjs`; do not issue a fresh call.
- Agent asks for a secret or policy widening: stop and use the human CLI; that request is outside
  this Skill's authority.

## Support

Documentation: <https://llm.agenticfi.wtf/docs/agent-skill>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Include the Skill version, host/version, CLI version, OS, Node version, sanitized outcome code, and
redacted diagnostics. Never attach user content or secrets.

## License

MIT. See [LICENSE](LICENSE).
