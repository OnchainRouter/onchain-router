#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCli } from './main.js';

function isEntrypoint(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  process.exitCode = await createCli()(process.argv.slice(2));
}
