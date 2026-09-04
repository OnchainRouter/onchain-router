import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDistTags, releaseAuthentication, retiredTagCleanup } from './npm-release-tags.mjs';

test('parses npm dist-tag output', () => {
  assert.deepEqual(parseDistTags('alpha: 0.1.0\nlatest: 0.1.0\n'), {
    alpha: '0.1.0',
    latest: '0.1.0',
  });
});

test('removes the retired alpha tag after latest resolves to the stable version', () => {
  assert.deepEqual(retiredTagCleanup({ alpha: '0.1.0', latest: '0.1.0' }, '0.1.0'), ['alpha']);
  assert.deepEqual(retiredTagCleanup({ latest: '0.1.0' }, '0.1.0'), []);
});

test('rejects a release whose latest tag does not resolve to the published version', () => {
  assert.throws(
    () => retiredTagCleanup({ alpha: '0.1.0' }, '0.1.0'),
    /latest dist-tag must resolve to 0\.1\.0, found missing/,
  );
});

test('prefers short-lived GitHub OIDC trusted publishing', () => {
  assert.equal(
    releaseAuthentication({
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token',
      NODE_AUTH_TOKEN: 'fallback-token',
    }),
    'trusted-publishing',
  );
});

test('retains the repository-token bootstrap fallback', () => {
  assert.equal(releaseAuthentication({ NODE_AUTH_TOKEN: 'bootstrap-token' }), 'repository-token');
});

test('rejects publication without a complete trusted identity or token', () => {
  assert.throws(
    () => releaseAuthentication({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example' }),
    /requires npm trusted publishing or a repository token/,
  );
  assert.throws(
    () => releaseAuthentication({}),
    /requires npm trusted publishing or a repository token/,
  );
});
