import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';
import { MAX_AUDIO_INPUT_BYTES } from '@agenticfi/onchain-router';

/** Explicit CLI file selection only; never exposed as an MCP/proxy path parameter. */
export async function readAudioFile(file: string): Promise<string> {
  const path = resolve(file);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if ((await realpath(path)) !== path) throw new Error('symlink');
    const initial = await lstat(path);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.uid !== process.getuid?.() ||
      initial.size < 1 ||
      initial.size > MAX_AUDIO_INPUT_BYTES
    )
      throw new Error('unsafe file');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino ||
      before.size !== initial.size
    )
      throw new Error('changed file');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('short read');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink()
    )
      throw new Error('changed file');
    return bytes.toString('base64');
  } catch {
    throw new PaymentPolicyRejected(
      'audio input must be an unchanged, owner-owned regular file of at most 25 MiB, without symlinks',
    );
  } finally {
    await handle?.close();
  }
}
