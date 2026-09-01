import { invokeBuyer } from './cli-bridge.mjs';

const idempotencyKey = process.argv[2];
if (
  process.argv.length !== 3 ||
  !idempotencyKey ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)
) {
  process.stderr.write('usage: node scripts/receipt.mjs IDEMPOTENCY_KEY\n');
  process.exitCode = 2;
} else process.exitCode = invokeBuyer({ action: 'receipt', idempotencyKey });
