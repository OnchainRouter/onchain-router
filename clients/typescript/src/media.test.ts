import { describe, expect, it } from 'vitest';
import { prepareMediaBody, validateMediaCatalog } from './media.js';
import type { ModelCatalog } from './discovery.js';

const catalog: ModelCatalog = {
  object: 'list',
  catalog_version: 'test',
  categories: [],
  data: [
    {
      id: 'image',
      supported_endpoints: ['/v1/images/generations'],
      image: {
        default_image_size: '1K',
        supported_image_sizes: ['1K'],
        default_aspect_ratio: '1:1',
        supported_aspect_ratios: ['1:1'],
        response_formats: ['url', 'b64_json'],
      },
    },
    {
      id: 'speech',
      supported_endpoints: ['/v1/audio/speech'],
      text_to_speech: { maximum_characters: 2_000, response_formats: ['mp3'] },
    },
    {
      id: 'stt',
      supported_endpoints: ['/v1/audio/transcriptions'],
      speech_to_text: { maximum_audio_bytes: 100, accepted_formats: ['mp3'] },
    },
  ],
};
describe('media adapter boundary', () => {
  it('snapshots exact specification and rejects dark model/specification combinations', () => {
    const input = { model: 'image', prompt: 'blue square' };
    const body = prepareMediaBody('/v1/images/generations', input);
    input.prompt = 'changed';
    expect(body['prompt']).toBe('blue square');
    expect(() => validateMediaCatalog('/v1/images/generations', body, catalog)).not.toThrow();
    expect(() =>
      validateMediaCatalog('/v1/images/generations', { ...body, image_size: '4K' }, catalog),
    ).toThrow();
    expect(() =>
      validateMediaCatalog('/v1/images/generations', { ...body, model: 'speech' }, catalog),
    ).toThrow();
  });
  it('rejects unsupported authority, unpaired Unicode, and oversized speech before upload', () => {
    for (const body of [
      { model: 'speech', input: 'hi', origin: 'https://evil.example' },
      { model: 'speech', input: '\ud800' },
      { model: 'speech', input: 'hi', voice: 'provider/key' },
    ])
      expect(() => prepareMediaBody('/v1/audio/speech', body)).toThrow();
    expect(() =>
      validateMediaCatalog(
        '/v1/audio/speech',
        { model: 'speech', input: 'a'.repeat(2_001) },
        catalog,
      ),
    ).toThrow();
  });
  it('requires retention acknowledgement and removes it from the exact request', () => {
    const input = { model: 'stt', audio_base64: Buffer.from('ID3audio').toString('base64') };
    expect(() => prepareMediaBody('/v1/audio/transcriptions', input)).toThrow('ElevenLabs');
    const body = prepareMediaBody('/v1/audio/transcriptions', {
      ...input,
      acknowledge_provider_retention: true,
    });
    expect(body).toEqual(input);
    expect(() => validateMediaCatalog('/v1/audio/transcriptions', body, catalog)).not.toThrow();
  });
  it('rejects paths, remote URLs, noncanonical Base64 and unsupported audio', () => {
    for (const audio_base64 of [
      '/etc/passwd',
      'https://evil.example/file',
      'SUQz\n',
      'AA==',
      'SUQz=',
    ])
      expect(() =>
        prepareMediaBody('/v1/audio/transcriptions', {
          model: 'stt',
          audio_base64,
          acknowledge_provider_retention: true,
        }),
      ).toThrow();
  });
});
