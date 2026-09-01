import { invokeBuyer } from './cli-bridge.mjs';
import { readStdin } from './read-stdin.mjs';

const endpoints = {
  messages: '/v1/messages',
  images: '/v1/images/generations',
  speech: '/v1/audio/speech',
  transcriptions: '/v1/audio/transcriptions',
};
try {
  const [kind, option, key, ...extra] = process.argv.slice(2);
  if (
    !Object.hasOwn(endpoints, kind ?? '') ||
    option !== '--idempotency-key' ||
    !key ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) ||
    extra.length
  )
    throw new Error(
      'use media.mjs <messages|images|speech|transcriptions> --idempotency-key <stable-key>; send JSON on stdin',
    );
  const body = JSON.parse(await readStdin(1_000_000));
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('expected a bounded JSON object');
  if (kind === 'transcriptions' && body.acknowledge_provider_retention !== true)
    throw new Error(
      'obtain human consent to ElevenLabs retained-mode audio processing before setting acknowledge_provider_retention: true',
    );
  if (kind === 'images' && body.response_format && body.response_format !== 'url')
    throw new Error('portable media tools return hosted image URLs');
  process.exitCode = invokeBuyer({
    action: 'execute',
    endpoint: endpoints[kind],
    idempotencyKey: key,
    body,
  });
} catch {
  process.stderr.write(
    'Media input rejected. Use a supported kind, stable key, bounded JSON stdin, and explicit transcription retention consent. No payment was attempted.\n',
  );
  process.exitCode = 2;
}
