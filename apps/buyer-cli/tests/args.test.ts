import { describe, expect, it } from 'vitest';
import { booleanFlag, parseArguments } from '../src/args.js';

describe('strict CLI arguments', () => {
  it('parses repeated and equals-form options without evaluating input', () => {
    const parsed = parseArguments(['policy', 'set', '--models=a,b', '--models', 'c', '--json']);
    expect(parsed.positionals).toEqual(['policy', 'set']);
    expect(parsed.flags.get('models')).toEqual(['a,b', 'c']);
    expect(booleanFlag(parsed, 'json')).toBe(true);
  });

  it('rejects malformed option names and booleans', () => {
    expect(() => parseArguments(['--BAD=value'])).toThrow();
    expect(() => booleanFlag(parseArguments(['--json=maybe']), 'json')).toThrow();
  });
});
