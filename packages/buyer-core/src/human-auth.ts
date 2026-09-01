import { randomBytes } from 'node:crypto';
import { WalletLocked } from './errors.js';

const AUTHORIZATION_LIFETIME_MS = 60_000;
const issued = new WeakSet<object>();

export interface HumanAuthorization {
  readonly walletAddress: `0x${string}`;
  readonly intent: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

export function mintHumanAuthorization(
  walletAddress: `0x${string}`,
  intent: string,
): HumanAuthorization {
  const authorization = Object.freeze({
    walletAddress,
    intent,
    expiresAt: Date.now() + AUTHORIZATION_LIFETIME_MS,
    nonce: randomBytes(32).toString('base64url'),
  });
  issued.add(authorization);
  return authorization;
}

export function consumeHumanAuthorization(authorization: HumanAuthorization): void {
  if (!issued.has(authorization) || authorization.expiresAt <= Date.now())
    throw new WalletLocked('fresh human authentication is required');
  issued.delete(authorization);
}
