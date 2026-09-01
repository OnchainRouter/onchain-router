import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PaymentPolicyRejected } from './errors.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new PaymentPolicyRejected('Buyer Runtime v1 supports macOS and Linux only');
}

export async function ensurePrivateDirectory(path: string): Promise<string> {
  assertSupportedPlatform();
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if ((await realpath(absolute)) !== absolute)
    throw new PaymentPolicyRejected('runtime state directory must not traverse symbolic links');
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new PaymentPolicyRejected('runtime state path must be a real directory');
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid)
    throw new PaymentPolicyRejected('runtime state directory has an unexpected owner');
  if ((info.mode & 0o077) !== 0)
    throw new PaymentPolicyRejected('runtime state directory must be owner-only (0700)');
  return absolute;
}

export async function assertPrivateRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new PaymentPolicyRejected('runtime state file must be a regular file');
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid)
    throw new PaymentPolicyRejected('runtime state file has an unexpected owner');
  if ((info.mode & 0o077) !== 0)
    throw new PaymentPolicyRejected('runtime state file must be owner-only (0600)');
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function safeReadPrivateFile(path: string): Promise<Buffer> {
  await assertPrivateRegularFile(path);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    const named = await stat(path);
    if (opened.dev !== named.dev || opened.ino !== named.ino)
      throw new PaymentPolicyRejected('runtime state file changed while opening');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicPrivateWrite(path: string, bytes: Uint8Array): Promise<void> {
  const directory = await ensurePrivateDirectory(dirname(path));
  if (resolve(dirname(path)) !== directory || basename(path) !== basename(resolve(path)))
    throw new PaymentPolicyRejected('unsafe runtime state path');
  if (await pathExists(path)) await assertPrivateRegularFile(path);
  const temporary = join(directory, `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
  await chmod(path, PRIVATE_FILE_MODE);
  await fsyncDirectory(directory);
}

export async function assertPathInside(directory: string, path: string): Promise<void> {
  const base = await realpath(directory);
  const candidate = resolve(path);
  if (dirname(candidate) !== base)
    throw new PaymentPolicyRejected(
      'runtime files must remain inside the owner-only state directory',
    );
}
