# Contributing

Thank you for improving Onchain Router clients. Keep changes inside the public client boundary; the
hosted AgenticFI gateway and its production configuration are maintained separately.

## Before opening a pull request

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm deps:native
pnpm verify
pnpm pack:release
```

Add tests for behavior changes. Preserve the financial invariants: validate policy and the official
x402 challenge before signing, reserve budget atomically, never settle or release an unverified
result, never exceed the signed maximum, and never turn an ambiguous paid outcome into a new paid
request.

Do not add prompts, completions, wallet material, payment signatures, receipt capabilities,
provider keys, npm tokens, local databases, or generated release archives to a commit or issue.

Use a focused branch and a conventional commit (`feat:`, `fix:`, `docs:`, `test:`, or `chore:`).
Report security issues privately through [SECURITY.md](SECURITY.md), not a public issue.
