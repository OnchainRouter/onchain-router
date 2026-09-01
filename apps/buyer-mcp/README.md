# Onchain Router MCP

Give an MCP-compatible agent bounded access to Onchain Router models, text, images, speech, wallet
status, and verified receipts—without giving the agent a wallet key or a way to widen spending
policy.

This is a focused local stdio server. It delegates every paid action to the same Buyer Runtime used
by the CLI and SDKs; it does not implement signing, settlement, budgets, retries, or receipt
verification itself.

## Release status

Version `0.1.0` is a bounded public alpha published under the npm `alpha` dist-tag. It is not yet a
stable release or a claim of qualification across every MCP host. The server never owns wallet
setup, import, funding, unlock, or policy-widening authority.

## Tools

The server exposes exactly nine tools:

| Tool                            | Cost | Purpose                                                          |
| ------------------------------- | ---- | ---------------------------------------------------------------- |
| `onchain_router_models`         | Free | Live models, pricing context, and local limits                   |
| `onchain_router_voices`         | Free | Curated speech voice discovery                                   |
| `onchain_router_wallet`         | Free | Read-only address, balance, policy, spend, and delegation status |
| `onchain_router_receipt`        | Free | Locally verified receipt by idempotency key                      |
| `onchain_router_chat`           | Paid | Non-streaming OpenAI-compatible text request                     |
| `onchain_router_messages`       | Paid | Anthropic-shaped text request                                    |
| `onchain_router_images`         | Paid | One hosted generated image                                       |
| `onchain_router_speech`         | Paid | Hosted MP3 text-to-speech output                                 |
| `onchain_router_transcriptions` | Paid | Bounded MP3 Base64 speech-to-text                                |

There are deliberately no setup, import, unlock, export, rotation, funding, policy-widening,
arbitrary HTTP, or generic shell tools. Paid tools accept no origin, network, asset, recipient,
signed maximum, wallet secret, passphrase, broker capability, or receipt capability.

## Requirements

- Node.js 20.18 or newer;
- macOS or Linux;
- the matching Onchain Router CLI and Buyer Runtime;
- an MCP client that can launch a local stdio server;
- a human-created and currently unlocked buyer profile.

## Installation

Install the bounded alpha, then pin the exact `0.1.0` version in the MCP host:

```json
{
  "mcpServers": {
    "onchain-router": {
      "command": "npx",
      "args": ["--yes", "@agenticfi/onchain-router-mcp@0.1.0"]
    }
  }
}
```

Do not use an unpinned floating package version for a wallet-connected tool. Upgrade only after
reviewing release notes and provenance.

To build the source candidate now:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm buyer:deps
pnpm exec turbo run build --filter=@agenticfi/onchain-router-mcp...
node apps/buyer-mcp/dist/index.js --print-config --profile "$HOME/.onchain-router"
```

The last command emits deterministic stdio configuration for that exact repository-built file.

## Quick start

First complete wallet and policy operations in a direct human terminal:

```bash
onchain-router setup
onchain-router funding
onchain-router policy show
onchain-router unlock --agent mcp
```

Register the source build in an MCP host using an absolute path. For example, Claude Code's local
development registration is:

```bash
claude mcp add onchain-router -s user -- \
  node /absolute/path/to/onchain-router/apps/buyer-mcp/dist/index.js \
  --profile "$HOME/.onchain-router"
```

Then ask the host to call `onchain_router_models`, select an enabled model within local policy,
create one persistent idempotency key, and call the appropriate paid tool. The tool result returns
the normal response plus content-free payment and receipt evidence.

If the human policy requires confirmation for every call, paid MCP tools fail closed. MCP is not a
trusted passphrase or confirmation channel. Only the human CLI may change that setting:

```bash
onchain-router policy set --confirm-each false
```

That command is a material policy decision, not an MCP setup step.

## Media limits

Media models and options must exist in live discovery and local policy. Images and speech return
hosted bearer URLs with explicit expiry metadata. MCP transcription accepts at most 768 KiB of MP3
audio (1,048,576 Base64 characters); use the CLI or SDK for larger files.

No tool reads an arbitrary filesystem path or fetches an arbitrary URL. Transcription requires
explicit acknowledgement that ElevenLabs may retain audio and transcripts independently of
Onchain Router staging deletion. Do not upload third-party or sensitive audio without permission.

## Cancellation and recovery

Cancellation is honored before a paid request reaches Buyer Runtime. After that handoff, Buyer
Runtime finishes or recovers the financial outcome even if the MCP client disconnects. A cancelled
or lost tool response must be inspected using `onchain_router_receipt` with the original
idempotency key.

Never replay an ambiguous call under a new key or on another model. `ProviderOutcomeUnknown` and
`SettlementOutcomeUnknown` require same-key recovery or human review.

## Security

- Use a dedicated low-balance wallet and a separate delegated agent ID with conservative limits.
- Keep setup, unlock, funding, backup/restore, and policy widening outside MCP.
- Pin the MCP package version and review the exact executable path/configuration.
- Do not place prompts, wallet material, passphrases, payment signatures, receipt capabilities, or
  hosted media URLs in MCP configuration or logs.
- Treat tool descriptions and model output as untrusted; they cannot change payment authority.
- Lock the signer through the direct CLI after the agent session ends.

Report security issues using the repository [`SECURITY.md`](https://github.com/AgenticFI/onchain-router-clients/blob/main/SECURITY.md).

## Troubleshooting

- Server will not start: run `onchain-router doctor` directly and verify Node, profile permissions,
  and the absolute executable path.
- Wallet tool reports locked: run `onchain-router unlock --agent mcp` in a human terminal.
- Paid tool fails closed for confirmation: keep per-call confirmation or have the human explicitly
  review the policy; never pass a passphrase through MCP.
- Model or media option rejected: call `onchain_router_models` or `onchain_router_voices` again.
- Lost tool response: use the original key with `onchain_router_receipt`; do not issue a fresh call.

## Support

Documentation: <https://llm.agenticfi.wtf/docs/mcp>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Include the package version, MCP host/version, OS, Node version, sanitized tool/outcome code, and
redacted `doctor` output. Never attach user content or secrets.

## License

MIT. See [LICENSE](LICENSE).
