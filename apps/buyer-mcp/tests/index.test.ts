import { describe, expect, it } from 'vitest';
import { parseMcpArguments, registrationConfig } from '../src/index.js';

describe('focused MCP command', () => {
  it('accepts only one deterministic local profile path', () => {
    const parsed = parseMcpArguments(['--profile', './profile']);
    expect(parsed.action).toBe('serve');
    expect(parsed.profileDirectory).toMatch(/\/profile$/);
    expect(() => parseMcpArguments(['--origin', 'https://attacker.example'])).toThrow(
      'unknown option',
    );
    expect(() => parseMcpArguments(['--profile', 'one', '--profile', 'two'])).toThrow('only once');
  });

  it('emits a repository-built stdio configuration with no secrets or policy overrides', () => {
    const value = registrationConfig('/safe/profile');
    expect(value.mcpServers['onchain-router'].command).toBe(process.execPath);
    expect(value.mcpServers['onchain-router'].args).toContain('--profile');
    expect(value.mcpServers['onchain-router'].args).toContain('/safe/profile');
    expect(Object.keys(value.mcpServers['onchain-router'])).toEqual(['command', 'args']);
    expect(value.mcpServers['onchain-router'].args.slice(-2)).toEqual([
      '--profile',
      '/safe/profile',
    ]);
  });
});
