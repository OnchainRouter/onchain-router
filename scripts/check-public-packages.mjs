import { readFileSync, statSync } from 'node:fs';

const failures = [];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const publicRepository = 'git+https://github.com/AgenticFI/onchain-router-clients.git';
const version = '0.1.3';
const candidates = [
  ['packages/buyer-core', '@agenticfi/onchain-router-buyer-core'],
  ['packages/routing', '@agenticfi/onchain-router-routing'],
  ['clients/typescript', '@agenticfi/onchain-router'],
  ['apps/buyer-cli', '@agenticfi/onchain-router-cli'],
  ['apps/buyer-mcp', '@agenticfi/onchain-router-mcp'],
  ['apps/buyer-proxy', '@agenticfi/onchain-router-proxy'],
];

for (const [directory, expectedName] of candidates) {
  const path = `${directory}/package.json`;
  const manifest = readJson(path);
  if (manifest.name !== expectedName) failures.push(`${path}: expected ${expectedName}`);
  if (manifest.version !== version) failures.push(`${path}: version must be ${version}`);
  if (manifest.private !== false) failures.push(`${path}: public package must not be private`);
  if (manifest.license !== 'MIT') failures.push(`${path}: MIT metadata is required`);
  if (manifest.repository?.url !== publicRepository)
    failures.push(`${path}: public repository metadata is required`);
  if (manifest.engines?.node !== '>=20.18.0')
    failures.push(`${path}: supported Node engine is missing`);
  if (manifest.publishConfig?.access !== 'public')
    failures.push(`${path}: publishConfig.access must be public`);
  if (manifest.publishConfig?.tag !== 'latest')
    failures.push(`${path}: publishConfig.tag must be latest`);
  if (manifest.publishConfig?.provenance !== true)
    failures.push(`${path}: npm provenance must be requested`);
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 5)
    failures.push(`${path}: searchable package keywords are required`);
  for (const required of ['dist', 'README.md', 'LICENSE'])
    if (!manifest.files?.includes(required)) failures.push(`${path}: ${required} is not packaged`);
  if (/sepolia|testnet/i.test(JSON.stringify(manifest)))
    failures.push(`${path}: public metadata must describe Base mainnet only`);

  const readme = readFileSync(`${directory}/README.md`, 'utf8');
  for (const section of [
    'Release status',
    'Requirements',
    'Installation',
    'Quick start',
    'Security',
    'Troubleshooting',
    'Support',
    'License',
  ])
    if (!readme.includes(`## ${section}`))
      failures.push(`${directory}/README.md: ${section} section is missing`);
  if (!readme.includes('https://github.com/AgenticFI/onchain-router-clients/issues'))
    failures.push(`${directory}/README.md: public support link is missing`);
  if (/private preview|still marked private|not installable from npm/i.test(readme))
    failures.push(`${directory}/README.md: obsolete unpublished status found`);
}

const pythonWorkspace = readJson('clients/python/package.json');
const skill = readJson('skills/onchain-router/package.json');
if (pythonWorkspace.private !== true || pythonWorkspace.license !== 'MIT')
  failures.push('clients/python/package.json: non-npm workspace must remain private and MIT');
if (skill.private !== true || skill.license !== 'MIT')
  failures.push(
    'skills/onchain-router/package.json: source-distributed Skill must remain private and MIT',
  );

const securityPolicy = readFileSync('SECURITY.md', 'utf8');
if (
  !securityPolicy.includes('Security') ||
  !securityPolicy.includes('Report a vulnerability') ||
  !securityPolicy.includes('security advisory')
)
  failures.push('SECURITY.md: private GitHub vulnerability-reporting path is missing');
if (!securityPolicy.includes('Do **not** email or post private keys'))
  failures.push('SECURITY.md: secret-handling warning is missing');

const clientLicense = readFileSync('LICENSE', 'utf8');
for (const directory of [
  'packages/buyer-core',
  'packages/routing',
  'clients/typescript',
  'clients/python',
  'apps/buyer-cli',
  'apps/buyer-mcp',
  'apps/buyer-proxy',
  'skills/onchain-router',
]) {
  if (readFileSync(`${directory}/LICENSE`, 'utf8') !== clientLicense)
    failures.push(`${directory}/LICENSE: license text drift`);
}

for (const path of [
  'packages/buyer-core/dist/index.d.ts',
  'packages/routing/dist/index.d.ts',
  'clients/typescript/dist/index.d.ts',
  'apps/buyer-cli/dist/index.js',
  'apps/buyer-mcp/dist/index.js',
  'apps/buyer-proxy/dist/index.js',
  'clients/python/dist/onchain_router-0.1.0-py3-none-any.whl',
]) {
  try {
    statSync(path);
  } catch {
    failures.push(`${path}: build artifact is missing`);
  }
}

try {
  const declarations = readFileSync('clients/typescript/dist/index.d.ts', 'utf8');
  if (/passphrase|privateKey|seedPhrase|capability/i.test(declarations))
    failures.push('TypeScript SDK: public declarations expose wallet or broker secrets');
} catch {}

for (const [path, expectedBin] of [
  ['apps/buyer-cli', 'onchain-router'],
  ['apps/buyer-mcp', 'onchain-router-mcp'],
  ['apps/buyer-proxy', 'onchain-router-proxy'],
]) {
  const manifest = readJson(`${path}/package.json`);
  const executable = manifest.bin?.[expectedBin];
  if (executable !== './dist/index.js') failures.push(`${path}: expected executable is missing`);
  try {
    if ((statSync(`${path}/dist/index.js`).mode & 0o111) === 0)
      failures.push(`${path}/dist/index.js: executable bit is missing`);
  } catch {}
}

if (failures.length) {
  console.error(`Public package checks failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(
  'Six Onchain Router npm packages are configured as version 0.1.3 stable release candidates.',
);
