import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { alphaTagCleanup, parseDistTags } from './npm-alpha-tags.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
  throw new Error(
    'npm alpha publication is allowed only from a manually dispatched GitHub workflow',
  );
if (process.env.GITHUB_REF !== 'refs/heads/main')
  throw new Error('npm alpha publication requires the public repository main branch');
if (process.env.RELEASE_CONFIRM !== 'publish-0.1.3-alpha')
  throw new Error('release confirmation does not match publish-0.1.3-alpha');
if (!process.env.NODE_AUTH_TOKEN)
  throw new Error('the initial public alpha requires the short-lived NPM_TOKEN repository secret');

const release = JSON.parse(readFileSync('.artifacts/npm/manifest.json', 'utf8'));
if (release.version !== 1 || release.distTag !== 'alpha' || release.packages?.length !== 6)
  throw new Error('inspected package manifest is invalid');

const expectedRepository = 'git+https://github.com/AgenticFI/onchain-router-clients.git';
const resumeExisting = process.env.RESUME_EXISTING === 'true';

function registryMetadata(item) {
  const result = spawnSync(
    'npm',
    ['view', `${item.name}@${item.version}`, 'name', 'version', 'repository.url', '--json'],
    { encoding: 'utf8', env: process.env },
  );
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/E404|404 Not Found/i.test(`${result.stdout}\n${result.stderr}`)) return null;
  throw new Error(`could not safely determine registry state for ${item.name}@${item.version}`);
}

function registryDistTags(name) {
  const result = spawnSync('npm', ['dist-tag', 'ls', name], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`could not read dist-tags for ${name}`);
  return parseDistTags(result.stdout);
}

const publishOrder = [
  '@agenticfi/onchain-router-buyer-core',
  '@agenticfi/onchain-router-routing',
  '@agenticfi/onchain-router',
  '@agenticfi/onchain-router-cli',
  '@agenticfi/onchain-router-mcp',
  '@agenticfi/onchain-router-proxy',
];
const byName = new Map(release.packages.map((item) => [item.name, item]));
if (publishOrder.some((name) => !byName.has(name)))
  throw new Error('inspected package manifest does not contain the expected package set');

const registryState = new Map();
for (const name of publishOrder) {
  const item = byName.get(name);
  const existing = registryMetadata(item);
  if (existing) {
    if (!resumeExisting)
      throw new Error(
        `${item.name}@${item.version} already exists; use the explicit resume input only after reviewing the partial release`,
      );
    const metadata = Array.isArray(existing)
      ? existing
      : [existing.name, existing.version, existing['repository.url']];
    if (
      metadata[0] !== item.name ||
      metadata[1] !== item.version ||
      metadata[2] !== expectedRepository
    )
      throw new Error(`${item.name}@${item.version} registry metadata does not match this release`);
    registryState.set(name, 'verified-existing');
  } else {
    registryState.set(name, 'new');
  }
}

for (const name of publishOrder) {
  const item = byName.get(name);
  if (registryState.get(name) === 'verified-existing') {
    console.log(`Verified and skipped existing ${item.name}@${item.version}.`);
    continue;
  }
  const tarball = resolve('.artifacts/npm', item.filename);
  const result = spawnSync(
    'npm',
    ['publish', tarball, '--access', 'public', '--tag', 'alpha', '--provenance'],
    { stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0) throw new Error(`publication failed for ${item.name}@${item.version}`);
}

for (const name of publishOrder) {
  const item = byName.get(name);
  const tags = registryDistTags(name);
  for (const tag of alphaTagCleanup(tags, item.version)) {
    const result = spawnSync('npm', ['dist-tag', 'rm', name, tag], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) throw new Error(`could not remove unintended ${tag} tag from ${name}`);
  }
  const finalTags = registryDistTags(name);
  if (finalTags.alpha !== item.version || finalTags.latest === item.version)
    throw new Error(`${name} dist-tags do not match the bounded alpha release policy`);
}

console.log(
  'Published six AgenticFI packages as npm 0.1.3 alpha releases with provenance and no unintended latest tags.',
);
