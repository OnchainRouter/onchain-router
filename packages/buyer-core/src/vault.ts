import { getAddress, Wallet, encryptKeystoreJson } from 'ethers';
import type { HDNodeWallet } from 'ethers';
import { basename, dirname, join, resolve } from 'node:path';
import { PaymentPolicyRejected } from './errors.js';
import { mintHumanAuthorization, type HumanAuthorization } from './human-auth.js';
import {
  assertPathInside,
  atomicPrivateWrite,
  ensurePrivateDirectory,
  pathExists,
  safeReadPrivateFile,
} from './filesystem.js';

const DEFAULT_SCRYPT_N = 131_072;
const MINIMUM_SCRYPT_N = 131_072;
const WALLET_FILE = 'wallet.json';
const LAST_GOOD_FILE = 'wallet.last-good.json';

export interface WalletVaultOptions {
  readonly directory: string;
  readonly scryptN?: number;
  /** Test-only escape hatch. Production callers cannot select a weak KDF. */
  readonly allowWeakTestKdf?: boolean;
}

export interface WalletStatus {
  readonly initialized: boolean;
  readonly address: `0x${string}` | null;
  readonly encrypted: true;
  readonly path: string;
}

/** @internal Signer-broker bridge; intentionally absent from package exports. */
export async function unlockWalletForBroker(
  vault: WalletVault,
  passphrase: string,
): Promise<Wallet> {
  return await decryptWallet(vault.walletPath, passphrase);
}

async function decryptWallet(walletPath: string, passphrase: string): Promise<Wallet> {
  validatePassphrase(passphrase);
  const bytes = await safeReadPrivateFile(walletPath);
  try {
    const wallet = await Wallet.fromEncryptedJson(bytes.toString('utf8'), passphrase);
    return new Wallet(wallet.privateKey);
  } catch {
    throw new PaymentPolicyRejected('wallet passphrase or encrypted wallet is invalid');
  }
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 1_024)
    throw new PaymentPolicyRejected('wallet passphrase must contain 12–1024 characters');
  if (passphrase.includes('\0')) throw new PaymentPolicyRejected('wallet passphrase contains NUL');
}

function validateScryptN(value: number, weakAllowed: boolean): number {
  if (!Number.isSafeInteger(value) || value <= 1 || (value & (value - 1)) !== 0)
    throw new PaymentPolicyRejected('wallet scrypt N must be a power of two');
  if (value < MINIMUM_SCRYPT_N && !(weakAllowed && process.env.NODE_ENV === 'test'))
    throw new PaymentPolicyRejected('wallet scrypt N is below the production minimum');
  return value;
}

function addressFromJson(json: string): `0x${string}` {
  try {
    const parsed = JSON.parse(json) as { address?: unknown };
    const address = parsed.address;
    if (typeof address !== 'string')
      throw new PaymentPolicyRejected('encrypted wallet JSON has no address');
    return getAddress(address.startsWith('0x') ? address : `0x${address}`) as `0x${string}`;
  } catch {
    throw new PaymentPolicyRejected('encrypted wallet JSON is malformed');
  }
}

export class WalletVault {
  public readonly directory: string;
  public readonly walletPath: string;
  public readonly lastGoodPath: string;
  private readonly scryptN: number;

  public constructor(options: WalletVaultOptions) {
    this.directory = resolve(options.directory);
    this.walletPath = join(this.directory, WALLET_FILE);
    this.lastGoodPath = join(this.directory, LAST_GOOD_FILE);
    this.scryptN = validateScryptN(
      options.scryptN ?? DEFAULT_SCRYPT_N,
      options.allowWeakTestKdf ?? false,
    );
  }

  public async status(): Promise<WalletStatus> {
    await ensurePrivateDirectory(this.directory);
    if (!(await pathExists(this.walletPath)))
      return { initialized: false, address: null, encrypted: true, path: this.walletPath };
    const json = (await safeReadPrivateFile(this.walletPath)).toString('utf8');
    return {
      initialized: true,
      address: addressFromJson(json),
      encrypted: true,
      path: this.walletPath,
    };
  }

  public async create(passphrase: string): Promise<WalletStatus> {
    validatePassphrase(passphrase);
    await ensurePrivateDirectory(this.directory);
    if (await pathExists(this.walletPath))
      throw new PaymentPolicyRejected('wallet vault is already initialized');
    const wallet = Wallet.createRandom();
    await this.persist(wallet, passphrase, false);
    return await this.status();
  }

