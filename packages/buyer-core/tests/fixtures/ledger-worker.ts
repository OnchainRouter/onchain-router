import { LocalSpendLedger } from '../../src/ledger.js';
import { testPolicy } from '../helpers.js';

const [databasePath, key, mode, startAtText, operationNowText] = process.argv.slice(2);
if (!databasePath || !key || !mode || !startAtText || !operationNowText) process.exit(10);

const ledger = new LocalSpendLedger(databasePath, testPolicy());
const startAt = Number(startAtText);
const operationNow = Number(operationNowText);
while (Date.now() < startAt) {
  // Synchronize separate processes close enough to exercise BEGIN IMMEDIATE contention.
}

const input = {
  idempotencyKey: key,
  requestHash: `request-${key}`,
  requirementHash: `requirement-${key}`,
  model: 'gemini-2.5-flash',
  agentId: 'test-agent',
  sessionId: 'shared-session',
  maximumAtomic: 600n,
  now: operationNow,
};

try {
  ledger.reserve(input);
  if (mode !== 'reserved') {
    ledger.claimAuthorization(key, input.requestHash, input.requirementHash, operationNow + 1);
  }
  if (mode === 'authorized' || mode === 'unknown') {
    ledger.markAuthorized(key, input.requestHash, input.requirementHash, operationNow + 2);
  }
  if (mode === 'unknown') ledger.markUnknown(key, operationNow + 3);
  // Deliberately do not close: this fixture models abrupt process exit at a financial boundary.
  process.exit(0);
} catch (error) {
  if ((error as { code?: unknown }).code === 'AuthorizationAboveLocalCap') process.exit(2);
  process.exit(1);
}
