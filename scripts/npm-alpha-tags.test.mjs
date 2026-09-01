import assert from 'node:assert/strict';
import test from 'node:test';

import { alphaTagCleanup, parseDistTags } from './npm-alpha-tags.mjs';

test('parses npm dist-tag output', () => {
  assert.deepEqual(parseDistTags('alpha: 0.1.0\nlatest: 0.1.0\n'), {
    alpha: '0.1.0',
    latest: '0.1.0',
  });
});

test('removes latest only when npm copied the alpha version onto it', () => {
  assert.deepEqual(alphaTagCleanup({ alpha: '0.1.0', latest: '0.1.0' }, '0.1.0'), ['latest']);
  assert.deepEqual(alphaTagCleanup({ alpha: '0.2.0', latest: '0.1.0' }, '0.2.0'), []);
  assert.deepEqual(alphaTagCleanup({ alpha: '0.1.0' }, '0.1.0'), []);
});

test('rejects a release whose alpha tag does not resolve to the published version', () => {
  assert.throws(
    () => alphaTagCleanup({ latest: '0.1.0' }, '0.1.0'),
    /alpha dist-tag must resolve to 0\.1\.0, found missing/,
  );
});
