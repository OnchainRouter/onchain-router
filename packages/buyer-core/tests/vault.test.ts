import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { PaymentPolicyRejected } from '../src/errors.js';
import { WalletVault } from '../src/vault.js';

const directories: string[] = [];
const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'different correct horse battery';

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-vault-'));
  directories.push(path);
  return path;
}

function vault(path: string): WalletVault {
  return new WalletVault({ directory: path, scryptN: 1_024, allowWeakTestKdf: true });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe('encrypted wallet vault', () => {
  it('creates and imports without persisting or returning raw secret material', async () => {
    const root = await directory();
    const runtimeVault = vault(join(root, 'state'));
    const privateKey = Wallet.createRandom().privateKey;
    const status = await runtimeVault.importSecret(privateKey, PASSPHRASE);
    const bytes = await readFile(status.path, 'utf8');
    expect(status.address).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(bytes).not.toContain(privateKey.slice(2));
    expect(bytes).not.toContain(PASSPHRASE);
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700);
    expect(statSync(status.path).mode & 0o777).toBe(0o600);
    expect(await runtimeVault.verifyPassphrase(PASSPHRASE)).toBe(status.address);
  });

  it('rejects wrong passphrases, corruption, unsafe permissions, and symlinks', async () => {
    const root = await directory();
    const runtimeVault = vault(join(root, 'state'));
    await runtimeVault.create(PASSPHRASE);
    await expect(runtimeVault.verifyPassphrase('this passphrase is wrong')).rejects.toThrow(
      PaymentPolicyRejected,
    );
    await chmod(runtimeVault.walletPath, 0o644);
    await expect(runtimeVault.status()).rejects.toThrow(PaymentPolicyRejected);
    await chmod(runtimeVault.walletPath, 0o600);

    const linked = join(root, 'linked-wallet.json');
    await symlink(runtimeVault.walletPath, linked);
    await expect(runtimeVault.restore(linked, PASSPHRASE)).rejects.toThrow(PaymentPolicyRejected);

    const linkedDirectory = join(root, 'linked-state');
    await symlink(join(root, 'state'), linkedDirectory, 'dir');
    await expect(vault(linkedDirectory).status()).rejects.toThrow(PaymentPolicyRejected);
  });

  it('backs up, restores into a clean profile, and preserves an active wallet on bad restore', async () => {
    const root = await directory();
    const source = vault(join(root, 'source'));
    const created = await source.create(PASSPHRASE);
    const backupPath = join(root, 'backup', 'wallet-backup.json');
    await source.backup(backupPath, PASSPHRASE);

    const clean = vault(join(root, 'clean'));
    const restored = await clean.restore(backupPath, PASSPHRASE);
    expect(restored.address).toBe(created.address);

    const activeBytes = await readFile(clean.walletPath);
    const corruptPath = join(root, 'backup', 'corrupt.json');
    await writeFile(corruptPath, '{not-json', { mode: 0o600 });
    await expect(clean.restore(corruptPath, PASSPHRASE)).rejects.toThrow(PaymentPolicyRejected);
    expect(await readFile(clean.walletPath)).toEqual(activeBytes);
  });

  it('rotates passphrase and wallet while retaining a last-known-good encrypted copy', async () => {
    const root = await directory();
    const runtimeVault = vault(join(root, 'state'));
    const initial = await runtimeVault.create(PASSPHRASE);
    await runtimeVault.rotatePassphrase(PASSPHRASE, NEW_PASSPHRASE);
    await expect(runtimeVault.verifyPassphrase(PASSPHRASE)).rejects.toThrow(PaymentPolicyRejected);
    expect(await runtimeVault.verifyPassphrase(NEW_PASSPHRASE)).toBe(initial.address);
    expect(statSync(runtimeVault.lastGoodPath).mode & 0o777).toBe(0o600);

    const rotated = await runtimeVault.rotateWallet(NEW_PASSPHRASE);
    expect(rotated.address).not.toBe(initial.address);
    expect(await readFile(runtimeVault.lastGoodPath, 'utf8')).not.toContain(NEW_PASSPHRASE);
  });

  it('does not allow a weak KDF outside the explicit test environment', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(
        () =>
          new WalletVault({
            directory: '/private/tmp/unused-buyer-vault',
            scryptN: 1_024,
            allowWeakTestKdf: true,
          }),
      ).toThrow(PaymentPolicyRejected);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('keeps import and passphrase canaries out of stable errors', async () => {
    const root = await directory();
    const runtimeVault = vault(join(root, 'state'));
    const secretCanary = 'buyer-secret-canary-never-echo-this-value';
    let message = '';
    try {
      await runtimeVault.importSecret(secretCanary, PASSPHRASE);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('wallet import secret is invalid');
    expect(message).not.toContain(secretCanary);
    expect(message).not.toContain(PASSPHRASE);
  });
});
