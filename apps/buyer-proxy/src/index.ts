#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buyerProfilePaths } from '@agenticfi/onchain-router';
import { DEFAULT_PROXY_PORT, proxyClientRecipe } from './contracts.js';
import { startBuyerProxy } from './server.js';
import { loadOrCreateProxyToken, PROXY_TOKEN_FILENAME } from './token.js';

export const BUYER_PROXY_VERSION = '0.1.0';

export interface ProxyArguments {
  readonly action: 'serve' | 'help' | 'version' | 'print-config';
  readonly profileDirectory: string;
  readonly port: number;
  readonly cacheEnabled: boolean;
}

const HELP = `Onchain Router local buyer proxy 0.1.0

Usage:
  onchain-router-proxy [--profile DIRECTORY] [--port PORT] [--no-cache]
  onchain-router-proxy --print-config [--profile DIRECTORY] [--port PORT]
  onchain-router-proxy --version

The proxy always binds to 127.0.0.1, accepts the five bounded non-streaming
paid JSON routes plus models, pricing, and voices, and requires its owner-only local bearer.
Wallet setup, unlock, funding, and policy changes remain direct CLI actions.
Exact text responses are cached in session-isolated memory for up to 10 minutes.
Use --no-cache to disable caching for this process; paid recovery keys bypass it.
`;

export function parseProxyArguments(argv: readonly string[]): ProxyArguments {
  let action: ProxyArguments['action'] = 'serve';
  let profileDirectory: string | undefined;
  let port = DEFAULT_PROXY_PORT;
  let cacheEnabled = true;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') action = 'help';
    else if (item === '--version' || item === '-v') action = 'version';
    else if (item === '--print-config') action = 'print-config';
    else if (item === '--no-cache') cacheEnabled = false;
    else if (item === '--profile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--profile requires a directory');
      if (profileDirectory) throw new Error('--profile may be provided only once');
      profileDirectory = resolve(value);
      index += 1;
    } else if (item === '--port') {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error('--port requires an integer');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535)
        throw new Error('--port must be between 1 and 65535');
      port = parsed;
      index += 1;
    } else throw new Error(`unknown option: ${item ?? ''}`);
  }
  return {
    action,
    profileDirectory: buyerProfilePaths(profileDirectory).directory,
    port,
    cacheEnabled,
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: ProxyArguments;
  try {
    args = parseProxyArguments(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n${HELP}`,
    );
    return 2;
  }
  if (args.action === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.action === 'version') {
    process.stdout.write(`${BUYER_PROXY_VERSION}\n`);
    return 0;
  }
  const tokenFile = resolve(args.profileDirectory, PROXY_TOKEN_FILENAME);
  if (args.action === 'print-config') {
    process.stdout.write(`${JSON.stringify(proxyClientRecipe(args.port, tokenFile), null, 2)}\n`);
    return 0;
  }
  try {
    const token = await loadOrCreateProxyToken(args.profileDirectory);
    const proxy = await startBuyerProxy({
      port: args.port,
      profileDirectory: args.profileDirectory,
      token: token.token,
      cacheEnabled: args.cacheEnabled,
    });
    process.stdout.write(
      `Onchain Router proxy listening at ${proxy.origin}; local bearer file: ${token.tokenFile}\n`,
    );
    await new Promise<void>((resolveRun) => {
      const stop = () => {
        void proxy.close().finally(resolveRun);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  } catch {
    process.stderr.write(
      'Onchain Router proxy failed to start. Run onchain-router doctor directly for redacted diagnostics.\n',
    );
    return 1;
  }
}

function isEntrypoint(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2));
}
