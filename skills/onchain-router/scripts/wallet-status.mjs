import { invokeBuyer } from './cli-bridge.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('usage: node scripts/wallet-status.mjs\n');
  process.exitCode = 2;
} else process.exitCode = invokeBuyer({ action: 'status' });
