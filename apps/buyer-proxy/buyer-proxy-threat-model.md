# Local buyer proxy threat model

## Scope and assets

This model covers the private BEQ-4 `@onchainrouter/proxy` process, its owner-only local bearer,
the loopback HTTP listener, and its handoff to the already-reviewed Buyer Runtime. The protected
assets are wallet signing authority, local budget/policy state, the bearer, prompts/results,
idempotency identities, receipt access, and the distinction between definite and ambiguous paid
outcomes.

The proxy is supported only on the same trusted single-user macOS/Linux host as Buyer Runtime. It
does not make a shared or hostile same-UID host safe, and it does not replace the encrypted vault,
signer broker, SQLite ledger, official x402 client, or server-side PostgreSQL controls.

## Trust boundaries

```text
OpenAI-compatible local client
  -> bearer-authenticated 127.0.0.1 HTTP
  -> thin proxy validation/formatting
  -> @onchainrouter/client
  -> Buyer Runtime + owner-only signer broker/SQLite policy
  -> canonical public Onchain Router origin
```

The request body and every header are untrusted. Prompt text is data, never authority. The only
local authority inputs are the process-start profile and its generated bearer file. Origin,
network, asset, recipient, scheme, model allowlist, output ceiling, confirmation rule, and integer
atomic limits remain in the human-owned Buyer Runtime profile.

## Primary threats and controls

| Threat                                     | Control                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LAN/public exposure                        | No host option exists; the listener binds and verifies `127.0.0.1` only.                                                                                                                                     |
| DNS rebinding or forged absolute target    | Require the exact runtime `127.0.0.1:port` Host and origin-form fixed paths.                                                                                                                                 |
| Malicious website spends through localhost | Reject every `Origin` and cookie request; emit no CORS allow headers; require bearer auth. Node clients may send Fetch Metadata-like headers, so those headers alone are not treated as browser authority.   |
| Unrelated OS user spends                   | Generate a 256-bit bearer in the owner-only profile and require it on every route.                                                                                                                           |
| Same-UID compromise                        | Residual risk: another process under the same account may read files/process state. Use a dedicated low-balance wallet, short broker session, small delegation, immediate lock, and trusted-host assumption. |
| Request raises financial authority         | Reject top-level payment/origin/network/asset/recipient/wallet fields; Buyer Runtime independently enforces all policy.                                                                                      |
| Body/header exhaustion or smuggling        | 128 KiB streamed body cap, header-count/timeout limits, duplicate-header rejection, no content encoding, and no ambiguous length.                                                                            |
| Paid blind retry after disconnect          | Proxy performs no paid retry. Buyer Runtime owns one identical x402 retry and durable same-key recovery.                                                                                                     |
| Ambiguity presented as retryable outage    | Provider/settlement unknown maps to explicit HTTP 409 plus `human_review`, without `Retry-After`. Unexpected post-handoff failure is classified settlement-unknown.                                          |
| Cancellation interrupts settlement         | Honor cancellation before handoff; ignore it after Buyer Runtime accepts the operation so it can finalize or classify safely.                                                                                |
| Secret/content leak                        | No request logging, no diagnostics route, no wallet/receipt-token endpoint, safe startup errors, and response headers omit signatures, bearer, and receipt capability.                                       |
| Browser or arbitrary proxy feature creep   | Only exact models/chat paths exist; streaming, CONNECT, Upgrade, wallet management, arbitrary URLs, images, speech, and provider override endpoints are absent.                                              |

## Residual risks and release gates

ADR-056 adds a bounded, non-persistent exact text response cache behind the existing HTTP
authentication boundary. Keys include exact request content and origin/wallet/agent/session/
policy/catalog identity. Live broker/policy/catalog checks precede reuse. Detected lock or
discovery/policy failure clears it; expiry timers and shutdown discard entries. Only verified,
durable text successes seed it; tool/media/extension requests, failures, and explicit idempotency
keys bypass it. Hits have source-receipt references and zero-new-charge metadata, never a new
payment proof. `Cache-Control: no-store` still prevents downstream caching.

The content cache temporarily retains answers in local RAM, not prompts on disk or logs. Same-UID
compromise can read that RAM; byte budgets measure serialized content, not total JavaScript heap.
Cache reads do not extend TTL. A lock is detected on the next request; close the proxy to clear
immediately. Stochastic or time-sensitive responses require explicit refresh/bypass. Concurrent
fresh misses are not deduplicated, and exact paid recovery remains Buyer Runtime's responsibility.

- The bearer travels over plaintext HTTP on kernel loopback. Public/LAN binding is forbidden; local
  TLS is not claimed.
- Same-UID malware can often read the bearer or instrument the client. Owner-only permissions are
  not an OS-account sandbox.
- A caller that omits a stable idempotency key cannot recover a response lost before it learns the
  generated key. Supported recovery clients must generate and retain the key before the call.
- The proxy cannot make a policy requiring per-call human confirmation autonomous. Such requests
  fail closed unless a human explicitly changes policy through the CLI.
- Public registry publication, supported-client clean installs, a funded request, production
  wallet use, paid mainnet execution, deployment, and external rollout remain blocked by ADR-047
  and the applicable Milestone 5/BEQ gates.
