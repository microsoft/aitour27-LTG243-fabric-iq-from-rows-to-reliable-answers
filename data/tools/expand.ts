#!/usr/bin/env node
// Expands committed payload files into an uncompressed staging directory for fabio.
//
//   node tools/expand.ts
//   node tools/expand.ts --out .staging --clean

import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DATA_ROOT } from './lib/core.ts';
import { expandInto } from './lib/packing.ts';

function usage(): void {
  console.log(`Caldova payload expander

Usage:
  node data/tools/expand.ts [--out <dir>] [--clean]

Options:
  --out <dir>  Staging directory to write. Defaults to data/.staging.
  --clean      Remove the staging directory before expanding.
  -h, --help   Show this help.
`);
}

function fail(message: string): never {
  console.error(`FAIL expand payloads: ${message}`);
  process.exit(1);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${flag} requires a directory value.`);
  }
  return value;
}

let stagingRoot = join(DATA_ROOT, '.staging');
let clean = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--out') {
    stagingRoot = resolve(requireValue(args, i, arg));
    i += 1;
  } else if (arg === '--clean') {
    clean = true;
  } else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else {
    fail(`Unknown option: ${arg}`);
  }
}

try {
  if (clean) {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const result = await expandInto(stagingRoot);
  console.log(`Staging path: ${stagingRoot}`);
  console.log(`Expanded gzip files: ${result.expanded}`);
  console.log(`Copied files: ${result.copied}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL expand payloads: ${message}`);
  process.exit(1);
}
