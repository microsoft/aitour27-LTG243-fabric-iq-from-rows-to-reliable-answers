// Shared generation primitives for the Caldova LTG243 synthetic dataset.
// Runs directly on Node.js 24+ via native type stripping. No build step, so
// this file must avoid enums, namespaces, decorators and parameter properties.

import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export const DATA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Scenario = Record<string, any>;

let cachedScenario: Scenario | null = null;

export async function loadScenario(): Promise<Scenario> {
  if (cachedScenario) return cachedScenario;
  const raw = await readFile(join(DATA_ROOT, 'scenario.json'), 'utf8');
  cachedScenario = JSON.parse(raw) as Scenario;
  return cachedScenario;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/** Stable 32-bit string hash, used to derive per-stream seeds from labels. */
export function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Mulberry32. Small, fast and fully reproducible across platforms and Node
 * versions, which matters because generated files are committed and hashed.
 */
export function createRng(seed: number | string) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Uniform float in [min, max). */
    float: (min: number, max: number) => min + next() * (max - min),
    /** Uniform integer in [min, max] inclusive. */
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    /** Approximate standard normal via Irwin-Hall; adequate for demo noise. */
    normal: (mean = 0, stdDev = 1) => {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += next();
      return mean + (sum - 6) * stdDev;
    },
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    bool: (probability = 0.5) => next() < probability,
  };
}

export type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function parseDate(value: string): Date {
  return new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
}

/** YYYY-MM-DD in UTC. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Second-precision ISO-8601 in UTC, e.g. 2026-08-03T08:12:00Z. */
export function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

// --- The "as of today" boundary -------------------------------------------
//
// The dataset represents the estate as it stands on scenario.clock.asOf. The
// distinction that matters is not "before or after a date" but *what kind of
// fact* a record is:
//
//   Observed facts   - sales, telemetry, observations, executed actions,
//                      recorded outcomes, resolved cases. These cannot exist
//                      after asOf, because they have not happened yet.
//   Forward artefacts - plans, schedules, campaign windows, maintenance
//                      windows and forecasts issued on or before asOf. These
//                      legitimately extend past asOf; that is their purpose.
//
// Only observed facts are truncated. Truncating forward artefacts would
// destroy the forecast archive, which is the evidence Act 1 reasons from.

/** The date the dataset is a snapshot of. */
export function asOfDate(scenario: Scenario): string {
  const value = scenario.clock?.asOf ?? scenario.clock?.decisionDay;
  if (typeof value !== 'string' || value.length < 10) {
    throw new Error('scenario.clock.asOf is missing; the as-of boundary is required');
  }
  return value.slice(0, 10);
}

/**
 * True when an observed fact dated `value` may appear in the default dataset.
 * Accepts a date or a timestamp; comparison is by calendar day so an event
 * timestamped during the as-of day is retained.
 */
export function isObservable(scenario: Scenario, value: string): boolean {
  return value.slice(0, 10) <= asOfDate(scenario);
}

/**
 * Whether the generator is emitting the post-decision reveal slice. The default
 * dataset stops at the decision; the outcome slice carries how it turned out and
 * is loaded only on request, so an agent grounded on the default estate cannot
 * see the future.
 */
export function includeOutcomeSlice(): boolean {
  return process.argv.includes('--with-outcome') || process.env.CALDOVA_WITH_OUTCOME === '1';
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function eachDate(startInclusive: string, endInclusive: string): Date[] {
  const out: Date[] = [];
  const end = parseDate(endInclusive).getTime();
  for (let t = parseDate(startInclusive).getTime(); t <= end; t += MS_PER_DAY) {
    out.push(new Date(t));
  }
  return out;
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

export function isOperatingDay(date: Date, operatingDays: number[]): boolean {
  return operatingDays.includes(isoWeekday(date));
}

export function countOperatingDays(
  startInclusive: string,
  endInclusive: string,
  operatingDays: number[],
): number {
  return eachDate(startInclusive, endInclusive).filter((d) => isOperatingDay(d, operatingDays)).length;
}

export function daysBetween(startInclusive: string, endInclusive: string): number {
  return Math.round((parseDate(endInclusive).getTime() - parseDate(startInclusive).getTime()) / MS_PER_DAY) + 1;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  // Add a tiny epsilon so values such as 1.005 round the way a reader expects.
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Distributes a whole total across weights without losing or inventing units.
 * Largest-remainder method, so the parts always sum exactly to the total.
 */
export function allocateIntegers(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / weightSum) * total);
  const floored = exact.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; remainder > 0; i = (i + 1) % order.length) {
    floored[order[i].index] += 1;
    remainder -= 1;
  }
  return floored;
}

