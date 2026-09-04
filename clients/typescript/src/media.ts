import { PaymentPolicyRejected } from '@onchainrouter/buyer-core';
import type { ModelCatalog } from './discovery.js';

export const MAX_AUDIO_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_JSON_BYTES = Math.ceil(MAX_AUDIO_INPUT_BYTES / 3) * 4 + 65_536;
export const STT_RETENTION_NOTICE =
  'ElevenLabs may retain uploaded audio and transcripts under its own policy. Onchain Router deletes its encrypted staging after a definite outcome; ambiguous staging expires logically after one hour, with physical deletion later. This does not delete provider copies. Do not upload sensitive or third-party audio without permission.';

export interface ImageRequest extends Readonly<Record<string, unknown>> {
  readonly model: string;
  readonly prompt: string;
  readonly n?: 1;
  readonly image_size?: '0.5K' | '1K' | '2K' | '4K';
  readonly aspect_ratio?: string;
  readonly response_format?: 'url' | 'b64_json';
}
export interface SpeechRequest extends Readonly<Record<string, unknown>> {
  readonly model: string;
  readonly input: string;
  readonly voice?: string;
  readonly response_format?: 'mp3' | 'opus' | 'pcm' | 'wav';
  readonly speed?: number;
}
export interface TranscriptionRequest extends Readonly<Record<string, unknown>> {
  readonly model: string;
  readonly audio_base64: string;
  /** Local consent metadata, removed before request hashing or sending to the API. */
  readonly acknowledge_provider_retention: true;
  readonly language?: string;
  readonly diarize?: boolean;
  readonly num_speakers?: number;
  readonly timestamps?: 'none' | 'word' | 'character';
  readonly tag_audio_events?: boolean;
  readonly response_format?: 'json' | 'verbose_json';
}

export const MEDIA_ENDPOINTS = [
  '/v1/images/generations',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
] as const;
export type MediaEndpoint = (typeof MEDIA_ENDPOINTS)[number];

function reject(message: string): never {
  throw new PaymentPolicyRejected(message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    reject('media request must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character)) ||
    value.includes('\0') ||
    [...value].length > maximum
  )
    reject('media text is empty, malformed, or exceeds its limit');
  return value;
}
function oneOf(value: unknown, allowed: readonly unknown[], label: string): void {
  if (!allowed.includes(value)) reject(`${label} is not supported`);
}

/** Snapshot and bound input before asynchronous discovery or any upload/signing. */
export function prepareMediaBody(
  endpoint: MediaEndpoint,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const input = object(value);
  const allowed =
    endpoint === '/v1/images/generations'
      ? ['model', 'prompt', 'n', 'image_size', 'aspect_ratio', 'size', 'response_format']
      : endpoint === '/v1/audio/speech'
        ? ['model', 'input', 'voice', 'response_format', 'speed']
        : [
            'model',
            'audio_base64',
            'language',
            'diarize',
            'num_speakers',
            'timestamps',
            'tag_audio_events',
            'response_format',
            'acknowledge_provider_retention',
          ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    reject('unsupported media request field');
  if (
    typeof input['model'] !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(input['model'])
  )
    reject('media request requires an explicit model');
  const body = { ...input };
  if (endpoint === '/v1/images/generations') {
    text(body['prompt'], 4_000);
    oneOf(body['n'] ?? 1, [1], 'image count');
    oneOf(body['image_size'] ?? '1K', ['0.5K', '1K', '2K', '4K'], 'image size');
    if (
      body['size'] !== undefined &&
      (body['size'] !== '1024x1024' ||
        (body['image_size'] ?? '1K') !== '1K' ||
        (body['aspect_ratio'] ?? '1:1') !== '1:1')
    )
      reject('legacy image size conflicts with specification');
    const aspectRatio = body['aspect_ratio'] ?? '1:1';
    if (typeof aspectRatio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(aspectRatio))
      reject('invalid image aspect ratio');
    oneOf(body['response_format'] ?? 'url', ['url', 'b64_json'], 'image response format');
  } else if (endpoint === '/v1/audio/speech') {
    text(body['input'], 5_000);
    if (
      body['voice'] !== undefined &&
      (typeof body['voice'] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body['voice']))
    )
      reject('voice must be a public alias');
    oneOf(body['response_format'] ?? 'mp3', ['mp3', 'opus', 'pcm', 'wav'], 'speech format');
    const speed = body['speed'] ?? 1;
    if (
      typeof speed !== 'number' ||
      !Number.isFinite(speed) ||
      speed < 0.7 ||
      speed > 1.2 ||
      !Number.isInteger(speed * 1_000)
    )
      reject('invalid speech speed');
  } else {
    if (body['acknowledge_provider_retention'] !== true) reject(STT_RETENTION_NOTICE);
    delete body['acknowledge_provider_retention'];
    const audio = body['audio_base64'];
    if (
      typeof audio !== 'string' ||
      !audio.length ||
      audio.length > Math.ceil(MAX_AUDIO_INPUT_BYTES / 3) * 4 ||
      audio.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)
    )
      reject('audio must be bounded canonical Base64');
    const bytes = Buffer.from(audio, 'base64');
    if (!bytes.length || bytes.length > MAX_AUDIO_INPUT_BYTES || bytes.toString('base64') !== audio)
      reject('audio must be bounded canonical Base64');
    // The server performs full bounded container/duration inspection before challenging.
    if (
      !(
        bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
        (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      )
    )
      reject('only MP3 audio is currently supported');
    if (
      body['language'] !== undefined &&
      (typeof body['language'] !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body['language']))
    )
      reject('invalid transcription language');
    if (body['diarize'] !== undefined && typeof body['diarize'] !== 'boolean')
      reject('diarize must be boolean');
    if (body['tag_audio_events'] !== undefined && typeof body['tag_audio_events'] !== 'boolean')
      reject('tag_audio_events must be boolean');
    if (
      body['num_speakers'] !== undefined &&
      (body['diarize'] !== true ||
        !Number.isInteger(body['num_speakers']) ||
        Number(body['num_speakers']) < 1 ||
        Number(body['num_speakers']) > 32)
    )
      reject('speaker count requires diarization and a bounded integer');
    oneOf(
      body['response_format'] ?? 'json',
      ['json', 'verbose_json'],
      'transcription response format',
    );
    oneOf(body['timestamps'] ?? 'none', ['none', 'word', 'character'], 'transcription timestamps');
  }
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_MEDIA_JSON_BYTES)
    reject('media request exceeds its byte limit');
  return Object.freeze(JSON.parse(encoded) as Record<string, unknown>);
}

