#!/usr/bin/env node
// Regenerates the complete Caldova synthetic dataset from scenario.json.
//
//   node tools/generate.ts            generate, then gzip large payload files
//   node tools/generate.ts --no-pack  leave every file uncompressed
//
// Output is deterministic: the same scenario.json always produces byte-identical
// files on every supported platform.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_ROOT, loadScenario, logResults } from './lib/core.ts';
import type { GenerationResult } from './lib/core.ts';
import { generateWeather } from './lib/weather.ts';
import { generateFabricSql } from './lib/fabric-sql.ts';
import { generateDecisionMemory } from './lib/decision-memory.ts';
import { generateBridges } from './lib/bridges.ts';
import { generateFabricSqlWeather } from './lib/fabric-sql-weather.ts';
import { generateEventhouse } from './lib/eventhouse.ts';
import { generateLakehouse } from './lib/lakehouse.ts';
import { generateEvidenceTables } from './lib/evidence-tables.ts';
import { packLargeFiles, PACK_THRESHOLD_BYTES } from './lib/packing.ts';

const pack = !process.argv.includes('--no-pack');

/** Removes previously generated payloads so stale files cannot survive. */
async function cleanGeneratedPayloads(): Promise<void> {
  const { listFiles } = await import('./lib/packing.ts');
  for (const dir of ['fabric-sql', 'eventhouse', 'lakehouse', 'evaluation', 'receipts']) {
    for (const file of await listFiles(join(DATA_ROOT, dir))) {
      // Hand-authored SQL and KQL scripts are inputs, not generated output.
      if (/\.(sql|kql)$/.test(file)) continue;
      await rm(file, { force: true });
    }
  }
}

const scenario = await loadScenario();
console.log(`Caldova LTG243 shared dataset generator`);
console.log(`  scenario schemaVersion : ${scenario.schemaVersion}`);
console.log(`  generator seed         : ${scenario.generatorSeed}`);
console.log(`  hero product           : ${scenario.heroProductId}`);
console.log(`  decision day           : ${scenario.clock.decisionDay}`);

await cleanGeneratedPayloads();

// Order matters. Weather runs first because the relational, telemetry and
// document generators all read the generated weather series rather than
// recomputing it, which keeps a single source of truth for the anomalies.
const sections: { label: string; results: GenerationResult[] }[] = [
  { label: 'External weather feed', results: await generateWeather() },
  { label: 'Fabric SQL Database', results: await generateFabricSql() },
  { label: 'Fabric SQL Database (weather)', results: await generateFabricSqlWeather() },
  { label: 'Materialised bridges', results: await generateBridges() },
  { label: 'Eventhouse (KQL)', results: await generateEventhouse() },
  { label: 'Lakehouse, evaluation and receipts', results: await generateLakehouse() },
  { label: 'Agent evidence tables', results: await generateEvidenceTables() },
  { label: 'Decision memory', results: await generateDecisionMemory() },
];

let total = 0;
for (const section of sections) {
  total += logResults(section.label, section.results);
}

console.log(`\nTotal generated records: ${total.toLocaleString('en-US')}`);

if (pack) {
  const packed = await packLargeFiles();
  if (packed.length > 0) {
    console.log(
      `\nCompressed ${packed.length} file(s) at or above ${(PACK_THRESHOLD_BYTES / 1_048_576).toFixed(0)} MiB:`,
    );
    for (const file of packed) console.log(`  ${file} -> ${file}.gz`);
    console.log('\nDeployment expands these into .staging/ automatically.');
  }
} else {
  console.log('\nSkipped compression (--no-pack).');
}

console.log('\nNext: node tools/validate.ts && node tools/manifest.ts');
