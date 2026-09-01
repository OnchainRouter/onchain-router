import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import {
  buyerProfilePaths,
  readBuyerSession,
  removeBuyerSession,
  writeBuyerSession,
} from './profile.js';

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-profile-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('owner-only buyer profile', () => {
  it('stores a strict owner-only descriptor without exporting its bearer helper publicly', async () => {
    const root = await directory();
    const paths = buyerProfilePaths(root);
    await writeBuyerSession(root, {
      address: '0x1111111111111111111111111111111111111111',
      agentId: 'test-agent',
      sessionId: 'test-session',
      socketPath: paths.socketPath,
      capability: 'a'.repeat(43),
      idleExpiresAt: 1_000,
      absoluteExpiresAt: 2_000,
    });
    expect((await lstat(paths.sessionPath)).mode & 0o777).toBe(0o600);
    await expect(readBuyerSession(root)).resolves.toMatchObject({
      agentId: 'test-agent',
      capability: 'a'.repeat(43),
    });
    expect(publicApi).not.toHaveProperty('readBuyerSession');
    expect(publicApi).not.toHaveProperty('writeBuyerSession');
    await removeBuyerSession(root);
    await expect(readBuyerSession(root)).resolves.toBeNull();
  });

  it('refuses a symbolic-link session descriptor', async () => {
    const root = await directory();
    const paths = buyerProfilePaths(root);
    const outside = join(await directory(), 'outside.json');
    await writeBuyerSession(root, {
      address: '0x1111111111111111111111111111111111111111',
      agentId: 'test-agent',
      sessionId: 'test-session',
      socketPath: paths.socketPath,
      capability: 'a'.repeat(43),
      idleExpiresAt: 1_000,
      absoluteExpiresAt: 2_000,
    });
    await rm(paths.sessionPath);
    await symlink(outside, paths.sessionPath);
    await expect(readBuyerSession(root)).rejects.toMatchObject({ code: 'PaymentPolicyRejected' });
  });
});