/** Discovery is advisory; server normalization and Buyer Runtime independently remain authoritative. */
export function validateMediaCatalog(
  endpoint: MediaEndpoint,
  body: Readonly<Record<string, unknown>>,
  catalog: ModelCatalog,
): void {
  const model = catalog.data.find((item) => item.id === body['model']);
  if (!model || !model.supported_endpoints?.includes(endpoint))
    reject('model is not available for this media endpoint');
  if (endpoint === '/v1/images/generations') {
    const spec = object(model['image']);
    oneOf(
      body['image_size'] ?? spec['default_image_size'],
      Array.isArray(spec['supported_image_sizes']) ? spec['supported_image_sizes'] : [],
      'model image size',
    );
    oneOf(
      body['aspect_ratio'] ?? spec['default_aspect_ratio'],
      Array.isArray(spec['supported_aspect_ratios']) ? spec['supported_aspect_ratios'] : [],
      'model aspect ratio',
    );
    oneOf(
      body['response_format'] ?? 'url',
      Array.isArray(spec['response_formats']) ? spec['response_formats'] : [],
      'model image response format',
    );
  } else if (endpoint === '/v1/audio/speech') {
    const spec = object(model['text_to_speech']);
    if (!Number.isSafeInteger(spec['maximum_characters']) || Number(spec['maximum_characters']) < 1)
      reject('invalid model speech limit');
    text(body['input'], Number(spec['maximum_characters']));
    oneOf(
      body['response_format'] ?? 'mp3',
      Array.isArray(spec['response_formats']) ? spec['response_formats'] : [],
      'model speech format',
    );
  } else {
    const spec = object(model['speech_to_text']);
    if (
      !Number.isSafeInteger(spec['maximum_audio_bytes']) ||
      Number(spec['maximum_audio_bytes']) < 1 ||
      Buffer.from(String(body['audio_base64']), 'base64').length >
        Number(spec['maximum_audio_bytes'])
    )
      reject('audio exceeds model input limit');
    oneOf(
      'mp3',
      Array.isArray(spec['accepted_formats']) ? spec['accepted_formats'] : [],
      'model audio format',
    );
  }
}
