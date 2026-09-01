import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readAudioFile } from '../src/media-file.js';

describe('explicit CLI audio file input', () => {
  it('reads an owner file and rejects leaf/parent symlinks and directories', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-audio-'));
    try {
      await writeFile(join(root, 'audio.mp3'), 'ID3audio');
      expect(await readAudioFile(join(root, 'audio.mp3'))).toBe(
        Buffer.from('ID3audio').toString('base64'),
      );
      await symlink(join(root, 'audio.mp3'), join(root, 'link.mp3'));
      await expect(readAudioFile(join(root, 'link.mp3'))).rejects.toThrow('without symlinks');
      await expect(readAudioFile(root)).rejects.toThrow('regular file');
      await mkdir(join(root, 'nested'));
      await symlink(root, join(root, 'nested', 'parent'));
      await expect(readAudioFile(join(root, 'nested', 'parent', 'audio.mp3'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
