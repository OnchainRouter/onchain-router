# API contract

Use `POST /v1/chat/completions` with an OpenAI-compatible non-streaming body:

```json
{
  "model": "gemini-3.6-flash",
  "messages": [{ "role": "user", "content": "Explain why the sky is blue." }],
  "max_tokens": 1024,
  "stream": false
}
```

Discover models through `GET /v1/models`. Treat `max_tokens` as an output ceiling. It defaults to 512, must be a positive integer, and cannot exceed the model's published limit or 65,536.

The model response is organized by available capability category. `text_generation` maps
OpenAI-compatible clients to `POST /v1/chat/completions` and Anthropic-compatible clients to
`POST /v1/messages`. `image_generation` maps to `POST /v1/images/generations`, `text_to_speech`
maps to `POST /v1/audio/speech`, and `speech_to_text` maps to
`POST /v1/audio/transcriptions`, which accepts canonical Base64 JSON or multipart form data. Use only categories, model aliases, formats, and endpoints returned
by the live catalog. The public speech catalog exposes ElevenLabs Flash v2.5 TTS and Scribe v2 STT,
both for MP3 only; other speech models and formats remain unavailable.

Use `POST /v1/images/generations` with an OpenAI-compatible body:

```json
{
  "model": "gemini-3.1-flash-lite-image",
  "prompt": "A small observatory beneath a clear night sky, editorial illustration",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

The current public endpoint accepts one 1024×1024 image. The default response includes a capability URL,
`backed_up: true`, `url_retention_days: 7`, and the exact `url_expires_at`. Download it before
expiration and avoid exposing the complete URL in logs. Request `b64_json` only when inline bytes
are required; the response still includes the seven-day URL.

Use `POST /v1/audio/speech` with an OpenAI-shaped JSON body:

```json
{
  "model": "elevenlabs/flash-v2.5",
  "input": "Your text to speak.",
  "voice": "darian",
  "response_format": "mp3",
  "speed": 1
}
```

Choose a public voice alias from `GET /v1/audio/voices`; omitting `voice` uses Darian. Read the
hosted MP3 from `data[0].url`, its exact 24-hour deadline from `data[0].expires_at`, and measured
characters from `usage.input_characters`. Download the file before expiration and keep the complete
capability URL out of logs and public messages.

Use `POST /v1/audio/transcriptions` with canonical Base64 JSON when a client cannot construct a file upload:

```json
{
  "audio_base64": "SUQzBAAAAA...",
  "model": "elevenlabs/scribe-v2",
  "response_format": "json"
}
```

The `audio_base64` value must be canonical RFC 4648 Base64 with no data-URL prefix or whitespace. Alternatively, send one complete multipart body:

```bash
curl --request POST https://onchainrouter.dev/v1/audio/transcriptions \
  --header "x-idempotency-key: 11111111-1111-4111-8111-111111111111" \
  --form "file=@speech.mp3;type=audio/mpeg" \
  --form "model=elevenlabs/scribe-v2" \
  --form "response_format=json"
```

The ordinary JSON or multipart request receives HTTP 402 and does not pay. The service validates the MP3 before
quoting so it can derive the maximum from inspected duration. Validate and sign the challenge with
an official x402 client, then retry the identical body and idempotency key with the
payment header. Read the transcript from `text` and measured duration from `usage.input_audio_ms`.
ElevenLabs processes the upload and transcript output in standard retained mode; do not submit
sensitive or regulated audio.

Read detailed rates from `GET /v1/pricing`. Check public Base USDC chain state with
`GET /v1/balance?address=0x...`; this lookup never connects a wallet or requests a signature.

Read visible Chat Completions output from `choices[0].message.content`, completion state from `choices[0].finish_reason`, and normalized counts from `usage`. Ignore provider-specific thought signatures unless raw output was explicitly requested.

Use the live `/openapi.json` for the concise public Chat Completions, Messages, Image Generations,
Text to Speech, Speech to Text, Voices, Models, Pricing, and Balance schemas. Quote, receipt, media
delivery, protocol-discovery, and health routes are support surfaces rather than separate
agent-directory products.
