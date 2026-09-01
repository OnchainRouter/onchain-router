import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateProxyToken, PROXY_TOKEN_FILENAME } from '../src/token.js';

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-proxy-token-'));
  directories.push(path);
  await chmod(path, 0o700);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('local proxy bearer storage', () => {
  it('creates one stable owner-only bearer without a wallet secret', async () => {
    const root = await directory();
    const first = await loadOrCreateProxyToken(root);
    const second = await loadOrCreateProxyToken(root);
    expect(first).toEqual(second);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(first.tokenFile, 'utf8')).toBe(first.token);
    const { mode } = await import('node:fs/promises').then(
      async ({ stat }) => await stat(first.tokenFile),
    );
    expect(mode & 0o077).toBe(0);
  });

  it('fails closed for a malformed or symlinked bearer file', async () => {
    const malformed = await directory();
    await writeFile(join(malformed, PROXY_TOKEN_FILENAME), 'short', { mode: 0o600 });
    await expect(loadOrCreateProxyToken(malformed)).rejects.toThrow('bearer file is malformed');

    const linked = await directory();
    const target = join(linked, 'target');
    await writeFile(target, 'a'.repeat(43), { mode: 0o600 });
    await symlink(target, join(linked, PROXY_TOKEN_FILENAME));
    await expect(loadOrCreateProxyToken(linked)).rejects.toThrow('regular file');
  });
});
