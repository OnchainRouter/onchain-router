import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const binaries = [
  ['onchain-router', 'apps/buyer-cli/dist/index.js', ['--version'], '0.1.1'],
  ['onchain-router-mcp', 'apps/buyer-mcp/dist/index.js', ['--version'], '0.1.1'],
  ['onchain-router-proxy', 'apps/buyer-proxy/dist/index.js', ['--version'], '0.1.1'],
];

const directory = mkdtempSync(join(tmpdir(), 'onchain-router-bin-smoke-'));
try {
  for (const [name, target, args, expected] of binaries) {
    const link = join(directory, name);
    symlinkSync(resolve(target), link);
    const result = spawnSync(link, args, { encoding: 'utf8' });
    if (result.status !== 0 || result.stdout.trim() !== expected || result.stderr)
      throw new Error(`${name} failed installed-symlink smoke test`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('Three installed command entrypoints passed symlink smoke tests.');