// ---------------------------------------------------------------------------
// Streaming writers
// ---------------------------------------------------------------------------

export type CsvValue = string | number | boolean | null | undefined;

function encodeCsv(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in CSV output: ${value}`);
    return String(value);
  }
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Backpressure-aware writer. Always emits LF line endings and a trailing
 * newline so regeneration is byte-identical on macOS, Linux and Windows.
 */
class StreamWriter {
  #stream: import('node:fs').WriteStream;
  #closed = false;
  rows = 0;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.#stream = createWriteStream(path, { encoding: 'utf8', flags: 'w' });
  }

  async writeLine(line: string): Promise<void> {
    if (this.#closed) throw new Error(`Writer already closed: ${this.path}`);
    if (!this.#stream.write(`${line}\n`)) {
      await once(this.#stream, 'drain');
    }
  }

  async close(): Promise<number> {
    if (this.#closed) return this.rows;
    this.#closed = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      this.#stream.end((error?: Error | null) => (error ? rejectClose(error) : resolveClose()));
    });
    return this.rows;
  }
}

export class CsvWriter extends StreamWriter {
  #columns: string[];
  #headerWritten = false;

  constructor(path: string, columns: string[]) {
    super(path);
    this.#columns = columns;
  }

  get columns(): string[] {
    return [...this.#columns];
  }

  /** Writes the header row. Call before the first data row. */
  async writeHeader(): Promise<void> {
    if (this.#headerWritten) return;
    this.#headerWritten = true;
    await this.writeLine(this.#columns.join(','));
  }

  async writeRow(row: Record<string, CsvValue>): Promise<void> {
    await this.writeHeader();
    await this.writeLine(this.#columns.map((c) => encodeCsv(row[c])).join(','));
    this.rows += 1;
  }

  async writeRows(rows: Record<string, CsvValue>[]): Promise<void> {
    for (const row of rows) await this.writeRow(row);
  }
}

export class JsonlWriter extends StreamWriter {
  async writeRecord(record: unknown): Promise<void> {
    await this.writeLine(JSON.stringify(record));
    this.rows += 1;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function openCsv(relativePath: string, columns: string[]): Promise<CsvWriter> {
  const full = join(DATA_ROOT, relativePath);
  await ensureDir(dirname(full));
  const writer = new CsvWriter(full, columns);
  await writer.writeHeader();
  return writer;
}

export async function openJsonl(relativePath: string): Promise<JsonlWriter> {
  const full = join(DATA_ROOT, relativePath);
  await ensureDir(dirname(full));
  return new JsonlWriter(full);
}

/** Writes pretty JSON with a trailing newline, matching the repo's style. */
export async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const full = join(DATA_ROOT, relativePath);
  await ensureDir(dirname(full));
  const writer = new StreamWriter(full);
  await writer.writeLine(JSON.stringify(value, null, 2));
  await writer.close();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type GenerationResult = { file: string; rows: number };

export function logResults(label: string, results: GenerationResult[]): number {
  const total = results.reduce((sum, r) => sum + r.rows, 0);
  console.log(`\n${label} (${total.toLocaleString('en-US')} rows)`);
  for (const r of results) {
    console.log(`  ${r.file.padEnd(58)} ${r.rows.toLocaleString('en-US').padStart(12)}`);
  }
  return total;
}
