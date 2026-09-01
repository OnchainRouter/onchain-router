import { invokeBuyer } from './cli-bridge.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('usage: node scripts/models.mjs\n');
  process.exitCode = 2;
} else process.exitCode = invokeBuyer({ action: 'models' });
