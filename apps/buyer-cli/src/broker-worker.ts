import process from 'node:process';
import { pathExists } from '@agenticfi/onchain-router-buyer-core/admin';
import {
  LocalSpendLedger,
  SignerBroker,
  WalletVault,
} from '@agenticfi/onchain-router-buyer-core/admin';
import {
  buyerProfilePaths,
  removeBuyerSession,
  writeBuyerSession,
} from '@agenticfi/onchain-router/admin';
import { safeError } from './format.js';

interface StartMessage {
  readonly version: 1;
  readonly action: 'start';
  readonly profileDirectory: string;
  readonly passphrase: string;
  readonly agentId: string;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

function isStartMessage(value: unknown): value is StartMessage {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item['version'] === 1 &&
    item['action'] === 'start' &&
    typeof item['profileDirectory'] === 'string' &&
    typeof item['passphrase'] === 'string' &&
    typeof item['agentId'] === 'string' &&
    typeof item['idleTimeoutMs'] === 'number' &&
    typeof item['absoluteTimeoutMs'] === 'number'
  );
}

export async function runBrokerWorker(message: StartMessage): Promise<void> {
  const paths = buyerProfilePaths(message.profileDirectory);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  const vault = new WalletVault({ directory: paths.walletDirectory });
  const broker = new SignerBroker({
    socketPath: paths.socketPath,
    vault,
    ledger,
    policy: ledger.currentPolicy(),
    agentId: message.agentId,
    idleTimeoutMs: message.idleTimeoutMs,
    absoluteTimeoutMs: message.absoluteTimeoutMs,
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await broker.stop().catch(() => undefined);
    await removeBuyerSession(paths.directory).catch(() => undefined);
    ledger.close();
  };
  try {
    const session = await broker.start(message.passphrase);
    await writeBuyerSession(paths.directory, session);
    process.send?.({
      version: 1,
      ok: true,
      result: {
        address: session.address,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
    });
    process.disconnect?.();
    setInterval(() => {
      void pathExists(paths.socketPath).then((exists) => {
        if (!exists) void shutdown().finally(() => process.exit(0));
      });
    }, 1_000);
    const absolute = setTimeout(
      () => void shutdown().finally(() => process.exit(0)),
      Math.max(1, session.absoluteExpiresAt - Date.now() + 100),
    );
    absolute.unref();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => void shutdown().finally(() => process.exit(0)));
    }
  } catch (error) {
    await shutdown();
    process.send?.({ version: 1, ok: false, error: safeError(error) });
    process.disconnect?.();
    process.exitCode = 1;
  }
}

if (process.send) {
  process.once('message', (message: unknown) => {
    if (!isStartMessage(message)) {
      process.send?.({
        version: 1,
        ok: false,
        error: { code: 'PaymentPolicyRejected', retry: 'do_not_retry', message: 'invalid start' },
      });
      process.disconnect?.();
      process.exitCode = 1;
      return;
    }
    void runBrokerWorker(message);
  });
}
