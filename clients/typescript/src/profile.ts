import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SignerBrokerSession } from '@agenticfi/onchain-router-buyer-core';
import {
  assertPrivateRegularFile,
  atomicPrivateWrite,
  ensurePrivateDirectory,
  pathExists,
  safeReadPrivateFile,
} from '@agenticfi/onchain-router-buyer-core/admin';
import { PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';

export const BUYER_PROFILE_VERSION = 1;

export interface BuyerProfilePaths {
  readonly directory: string;
  readonly walletDirectory: string;
  readonly ledgerPath: string;
  readonly socketPath: string;
  readonly sessionPath: string;
}

interface StoredSession extends SignerBrokerSession {
  readonly version: 1;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{40,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function buyerProfilePaths(directory?: string): BuyerProfilePaths {
  const root = resolve(directory ?? join(homedir(), '.onchain-router'));
  return {
    directory: root,
    walletDirectory: join(root, 'wallet'),
    ledgerPath: join(root, 'spend.sqlite'),
    socketPath: join(root, 'signer.sock'),
    sessionPath: join(root, 'session.json'),
  };
}

function parseSession(value: unknown, paths: BuyerProfilePaths): SignerBrokerSession {
  if (typeof value !== 'object' || value === null)
    throw new PaymentPolicyRejected('buyer session descriptor is malformed');
  const session = value as Partial<StoredSession>;
  if (
    session.version !== BUYER_PROFILE_VERSION ||
    typeof session.address !== 'string' ||
    !ADDRESS.test(session.address) ||
    typeof session.agentId !== 'string' ||
    !IDENTITY.test(session.agentId) ||
    typeof session.sessionId !== 'string' ||
    !IDENTITY.test(session.sessionId) ||
    typeof session.socketPath !== 'string' ||
    resolve(session.socketPath) !== paths.socketPath ||
    typeof session.capability !== 'string' ||
    !CAPABILITY.test(session.capability) ||
    !Number.isSafeInteger(session.idleExpiresAt) ||
    !Number.isSafeInteger(session.absoluteExpiresAt) ||
    Number(session.idleExpiresAt) <= 0 ||
    Number(session.absoluteExpiresAt) < Number(session.idleExpiresAt)
  )
    throw new PaymentPolicyRejected('buyer session descriptor is malformed');
  return {
    address: session.address,
    agentId: session.agentId,
    sessionId: session.sessionId,
    socketPath: paths.socketPath,
    capability: session.capability,
    idleExpiresAt: Number(session.idleExpiresAt),
    absoluteExpiresAt: Number(session.absoluteExpiresAt),
  };
}

export async function writeBuyerSession(
  directory: string,
  session: SignerBrokerSession,
): Promise<void> {
  const paths = buyerProfilePaths(await ensurePrivateDirectory(directory));
  const validated = parseSession(
    { version: BUYER_PROFILE_VERSION, ...session, socketPath: paths.socketPath },
    paths,
  );
  await atomicPrivateWrite(
    paths.sessionPath,
    Buffer.from(JSON.stringify({ version: BUYER_PROFILE_VERSION, ...validated }), 'utf8'),
  );
}

export async function readBuyerSession(directory: string): Promise<SignerBrokerSession | null> {
  const paths = buyerProfilePaths(await ensurePrivateDirectory(directory));
  if (!(await pathExists(paths.sessionPath))) return null;
  let value: unknown;
  try {
    value = JSON.parse((await safeReadPrivateFile(paths.sessionPath)).toString('utf8'));
  } catch (error) {
    if (error instanceof PaymentPolicyRejected) throw error;
    throw new PaymentPolicyRejected('buyer session descriptor is malformed');
  }
  return parseSession(value, paths);
}

export async function removeBuyerSession(directory: string): Promise<void> {
  const paths = buyerProfilePaths(await ensurePrivateDirectory(directory));
  if (!(await pathExists(paths.sessionPath))) return;
  await assertPrivateRegularFile(paths.sessionPath);
  await unlink(paths.sessionPath);
}