  public async importSecret(secret: string, passphrase: string): Promise<WalletStatus> {
    validatePassphrase(passphrase);
    await ensurePrivateDirectory(this.directory);
    if (await pathExists(this.walletPath))
      throw new PaymentPolicyRejected('wallet vault is already initialized');
    const normalized = secret.trim();
    let wallet: Wallet | HDNodeWallet;
    try {
      wallet = /^0x[0-9a-fA-F]{64}$/.test(normalized)
        ? new Wallet(normalized)
        : Wallet.fromPhrase(normalized);
    } catch {
      throw new PaymentPolicyRejected('wallet import secret is invalid');
    }
    await this.persist(wallet, passphrase, false);
    return await this.status();
  }

  public async verifyPassphrase(passphrase: string): Promise<`0x${string}`> {
    const wallet = await decryptWallet(this.walletPath, passphrase);
    return getAddress(wallet.address) as `0x${string}`;
  }

  /** Mint a short-lived, one-use proof for a direct human policy-widening command. */
  public async authenticatePolicyChange(
    policyHash: string,
    passphrase: string,
  ): Promise<HumanAuthorization> {
    if (!/^[0-9a-f]{64}$/.test(policyHash))
      throw new PaymentPolicyRejected('policy authorization hash is invalid');
    return mintHumanAuthorization(await this.verifyPassphrase(passphrase), `policy:${policyHash}`);
  }

  public async authenticateWalletReplacement(passphrase: string): Promise<HumanAuthorization> {
    const address = await this.verifyPassphrase(passphrase);
    return mintHumanAuthorization(address, `wallet:${address.toLowerCase()}`);
  }

  public async backup(destination: string, passphrase: string): Promise<WalletStatus> {
    const target = resolve(destination);
    if (basename(target) === WALLET_FILE && dirname(target) === this.directory)
      throw new PaymentPolicyRejected('backup destination must differ from the active wallet');
    await ensurePrivateDirectory(dirname(target));
    const wallet = await decryptWallet(this.walletPath, passphrase);
    const bytes = await safeReadPrivateFile(this.walletPath);
    await atomicPrivateWrite(target, bytes);
    const restored = await Wallet.fromEncryptedJson(bytes.toString('utf8'), passphrase);
    if (getAddress(restored.address) !== getAddress(wallet.address))
      throw new PaymentPolicyRejected('encrypted backup verification failed');
    return {
      initialized: true,
      address: getAddress(wallet.address) as `0x${string}`,
      encrypted: true,
      path: target,
    };
  }

  public async restore(source: string, passphrase: string): Promise<WalletStatus> {
    await ensurePrivateDirectory(this.directory);
    const sourcePath = resolve(source);
    const bytes = await safeReadPrivateFile(sourcePath);
    let wallet: Wallet;
    try {
      const restored = await Wallet.fromEncryptedJson(bytes.toString('utf8'), passphrase);
      wallet = new Wallet(restored.privateKey);
    } catch {
      throw new PaymentPolicyRejected('backup passphrase or encrypted wallet is invalid');
    }
    if (await pathExists(this.walletPath)) {
      const current = await safeReadPrivateFile(this.walletPath);
      await atomicPrivateWrite(this.lastGoodPath, current);
    }
    await atomicPrivateWrite(this.walletPath, bytes);
    const verified = await decryptWallet(this.walletPath, passphrase);
    if (getAddress(verified.address) !== getAddress(wallet.address))
      throw new PaymentPolicyRejected('restored wallet verification failed');
    return await this.status();
  }

  public async rotatePassphrase(
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<WalletStatus> {
    validatePassphrase(newPassphrase);
    const wallet = await decryptWallet(this.walletPath, currentPassphrase);
    await this.persist(wallet, newPassphrase, true);
    return await this.status();
  }

  public async rotateWallet(passphrase: string): Promise<WalletStatus> {
    await decryptWallet(this.walletPath, passphrase);
    await this.persist(Wallet.createRandom(), passphrase, true);
    return await this.status();
  }

  public async exportEncrypted(destination: string, passphrase: string): Promise<WalletStatus> {
    return await this.backup(destination, passphrase);
  }

  private async persist(
    wallet: Wallet | HDNodeWallet,
    passphrase: string,
    preserveLastGood: boolean,
  ): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await assertPathInside(this.directory, this.walletPath);
    const json = await encryptKeystoreJson(
      { address: wallet.address, privateKey: wallet.privateKey },
      passphrase,
      {
        client: 'onchain-router-buyer-core',
        scrypt: { N: this.scryptN, r: 8, p: 1 },
      },
    );
    const verified = await Wallet.fromEncryptedJson(json, passphrase);
    if (getAddress(verified.address) !== getAddress(wallet.address))
      throw new PaymentPolicyRejected('new encrypted wallet failed verification');
    if (preserveLastGood && (await pathExists(this.walletPath))) {
      const current = await safeReadPrivateFile(this.walletPath);
      await atomicPrivateWrite(this.lastGoodPath, current);
    }
    await atomicPrivateWrite(this.walletPath, Buffer.from(json, 'utf8'));
  }
}
