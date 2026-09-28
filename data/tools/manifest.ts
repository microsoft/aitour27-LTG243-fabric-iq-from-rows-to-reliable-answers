#!/usr/bin/env node
// Recomputes data/manifest.json: the integrity record for every deployable file.
//
//   node tools/manifest.ts           write manifest.json
//   node tools/manifest.ts --check   verify the manifest without rewriting it

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, loadScenario, writeJson } from './lib/core.ts';
import { listPayloadFiles } from './lib/packing.ts';

const checkOnly = process.argv.includes('--check');

async function sha256(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(absolutePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

const scenario = await loadScenario();
const files: { path: string; bytes: number; sha256: string }[] = [];

for (const relativePath of await listPayloadFiles()) {
  const absolute = join(DATA_ROOT, relativePath);
  const info = await stat(absolute);
  files.push({
    path: `data/${relativePath.split('\\').join('/')}`,
    bytes: info.size,
    sha256: await sha256(absolute),
  });
}

files.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  dataset: scenario.dataset,
  schemaVersion: scenario.schemaVersion,
  scenarioGeneratedFor: scenario.clock.decisionDay,
  generatorSeed: scenario.generatorSeed,
  synthetic: true,
  fictional: true,
  containsPersonLevelBusinessData: false,
  approverRolesUsed: scenario.approverRoles,
  deploymentBoundary:
    'Deploys the LTG243 dataset and demo items to Microsoft Fabric using the fabio CLI. Fabric SQL Database is created as a Fabric item; no separate Azure SQL server or application host is required.',
  externalSignalNotice: scenario.disclosure.externalSignalNotice,
  fileCount: files.length,
  totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  files,
};

if (checkOnly) {
  const existing = JSON.parse(await readFile(join(DATA_ROOT, 'manifest.json'), 'utf8'));
  const actual = JSON.stringify(manifest.files);
  const expected = JSON.stringify(existing.files);
  if (actual !== expected) {
    console.error('FAIL manifest.json does not match the files on disk. Run: node tools/manifest.ts');
    const expectedByPath = new Map(existing.files.map((f: any) => [f.path, f]));
    for (const file of files) {
      const previous = expectedByPath.get(file.path) as any;
      if (!previous) console.error(`  added   ${file.path}`);
      else if (previous.sha256 !== file.sha256) console.error(`  changed ${file.path}`);
      expectedByPath.delete(file.path);
    }
    for (const missing of expectedByPath.keys()) console.error(`  removed ${missing}`);
    process.exit(1);
  }
  console.log(`PASS manifest.json matches ${files.length} files on disk.`);
} else {
  await writeJson('manifest.json', manifest);
  const mib = (manifest.totalBytes / 1_048_576).toFixed(1);
  console.log(`Wrote data/manifest.json: ${files.length} files, ${mib} MiB total.`);
}
