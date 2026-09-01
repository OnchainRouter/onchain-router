import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function cleanHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'onchain-router-skill-'));
  temporaryDirectories.push(directory);
  const copiedSkill = path.join(directory, 'skill');
  cpSync(skillRoot, copiedSkill, { recursive: true });
  const fakeCli = path.join(directory, 'fake-onchain-router.mjs');
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const mode = process.env.FAKE_BUYER_MODE;
if (mode === 'malformed') process.stdout.write('{');
else process.stdout.write(JSON.stringify(mode === 'failure'
  ? { version: 1, ok: false, error: { code: 'ProviderOutcomeUnknown', retry: 'human_review', message: 'review required' } }
  : { version: 1, ok: true, result: { request, argv: process.argv.slice(2) } }));
`,
    { encoding: 'utf8', mode: 0o700 },
  );
  chmodSync(fakeCli, 0o700);
  return { directory, copiedSkill, fakeCli };
}

function run(harness, script, args = [], environment = {}, input = '') {
  return spawnSync(process.execPath, [path.join(harness.copiedSkill, 'scripts', script), ...args], {
    cwd: harness.directory,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      ONCHAIN_ROUTER_CLI: harness.fakeCli,
      ONCHAIN_ROUTER_PROFILE: path.join(harness.directory, 'buyer-profile'),
      ...environment,
    },
  });
}

function envelope(completed) {
  assert.equal(completed.stderr, '');
  return JSON.parse(completed.stdout);
}

test('portable scripts run from a clean directory and delegate to the versioned CLI bridge', () => {
  const harness = cleanHarness();
  for (const [script, action] of [
    ['models.mjs', 'models'],
    ['pricing.mjs', 'pricing'],
    ['voices.mjs', 'voices'],
    ['wallet-status.mjs', 'status'],
  ]) {
    const completed = run(harness, script);
    assert.equal(completed.status, 0);
    const body = envelope(completed);
    assert.equal(body.result.request.action, action);
    assert.deepEqual(body.result.argv, [
      '_bridge',
      '--profile',
      path.join(harness.directory, 'buyer-profile'),
    ]);
  }

  const receipt = run(harness, 'receipt.mjs', ['stable-request-1']);
  assert.equal(receipt.status, 0);
  assert.deepEqual(envelope(receipt).result.request, {
    action: 'receipt',
    idempotencyKey: 'stable-request-1',
  });
});

test('chat sends prompt data through bridge stdin and requires caller-owned idempotency', () => {
  const harness = cleanHarness();
  const prompt = 'Explain the payment result without exposing secrets.';
  const chatArguments = [
    '--model',
    'gemini-3.6-flash',
    '--max-output-tokens',
    '512',
    '--idempotency-key',
    'stable-request-2',
  ];
  const completed = run(harness, 'chat.mjs', chatArguments, {}, prompt);
  assert.equal(completed.status, 0);
  const result = envelope(completed).result;
  assert.deepEqual(result.argv, [
    '_bridge',
    '--profile',
    path.join(harness.directory, 'buyer-profile'),
  ]);
  assert.equal(result.argv.join(' ').includes(prompt), false);
  assert.equal(chatArguments.join(' ').includes(prompt), false);
  assert.deepEqual(result.request, {
    action: 'execute',
    endpoint: '/v1/chat/completions',
    idempotencyKey: 'stable-request-2',
    body: {
      model: 'gemini-3.6-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      stream: false,
    },
  });

  const missingKey = run(harness, 'chat.mjs', ['--model', 'gemini-3.6-flash'], {}, prompt);
  assert.equal(missingKey.status, 2);
  assert.match(missingKey.stderr, /stable caller-owned identifier/);
});

test('typed ambiguity remains a failure and is not converted into a retry', () => {
  const harness = cleanHarness();
  const completed = run(harness, 'models.mjs', [], { FAKE_BUYER_MODE: 'failure' });
  assert.equal(completed.status, 1);
  assert.deepEqual(envelope(completed), {
    version: 1,
    ok: false,
    error: {
      code: 'ProviderOutcomeUnknown',
      retry: 'human_review',
      message: 'review required',
    },
  });
});

test('portable media keeps data off argv, requires retention consent, and preserves the exact key', () => {
  const harness = cleanHarness();
  const args = ['images', '--idempotency-key', 'media-stable-1'];
  const request = { model: 'image-model', prompt: 'private prompt', response_format: 'url' };
  const result = run(harness, 'media.mjs', args, {}, JSON.stringify(request));
  assert.equal(result.status, 0);
  assert.deepEqual(envelope(result).result.request, {
    action: 'execute',
    endpoint: '/v1/images/generations',
    idempotencyKey: 'media-stable-1',
    body: request,
  });
  assert.equal(envelope(result).result.argv.join(' ').includes(request.prompt), false);
  const rejected = run(
    harness,
    'media.mjs',
    ['transcriptions', '--idempotency-key', 'audio-1'],
    {},
    JSON.stringify({ model: 'stt-model', audio_base64: 'SUQzYXVkaW8=' }),
  );
  assert.equal(rejected.status, 2);
  assert.equal(rejected.stdout, '');
});

test('malformed bridge output preserves same-idempotency recovery', () => {
  const harness = cleanHarness();
  const completed = run(
    harness,
    'chat.mjs',
    ['--model', 'gemini-3.6-flash', '--idempotency-key', 'stable-request-3'],
    { FAKE_BUYER_MODE: 'malformed' },
    'Keep the recovery identity stable.',
  );
  assert.equal(completed.status, 1);
  assert.deepEqual(envelope(completed), {
    version: 1,
    ok: false,
    error: {
      code: 'RuntimeUnavailable',
      retry: 'retry_same_idempotency_key',
      message: 'onchain-router CLI returned malformed JSON',
    },
  });
});

test('skill has no payment, signer, or private-key runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(path.join(skillRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  const scripts = [
    'cli-bridge.mjs',
    'models.mjs',
    'pricing.mjs',
    'wallet-status.mjs',
    'chat.mjs',
    'receipt.mjs',
    'media.mjs',
    'voices.mjs',
    'read-stdin.mjs',
  ]
    .map((name) => readFileSync(path.join(skillRoot, 'scripts', name), 'utf8'))
    .join('\n');
  for (const forbidden of [
    '@x402/',
    'privateKeyToAccount',
    'signTypedData',
    'signTransaction',
    'ONCHAIN_ROUTER_BUYER_PRIVATE_KEY',
    'ONCHAIN_ROUTER_MAINNET_ACKNOWLEDGED',
    'payment-signature',
  ])
    assert.equal(scripts.includes(forbidden), false, forbidden);
});
