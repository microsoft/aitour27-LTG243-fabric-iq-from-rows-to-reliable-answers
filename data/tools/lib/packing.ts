// Transparent gzip packing for large generated CSV files.
//
// fabio 0.66.0 cannot ingest compressed CSV, but this repository has no Git LFS
// and the raw time-series files are large. So large files are stored gzipped in
// Git and expanded into a staging directory at deploy time.

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { extname, join, relative } from 'node:path';
import { DATA_ROOT, ensureDir } from './core.ts';

/** Files at or above this size are stored gzipped in Git. */
export const PACK_THRESHOLD_BYTES = 1_048_576;

/** Directories that contain deployable dataset payloads. */
export const PAYLOAD_DIRS = ['fabric-sql', 'eventhouse', 'lakehouse', 'evaluation', 'receipts'];

const SKIP_DIRS = new Set(['node_modules', '.staging', '.git', 'tools']);

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/** Every deployable payload file, as paths relative to `data/`. */
export async function listPayloadFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of PAYLOAD_DIRS) {
    const files = await listFiles(join(DATA_ROOT, dir));
    out.push(...files.map((f) => relative(DATA_ROOT, f)));
  }
  out.push('scenario.json');
  return out.sort();
}

export async function gzipFile(absolutePath: string): Promise<void> {
  await pipeline(
    createReadStream(absolutePath),
    createGzip({ level: 9 }),
    createWriteStream(`${absolutePath}.gz`),
  );
  await unlink(absolutePath);
}

export async function gunzipFile(absoluteGzPath: string, destinationPath: string): Promise<void> {
  await ensureDir(join(destinationPath, '..'));
  await pipeline(
    createReadStream(absoluteGzPath),
    createGunzip(),
    createWriteStream(destinationPath),
  );
}

/**
 * Gzips every payload file at or above the threshold and leaves smaller files
 * readable. Returns the list of files it compressed.
 */
export async function packLargeFiles(thresholdBytes = PACK_THRESHOLD_BYTES): Promise<string[]> {
  const packed: string[] = [];
  for (const dir of PAYLOAD_DIRS) {
    for (const file of await listFiles(join(DATA_ROOT, dir))) {
      if (extname(file) === '.gz') continue;
      const info = await stat(file);
      if (info.size < thresholdBytes) continue;
      await gzipFile(file);
      packed.push(relative(DATA_ROOT, file));
    }
  }
  return packed.sort();
}

/** Expands every `.gz` payload into `stagingRoot`, copying the rest verbatim. */
export async function expandInto(stagingRoot: string): Promise<{ expanded: number; copied: number }> {
  const { copyFile } = await import('node:fs/promises');
  let expanded = 0;
  let copied = 0;
  for (const relativePath of await listPayloadFiles()) {
    const source = join(DATA_ROOT, relativePath);
    if (relativePath.endsWith('.gz')) {
      const target = join(stagingRoot, relativePath.slice(0, -3));
      await gunzipFile(source, target);
      expanded += 1;
    } else {
      const target = join(stagingRoot, relativePath);
      await ensureDir(join(target, '..'));
      await copyFile(source, target);
      copied += 1;
    }
  }
  return { expanded, copied };
}
