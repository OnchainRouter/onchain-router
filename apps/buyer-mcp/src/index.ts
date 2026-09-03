#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buyerProfilePaths } from '@agenticfi/onchain-router';
import { MCP_SERVER_VERSION, createFocusedMcpServer } from './server.js';

export interface McpArguments {
  readonly action: 'serve' | 'help' | 'version' | 'print-config';
  readonly profileDirectory: string;
}

const HELP = `Onchain Router focused MCP 0.1.2

Usage:
  onchain-router-mcp [--profile DIRECTORY]
  onchain-router-mcp --print-config [--profile DIRECTORY]
  onchain-router-mcp --version

The default action serves MCP over stdio. Setup, unlock, funding, and policy
changes must be performed directly with the onchain-router CLI.
`;

export function parseMcpArguments(argv: readonly string[]): McpArguments {
  let action: McpArguments['action'] = 'serve';
  let profileDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') action = 'help';
    else if (item === '--version' || item === '-v') action = 'version';
    else if (item === '--print-config') action = 'print-config';
    else if (item === '--profile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--profile requires a directory');
      if (profileDirectory) throw new Error('--profile may be provided only once');
      profileDirectory = resolve(value);
      index += 1;
    } else throw new Error(`unknown option: ${item ?? ''}`);
  }
  return {
    action,
    profileDirectory: buyerProfilePaths(profileDirectory).directory,
  };
}

export function registrationConfig(profileDirectory: string) {
  return {
    mcpServers: {
      'onchain-router': {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), '--profile', profileDirectory],
      },
    },
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: McpArguments;
  try {
    args = parseMcpArguments(argv);
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
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
    return 0;
  }
  if (args.action === 'print-config') {
    process.stdout.write(`${JSON.stringify(registrationConfig(args.profileDirectory), null, 2)}\n`);
    return 0;
  }
  const server = createFocusedMcpServer({ profileDirectory: args.profileDirectory });
  try {
    await server.connect(new StdioServerTransport());
    return 0;
  } catch {
    process.stderr.write(
      'Onchain Router MCP failed to start. Run onchain-router doctor directly for redacted diagnostics.\n',
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
