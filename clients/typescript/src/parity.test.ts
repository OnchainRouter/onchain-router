import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAID_JSON_ENDPOINTS } from './buyer.js';

interface VectorFile {
  readonly version: 1;
  readonly cases: Array<{ readonly method: string; readonly endpoint: string }>;
}

describe('cross-language adapter vectors', () => {
  it('keeps the TypeScript endpoint allowlist aligned with the shared v1 contract', () => {
    const path = fileURLToPath(
      new URL('../../../test-vectors/buyer-adapter-v1.json', import.meta.url),
    );
    const vectors = JSON.parse(readFileSync(path, 'utf8')) as VectorFile;
    expect(vectors.version).toBe(1);
    expect(vectors.cases.map((item) => item.endpoint)).toEqual([...PAID_JSON_ENDPOINTS]);
  });
});
