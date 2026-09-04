import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const packages = [
  'packages/buyer-core',
  'packages/routing',
  'clients/typescript',
  'apps/buyer-cli',
  'apps/buyer-mcp',
  'apps/buyer-proxy',
];
const artifactDirectory = resolve('.artifacts/npm');
rmSync(artifactDirectory, { recursive: true, force: true });
mkdirSync(artifactDirectory, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return result.stdout;
}

for (const directory of packages) {
  run('pnpm', ['pack', '--pack-destination', artifactDirectory], {
    cwd: resolve(directory),
    stdio: 'inherit',
  });
}

const tarballs = readdirSync(artifactDirectory)
  .filter((name) => name.endsWith('.tgz'))
  .sort();
if (tarballs.length !== packages.length)
  throw new Error(`expected ${packages.length} tarballs, found ${tarballs.length}`);

const forbiddenPaths = /(?:^|\/)(?:\.env(?:\.|$)|\.git|node_modules|tests?|coverage|src)(?:\/|$)/;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
];
const manifest = [];

for (const filename of tarballs) {
  const path = join(artifactDirectory, filename);
  const entries = run('tar', ['-tzf', path]).trim().split('\n').filter(Boolean);
  if (entries.some((entry) => !entry.startsWith('package/')))
    throw new Error(`${filename}: tarball has an invalid root`);
  const forbidden = entries.find((entry) => forbiddenPaths.test(entry));
  if (forbidden) throw new Error(`${filename}: forbidden path ${forbidden}`);
  for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE'])
    if (!entries.includes(required)) throw new Error(`${filename}: missing ${required}`);

  const packageJsonText = run('tar', ['-xOzf', path, 'package/package.json']);
  const packageJson = JSON.parse(packageJsonText);
  if (packageJson.private === true) throw new Error(`${filename}: packed package is private`);
  if (packageJson.version !== '0.2.0') throw new Error(`${filename}: unexpected version`);
  if (packageJson.publishConfig?.tag !== 'latest')
    throw new Error(`${filename}: packed stable tag is missing`);
  if (/workspace:/.test(packageJsonText))
    throw new Error(`${filename}: workspace dependency marker leaked into tarball`);

  const extraction = mkdtempSync(join(tmpdir(), 'onchain-router-pack-'));
  try {
    run('tar', ['-xzf', path, '-C', extraction]);
    for (const entry of entries) {
      if (entry.endsWith('/')) continue;
      const bytes = readFileSync(join(extraction, entry));
      const text = bytes.toString('utf8');
      const matched = secretPatterns.find((pattern) => pattern.test(text));
      if (matched) throw new Error(`${filename}: possible credential in ${entry}`);
    }
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }

  const bytes = readFileSync(path);
  manifest.push({
    name: packageJson.name,
    version: packageJson.version,
    filename,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

writeFileSync(
  join(artifactDirectory, 'manifest.json'),
  `${JSON.stringify({ version: 1, distTag: 'latest', packages: manifest }, null, 2)}\n`,
);
console.log(`Packed and inspected ${manifest.length} npm stable-release tarballs.`);
