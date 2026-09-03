# Onchain Router Python SDK

Use Onchain Router from Python while the local Buyer Runtime protects wallet keys, integer USDC
budgets, x402 recovery, and verified receipts. The Python package is a maintained, no-shell adapter
to the matching `onchain-router` CLI's versioned JSON bridge; it does not implement a second signer
or payment stack.

The client supports live model, pricing, voice, and balance discovery plus chat completions,
Anthropic-style messages, image generation, text-to-speech, speech-to-text, recovery, and locking.

## Release status

Version `0.1.0` is public alpha source with a deterministic local wheel builder. It is not currently
published on PyPI. This source release targets npm Buyer CLI `0.1.2` or newer in the `0.1.x`
alpha line; check the live npm `alpha` dist-tag before installing and do not infer a PyPI release
from the project name.

## Requirements

- Python 3.10 or newer;
- macOS or Linux;
- the matching `onchain-router` CLI on `PATH`;
- Node.js 20.18 or newer for that CLI and Buyer Runtime;
- a dedicated Base wallet funded with enough USDC for the intended calls.

Windows is not yet a supported host. Base mainnet is the only payment network in this client.

## Installation

Install the published CLI, then build the Python wheel from reviewed source because it is not on
PyPI:

```bash
npm install --global @agenticfi/onchain-router-cli@0.1.2
python clients/python/scripts/build_wheel.py
python -m pip install clients/python/dist/onchain_router-0.1.0-py3-none-any.whl
```

For repository development, set `command=("node", "/absolute/path/to/apps/buyer-cli/dist/index.js")`
instead of installing the CLI globally.

## One-time wallet setup

Run authority-changing commands directly in a human terminal:

```bash
onchain-router setup
onchain-router funding
onchain-router policy show
onchain-router unlock
```

Setup/import and unlock use direct no-echo prompts. `OnchainRouterBuyer` has no private-key,
seed-phrase, passphrase, or signer-capability parameter.

## Quick start

Run `onchain-router models` immediately before selecting a model. Persist the idempotency key with
the logical request so a lost response can be recovered safely.

```python
import uuid

from onchain_router import BuyerRuntimeError, OnchainRouterBuyer

buyer = OnchainRouterBuyer()
request_key = str(uuid.uuid4())

try:
    print(buyer.models())
    result = buyer.chat(
        model="gemini-3.6-flash",
        messages=[{"role": "user", "content": "Explain x402 in two sentences."}],
        idempotency_key=request_key,
        max_tokens=256,
        stream=False,
    )
    print(result)
except BuyerRuntimeError as error:
    print(error.code, error.retry, error.reference)
    # Follow error.retry. Never replace request_key after an ambiguous handoff.
finally:
    buyer.lock()
```

`buyer.lock()` ends the local signer session. Use a separate `OnchainRouterBuyer` instance per
profile and do not share it across untrusted agents.

## Discovery

```python
models = buyer.models()
pricing = buyer.pricing()
voices = buyer.voices()
balance = buyer.balance()
status = buyer.status()
```

Discovery is free. Refresh it instead of assuming a model, voice, image size, price, or provider
remains enabled. The local policy remains narrower than or equal to live discovery.

## Media examples

Images return a hosted bearer URL by default and currently expire after seven days:

```python
image = buyer.images(
    model="gemini-3.1-flash-lite-image",
    prompt="A geometric blue bridge on a white background",
    image_size="1K",
    aspect_ratio="1:1",
    response_format="url",
    idempotency_key=str(uuid.uuid4()),
)
```

Speech returns hosted MP3 JSON and currently expires after 24 hours:

```python
speech = buyer.speech(
    model="elevenlabs/flash-v2.5",
    text="Hello from Onchain Router.",
    response_format="mp3",
    idempotency_key=str(uuid.uuid4()),
)
```

Transcription accepts canonical MP3 Base64, not a path or URL. Explicit acknowledgement is
required because ElevenLabs can retain audio and transcripts independently of Onchain Router
staging deletion.

```python
import base64

with open("speech.mp3", "rb") as audio_file:
    audio_base64 = base64.b64encode(audio_file.read()).decode("ascii")
transcript = buyer.transcriptions(
    model="elevenlabs/scribe-v2",
    audio_base64=audio_base64,
    acknowledge_provider_retention=True,
    response_format="json",
    idempotency_key=str(uuid.uuid4()),
)
```

Read exact fields and limits from live discovery. Hosted URLs are bearer capabilities; download
them before expiry and do not log or publish the complete URL. For larger local audio, prefer the
CLI's bounded `transcribe --file` workflow.

## Errors, recovery, and receipts

`BuyerRuntimeError` contains a stable `code`, a safe `retry` directive, and an optional redacted
`reference`. The bridge bounds memory, never invokes a shell, suppresses subprocess stderr, and
allows up to 330 seconds by default for bounded media operations.

A timeout after paid handoff can be ambiguous. Preserve the original idempotency key and identical
body, then call `buyer.receipt(request_key)` or repeat only when the directive permits the same-key
request. Never turn `ProviderOutcomeUnknown` or `SettlementOutcomeUnknown` into a fresh key or a
call to a different model.

## Security

- Use a dedicated low-balance wallet and conservative human-owned policy.
- Keep setup, import, unlock, funding guidance, and policy widening in the direct CLI. Keep the
  lower-level encrypted backup/restore procedure owner-only.
- Do not pass wallet secrets in Python, command arguments, environment variables, prompts, logs,
  notebooks, traces, or issue reports.
- Disable automatic retries around paid calls and create the idempotency key before calling.
- Treat hosted media URLs and receipt capabilities as secrets.
- Obtain permission before sending third-party audio for retained provider processing.

Report security issues using the repository [`SECURITY.md`](https://github.com/AgenticFI/onchain-router-clients/blob/main/SECURITY.md).

## Troubleshooting

- `RuntimeUnavailable` / CLI not found: install or build the matching CLI, or pass an absolute
  no-shell `command` sequence.
- `WalletLocked`: run `onchain-router unlock` in a human terminal.
- Model or option rejected: refresh `models()`, `pricing()`, or `voices()` and compare with policy.
- Budget rejected: inspect `onchain-router status` and `onchain-router policy show`; do not widen
  policy inside an agent.
- Timeout or unknown outcome: keep the same key/body, inspect `receipt()`, and follow `error.retry`.

## Support

Documentation: <https://llm.agenticfi.wtf/docs/sdk>

Issues: <https://github.com/AgenticFI/onchain-router-clients/issues>

Include the package version, Python version, OS, matching CLI version, sanitized error code, and
redacted diagnostics. Never attach user content or secrets.

## License

MIT. See [LICENSE](https://github.com/AgenticFI/onchain-router-clients/blob/main/clients/python/LICENSE).
