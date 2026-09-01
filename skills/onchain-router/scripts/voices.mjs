import { invokeBuyer } from './cli-bridge.mjs';
process.exitCode = invokeBuyer({ action: 'voices' });
