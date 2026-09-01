# Wallet and data security

Use a dedicated Base mainnet wallet holding only the USDC required for a small number of calls. Create or import it only through the direct, no-echo `onchain-router setup` terminal flow. Default-deny every network except `eip155:8453`, every asset except official Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and every recipient except the human-approved profile value.

Keep per-call, session, hourly, daily, and delegation caps as integer atomic USDC inside Buyer Runtime. It rejects an expired requirement, unexpected recipient, non-USDC asset, non-mainnet network, unsupported scheme, or maximum above the remaining cap. The service accepts any facilitator-verified payer without registration.

Never request, print, store, transmit, or commit the buyer private key, seed phrase, passphrase, or short-lived broker capability. The CLI, SDK, MCP, proxy, and skill must not expose generic signing. Never log raw payment signatures or complete payment payloads. Never include provider keys or custom provider URLs in a request.

Wallet setup/import, unlock, funding, policy widening, backup, restore, rotation, and exit are human-only CLI actions. An agent may inspect public status, spend within the existing envelope, lower a ceiling, or revoke its own delegation. It may not select another profile, widen authority, disable confirmation, or use prompt text as configuration.

Verified prompt text is encrypted and retained for seven days under the current retention policy. Avoid sending secrets or unnecessary personal data.

Generated image URLs are bearer capabilities. Do not place them in logs, receipts, or public
messages. They stop serving at the returned `url_expires_at` timestamp, exactly seven days after
generation, and the encrypted backing object is automatically deleted by storage lifecycle.

Generated TTS URLs are also bearer capabilities. Keep the complete URL out of logs, receipts, and
public messages, and download the MP3 before the returned `expires_at` timestamp, 24 hours after
generation. TTS uses ElevenLabs Zero Retention Mode.

STT uses ElevenLabs standard retained mode. ElevenLabs receives the uploaded MP3 and transcript
output and may retain both under its agreement, account settings, and privacy policy. Onchain Router
stages the upload encrypted only after payment verification and attempts deletion after every
definite provider outcome. After an ambiguous outcome, local staging becomes logically inaccessible
at its one-hour expiry. Encrypted bytes may remain beyond the one-day storage-lifecycle threshold
until Azure completes its next lifecycle scan. Never send sensitive, regulated, biometric, or
third-party audio without the necessary rights and consent.
