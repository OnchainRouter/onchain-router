import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';
import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  safeReadPrivateFile,
} from '@agenticfi/onchain-router-buyer-core/admin';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const PROXY_TOKEN_FILENAME = 'proxy-token';

function validateToken(bytes: Uint8Array): string {
  const token = Buffer.from(bytes).toString('utf8');
  if (!TOKEN.test(token)) throw new PaymentPolicyRejected('proxy bearer file is malformed');
  return token;
}

export async function loadOrCreateProxyToken(
  profileDirectory: string,
): Promise<{ token: string; tokenFile: string }> {
  const directory = await ensurePrivateDirectory(profileDirectory);
  const tokenFile = join(directory, PROXY_TOKEN_FILENAME);
  try {
    return { token: validateToken(await safeReadPrivateFile(tokenFile)), tokenFile };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('base64url');
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(tokenFile, flags, 0o600);
    await handle.writeFile(token, 'utf8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { token: validateToken(await safeReadPrivateFile(tokenFile)), tokenFile };
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await assertPrivateRegularFile(tokenFile);
  return { token, tokenFile };
}
