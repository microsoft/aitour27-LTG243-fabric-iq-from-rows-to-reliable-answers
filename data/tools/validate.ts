#!/usr/bin/env node
// Validates the committed Caldova dataset without regenerating it.

import { createReadStream } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { DATA_ROOT, eachDate, isOperatingDay, parseDate, round } from './lib/core.ts';
import { listPayloadFiles } from './lib/packing.ts';

type Status = 'passed' | 'failed';
type CheckResult = { group: string; name: string; status: Status; detail: string };
type Entity = Record<string, any>;
type CsvRow = Record<string, string>;
type ResolvedFile = {
  expectedPath: string;
  relativePath: string;
  absolutePath: string;
  compressed: boolean;
};
type ExpectedFact = {
  value: string;
  sources: string[];
  numeric: boolean;
  found: boolean;
  foundAt: string | null;
};
type IdKind =
  | 'region'
  | 'product'
  | 'campaign'
  | 'line'
  | 'plant'
  | 'productionOrder'
  | 'policy'
  | 'action'
  | 'receipt'
  | 'case'
  | 'forecastVersion'
  | 'launchPlan'
  | 'scenario'
  | 'option'
  | 'maintenanceWindow'
  | 'signal'
  | 'commitment'
  | 'role'
  | 'policyKey';

const FABRIC_SQL_CSV_FILES = [
  'fabric-sql/action_receipts.csv',
  'fabric-sql/approved_policies.csv',
  'fabric-sql/campaign_commitments.csv',
  'fabric-sql/campaign_scenarios.csv',
  'fabric-sql/campaigns.csv',
  'fabric-sql/capacity_plan.csv',
  'fabric-sql/external_signals.csv',
  'fabric-sql/forecast_assumptions.csv',
  'fabric-sql/forecast_lines.csv',
  'fabric-sql/forecast_versions.csv',
  'fabric-sql/governed_actions.csv',
  'fabric-sql/inventory_positions.csv',
  'fabric-sql/launch_plans.csv',
  'fabric-sql/maintenance_policy_evaluations.csv',
  'fabric-sql/maintenance_windows.csv',
  'fabric-sql/material_reservations.csv',
  'fabric-sql/metric_definitions.csv',
  'fabric-sql/personas.csv',
  'fabric-sql/plants.csv',
  'fabric-sql/production_lines.csv',
  'fabric-sql/production_options.csv',
  'fabric-sql/production_orders.csv',
  'fabric-sql/products.csv',
  'fabric-sql/regions.csv',
  'fabric-sql/sales_order_lines.csv',
  'fabric-sql/scenario_region_allocation.csv',
  'fabric-sql/shift_schedules.csv',
  'fabric-sql/signal_region_impact.csv',
  'fabric-sql/weather_stations.csv',
  'fabric-sql/climate_normals.csv',
  'fabric-sql/weather_events.csv',
  'fabric-sql/weather_demand_response.csv',
  'fabric-sql/weather_elasticity_params.csv',
];

const EVENTHOUSE_CSV_FILES = [
  'eventhouse/CampaignSignals.csv',
  'eventhouse/ClimateSignalObservations.csv',
  'eventhouse/ForecastActualDaily.csv',
  'eventhouse/InventorySnapshots.csv',
  'eventhouse/LineSignals.csv',
  'eventhouse/PlanStateTransitions.csv',
  'eventhouse/SalesObservations.csv',
  'eventhouse/WeatherObservationsDaily.csv',
  'eventhouse/WeatherObservationsHourly.csv',
  'eventhouse/WeatherForecastDaily.csv',
  'eventhouse/WeatherEvents.csv',
];

const LAKEHOUSE_CSV_FILES = [
  'lakehouse/dashboard/campaign-performance.csv',
  'lakehouse/dashboard/forecast-assumptions.csv',
  'lakehouse/dashboard/forecast-variance-by-region.csv',
  'lakehouse/dashboard/hero-demand-trend.csv',
  'lakehouse/dashboard/weather-anomaly-by-region.csv',
  'lakehouse/dashboard/weather-forecast-outlook.csv',
  'lakehouse/dashboard/weather-demand-reconciliation.csv',
];

const DECISION_MEMORY_CSV_FILES = [
  'fabric-sql/decision_case_actions.csv',
  'fabric-sql/decision_case_policies.csv',
  'fabric-sql/decision_case_states.csv',
  'fabric-sql/decision_case_triggers.csv',
  'fabric-sql/decision_cases.csv',
  'fabric-sql/decision_corrections.csv',
  'fabric-sql/decision_outcomes.csv',
];

const EVIDENCE_CSV_FILES = [
  'lakehouse/evidence/campaign_decision_status.csv',
  'lakehouse/evidence/capacity_conflict_summary.csv',
  'lakehouse/evidence/climate_advisories.csv',
  'lakehouse/evidence/demand_signal_explanation.csv',
  'lakehouse/evidence/forecast_briefing_regions.csv',
  'lakehouse/evidence/forecast_briefings.csv',
  'lakehouse/evidence/signal_evidence_trace.csv',
  'lakehouse/evidence/weather_provider.csv',
];

const CSV_FILES = [...FABRIC_SQL_CSV_FILES, ...DECISION_MEMORY_CSV_FILES, ...EVENTHOUSE_CSV_FILES, ...LAKEHOUSE_CSV_FILES, ...EVIDENCE_CSV_FILES];

const JSONL_FILES = [
  'lakehouse/decision-cases/decision-case-timeline.jsonl',
  'lakehouse/decision-cases/decision-cases.jsonl',
  'lakehouse/external-signals/climate-advisories.jsonl',
  'lakehouse/external-signals/weather-events.jsonl',
  'lakehouse/external-signals/forecast-briefings.jsonl',
  'lakehouse/external-signals/signal-evidence-trace.jsonl',
  'lakehouse/retrieval/retrieval-corpus.jsonl',
  'lakehouse/retrieval/retrieval-probes.jsonl',
];

const JSON_FILES = [
  'scenario.json',
  'evaluation/questions.json',
  'evaluation/expected-results.json',
  'receipts/action-receipts.json',
  'lakehouse/external-signals/weather-provider.json',
];

const STATIC_FILES = [
  'fabric-sql/001_schema.sql',
  'fabric-sql/002_stage_views.sql',
  'eventhouse/001_create_tables.kql',
  'eventhouse/002_ingestion_mappings.kql',
  'eventhouse/003_stage_queries.kql',
  'fabric-sql/003_weather_schema.sql',
  'fabric-sql/004_weather_views.sql',
  'fabric-sql/005_decision_memory_schema.sql',
  'fabric-sql/006_decision_memory_views.sql',
  'eventhouse/004_weather_tables.kql',
  'eventhouse/005_weather_mappings.kql',
  'eventhouse/006_weather_stage_queries.kql',
];

const WEATHER_EVENTHOUSE_CSV_FILES = [
  'eventhouse/WeatherObservationsDaily.csv',
  'eventhouse/WeatherObservationsHourly.csv',
  'eventhouse/WeatherForecastDaily.csv',
  'eventhouse/WeatherEvents.csv',
  'eventhouse/ClimateSignalObservations.csv',
];

const WEATHER_FABRIC_SQL_CSV_FILES = [
  'fabric-sql/weather_stations.csv',
  'fabric-sql/climate_normals.csv',
  'fabric-sql/weather_events.csv',
  'fabric-sql/weather_demand_response.csv',
  'fabric-sql/weather_elasticity_params.csv',
];

const WEATHER_LAKEHOUSE_CSV_FILES = [
  'lakehouse/dashboard/weather-anomaly-by-region.csv',
  'lakehouse/dashboard/weather-forecast-outlook.csv',
  'lakehouse/dashboard/weather-demand-reconciliation.csv',
];

const WEATHER_CSV_FILES = [...WEATHER_EVENTHOUSE_CSV_FILES, ...WEATHER_FABRIC_SQL_CSV_FILES, ...WEATHER_LAKEHOUSE_CSV_FILES];
const WEATHER_JSON_FILES = ['lakehouse/external-signals/weather-provider.json'];
const WEATHER_JSONL_FILES = ['lakehouse/external-signals/weather-events.jsonl', 'lakehouse/external-signals/forecast-briefings.jsonl'];
const WEATHER_STATIC_FILES = [
  'eventhouse/004_weather_tables.kql',
  'eventhouse/005_weather_mappings.kql',
  'eventhouse/006_weather_stage_queries.kql',
  'fabric-sql/003_weather_schema.sql',
  'fabric-sql/004_weather_views.sql',
];
const WEATHER_CSV_FILE_SET = new Set(WEATHER_CSV_FILES);
const WEATHER_JSONL_FILE_SET = new Set(WEATHER_JSONL_FILES);

const EXPECTED_PAYLOAD_FILES = [...STATIC_FILES, ...CSV_FILES, ...JSONL_FILES, ...JSON_FILES].sort();

const PRIMARY_KEY_RULES = new Map<string, string[]>([
  ['fabric-sql/action_receipts.csv', ['receiptId']],
  ['fabric-sql/approved_policies.csv', ['policyId', 'policyVersion']],
  ['fabric-sql/campaign_commitments.csv', ['commitmentId']],
  ['fabric-sql/campaign_scenarios.csv', ['scenarioId']],
  ['fabric-sql/campaigns.csv', ['campaignId']],
  ['fabric-sql/decision_case_actions.csv', ['caseId', 'actionId']],
  ['fabric-sql/decision_case_policies.csv', ['caseId', 'policyId', 'policyVersion']],
  ['fabric-sql/decision_case_states.csv', ['caseId', 'sequence']],
  ['fabric-sql/decision_case_triggers.csv', ['caseId', 'triggerType', 'triggerId']],
  ['fabric-sql/decision_cases.csv', ['caseId']],
  ['fabric-sql/decision_corrections.csv', ['correctionId']],
  ['fabric-sql/decision_outcomes.csv', ['outcomeId']],
  ['fabric-sql/external_signals.csv', ['signalId']],
  ['fabric-sql/forecast_assumptions.csv', ['assumptionId']],
  ['fabric-sql/forecast_lines.csv', ['forecastVersionId', 'regionId', 'productId']],
  ['fabric-sql/forecast_versions.csv', ['forecastVersionId']],
  ['fabric-sql/governed_actions.csv', ['actionId']],
  ['fabric-sql/inventory_positions.csv', ['snapshotDate', 'regionId', 'productId']],
  ['fabric-sql/launch_plans.csv', ['launchPlanId']],
  ['fabric-sql/maintenance_policy_evaluations.csv', ['optionId', 'policyId', 'policyVersion']],
  ['fabric-sql/maintenance_windows.csv', ['maintenanceWindowId']],
  ['fabric-sql/material_reservations.csv', ['reservationId']],
  ['fabric-sql/metric_definitions.csv', ['metricId', 'metricVersion']],
  ['fabric-sql/personas.csv', ['personaId']],
  ['fabric-sql/plants.csv', ['plantId']],
  ['fabric-sql/production_lines.csv', ['lineId']],
  ['fabric-sql/production_options.csv', ['optionId']],
  ['fabric-sql/production_orders.csv', ['productionOrderId']],
  ['fabric-sql/products.csv', ['productId']],
  ['fabric-sql/regions.csv', ['regionId']],
  ['fabric-sql/scenario_region_allocation.csv', ['scenarioId', 'regionId']],
  ['fabric-sql/shift_schedules.csv', ['scheduleDate', 'lineId']],
  ['fabric-sql/signal_region_impact.csv', ['signalId', 'regionId']],
]);

const FK_RULES = [
  { file: 'fabric-sql/sales_order_lines.csv', column: 'regionId', refKind: 'region', label: 'sales_order_lines.regionId' },
  { file: 'fabric-sql/sales_order_lines.csv', column: 'productId', refKind: 'product', label: 'sales_order_lines.productId' },
  { file: 'fabric-sql/production_orders.csv', column: 'lineId', refKind: 'line', label: 'production_orders.lineId' },
  { file: 'fabric-sql/production_orders.csv', column: 'productId', refKind: 'product', label: 'production_orders.productId' },
  { file: 'fabric-sql/production_orders.csv', column: 'commitmentId', refKind: 'commitment', label: 'production_orders.commitmentId' },
  {
    file: 'fabric-sql/production_orders.csv',
    column: 'maintenanceWindowId',
    refKind: 'maintenanceWindow',
    label: 'production_orders.maintenanceWindowId',
  },
  {
    file: 'fabric-sql/material_reservations.csv',
    column: 'productionOrderId',
    refKind: 'productionOrder',
    label: 'material_reservations.productionOrderId',
  },
  { file: 'fabric-sql/inventory_positions.csv', column: 'regionId', refKind: 'region', label: 'inventory_positions.regionId' },
  { file: 'fabric-sql/inventory_positions.csv', column: 'productId', refKind: 'product', label: 'inventory_positions.productId' },
  { file: 'fabric-sql/capacity_plan.csv', column: 'lineId', refKind: 'line', label: 'capacity_plan.lineId' },
  { file: 'fabric-sql/capacity_plan.csv', column: 'maintenanceWindowId', refKind: 'maintenanceWindow', label: 'capacity_plan.maintenanceWindowId' },
  { file: 'fabric-sql/capacity_plan.csv', column: 'optionId', refKind: 'option', label: 'capacity_plan.optionId' },
  { file: 'fabric-sql/capacity_plan.csv', column: 'commitmentId', refKind: 'commitment', label: 'capacity_plan.commitmentId' },
  { file: 'fabric-sql/forecast_lines.csv', column: 'forecastVersionId', refKind: 'forecastVersion', label: 'forecast_lines.forecastVersionId' },
  { file: 'fabric-sql/forecast_lines.csv', column: 'regionId', refKind: 'region', label: 'forecast_lines.regionId' },
  { file: 'fabric-sql/forecast_lines.csv', column: 'productId', refKind: 'product', label: 'forecast_lines.productId' },
] as { file: string; column: string; refKind: IdKind; label: string }[];

const ID_KIND_LABELS: Record<IdKind, string> = {
  region: 'regionId',
  product: 'productId',
  campaign: 'campaignId',
  line: 'lineId',
  plant: 'plantId',
  productionOrder: 'productionOrderId',
  policy: 'policyId',
  action: 'actionId',
  receipt: 'receiptId',
  case: 'caseId',
  forecastVersion: 'forecastVersionId',
  launchPlan: 'launchPlanId',
  scenario: 'scenarioId',
  option: 'optionId',
  maintenanceWindow: 'maintenanceWindowId',
  signal: 'signalId',
  commitment: 'commitmentId',
  role: 'roleId',
  policyKey: 'policyId/policyVersion',
};

const BROAD_REFERENTIAL_KINDS: IdKind[] = [
  'region',
  'product',
  'campaign',
  'line',
  'plant',
  'productionOrder',
  'policy',
  'action',
  'receipt',
  'case',
];

const PERSONAL_HEADER_TERMS = ['email', 'phone', 'ssn', 'patient', 'firstname', 'lastname', 'address', 'dob'];
const JSON_PERSONA_ALLOWED_KEYS = new Set(['narrative', 'description', 'text', 'title', 'summary']);
const KNOWN_ID_PREFIXES = [
  'CASE',
  'RCPT',
  'ACT',
  'SCN',
  'SIG',
  'POL',
  'OPT',
  'PROD',
  'REG',
  'PKG',
  'PLANT',
  'CMT',
  'FC',
  'ASM',
  'CORR',
  'OUT',
  'METRIC',
  'MW',
];

const results: CheckResult[] = [];

function pass(group: string, name: string, detail = ''): void {
  results.push({ group, name, status: 'passed', detail });
}

function fail(group: string, name: string, detail: string): void {
  results.push({ group, name, status: 'failed', detail });
}

function runCheck(group: string, name: string, fn: () => string | void): void {
  try {
    const detail = fn();
    pass(group, name, detail ?? '');
  } catch (error) {
    fail(group, name, errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sample(values: string[], limit = 8): string {
  if (values.length <= limit) return values.join('; ');
  return `${values.slice(0, limit).join('; ')}; ... ${values.length - limit} more`;
}

function pushSample(values: string[], value: string, limit = 25): void {
  if (values.length < limit) values.push(value);
}

function isPlainObject(value: unknown): value is Entity {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): Entity[] {
  return Array.isArray(value) ? (value as Entity[]) : [];
}

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === '';
}

function dateKeyFromTimestamp(value: string): string {
  return value.slice(0, 10);
}

function isBetweenDate(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function approxEqual(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function normalizedCsvName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

export async function resolveLogicalFile(relativePath: string, root = DATA_ROOT): Promise<ResolvedFile | null> {
  const candidates =
    relativePath.endsWith('.csv') || relativePath.endsWith('.jsonl') ? [relativePath, `${relativePath}.gz`] : [relativePath];
  for (const candidate of candidates) {
    const absolutePath = join(root, candidate);
    try {
      await access(absolutePath);
      return {
        expectedPath: relativePath,
        relativePath: candidate,
        absolutePath,
        compressed: candidate.endsWith('.gz'),
      };
    } catch {
      // Try the next candidate; callers convert absence into a validation result.
    }
  }
  return null;
}

export function createTransparentReadStream(absolutePath: string): Readable {
  const stream = createReadStream(absolutePath);
  return absolutePath.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
}

export function parseCsvLine(line: string): { ok: true; values: string[] } | { ok: false; error: string } {
  const values: string[] = [];
  let value = '';
  let inQuotes = false;
  let quoteClosed = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\r' && i === line.length - 1) continue;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        value += char;
      }
      continue;
    }
    if (char === ',') {
      values.push(value);
      value = '';
      quoteClosed = false;
      continue;
    }
    if (char === '"') {
      if (value.length === 0 && !quoteClosed) {
        inQuotes = true;
        continue;
      }
      return { ok: false, error: 'unexpected quote in unquoted field' };
    }
    if (quoteClosed && char.trim() !== '') return { ok: false, error: 'unexpected character after closing quote' };
    value += char;
  }
  if (inQuotes) return { ok: false, error: 'unterminated quoted field' };
  values.push(value);
  return { ok: true, values };
}

async function parseJsonFile(relativePath: string, group = 'Structure'): Promise<unknown> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) {
    fail(group, `${relativePath} parses as JSON`, `Missing file (checked ${relativePath})`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(found.absolutePath, 'utf8'));
    pass(group, `${relativePath} parses as JSON`, 'valid JSON');
    return parsed;
  } catch (error) {
    fail(group, `${relativePath} parses as JSON`, errorMessage(error));
    return undefined;
  }
}

async function streamCsv(
  relativePath: string,
  callbacks: {
    onHeader?: (header: string[], context: { relativePath: string; actualPath: string }) => void;
    onRow?: (row: CsvRow, context: { relativePath: string; actualPath: string; lineNumber: number }) => void;
  },
  group = 'Structure',
): Promise<{ ok: boolean; rows: number; header: string[] }> {
  const found = await resolveLogicalFile(relativePath);
  const problems: string[] = [];
  let rows = 0;
  let header: string[] = [];
  if (!found) {
    fail(group, `${relativePath} parses as CSV`, `Missing file (checked ${relativePath} or ${relativePath}.gz)`);
    return { ok: false, rows, header };
  }
  try {
    const reader = createInterface({ input: createTransparentReadStream(found.absolutePath), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const rawLine of reader) {
      lineNumber += 1;
      const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      const parsed = parseCsvLine(line);
      if (!parsed.ok) {
        pushSample(problems, `line ${lineNumber}: ${parsed.error}`);
        continue;
      }
      if (lineNumber === 1) {
        header = parsed.values;
        if (header.length === 0 || header.every((column) => column.trim() === '')) {
          pushSample(problems, 'line 1: missing header');
        } else {
          callbacks.onHeader?.(header, { relativePath, actualPath: found.relativePath });
        }
        continue;
      }
      if (parsed.values.length !== header.length) {
        pushSample(
          problems,
          `line ${lineNumber}: expected ${header.length} columns, found ${parsed.values.length}`,
        );
        continue;
      }
      const row: CsvRow = {};
      for (let i = 0; i < header.length; i += 1) row[header[i]] = parsed.values[i];
      rows += 1;
      callbacks.onRow?.(row, { relativePath, actualPath: found.relativePath, lineNumber });
    }
    if (lineNumber === 0) pushSample(problems, 'empty file');
  } catch (error) {
    pushSample(problems, errorMessage(error));
  }
  if (problems.length > 0) {
    fail(group, `${relativePath} parses as CSV`, `${rows} data rows read; ${sample(problems)}`);
    return { ok: false, rows, header };
  }
  pass(group, `${relativePath} parses as CSV`, `${rows.toLocaleString('en-US')} data rows`);
  return { ok: true, rows, header };
}

async function streamJsonl(
  relativePath: string,
  onRecord: (record: unknown, context: { relativePath: string; actualPath: string; lineNumber: number }) => void,
  group = 'Structure',
): Promise<{ ok: boolean; rows: number }> {
  const found = await resolveLogicalFile(relativePath);
  const problems: string[] = [];
  let rows = 0;
  if (!found) {
    fail(group, `${relativePath} parses as JSONL`, `Missing file (checked ${relativePath} or ${relativePath}.gz)`);
    return { ok: false, rows };
  }
  try {
    const reader = createInterface({ input: createTransparentReadStream(found.absolutePath), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const rawLine of reader) {
      lineNumber += 1;
      const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      if (line.trim() === '') {
        pushSample(problems, `line ${lineNumber}: empty JSONL line`);
        continue;
      }
      try {
        const record = JSON.parse(line);
        rows += 1;
        onRecord(record, { relativePath, actualPath: found.relativePath, lineNumber });
      } catch (error) {
        pushSample(problems, `line ${lineNumber}: ${errorMessage(error)}`);
      }
    }
    if (lineNumber === 0) pushSample(problems, 'empty file');
  } catch (error) {
    pushSample(problems, errorMessage(error));
  }
  if (problems.length > 0) {
    fail(group, `${relativePath} parses as JSONL`, `${rows} records read; ${sample(problems)}`);
    return { ok: false, rows };
  }
  pass(group, `${relativePath} parses as JSONL`, `${rows.toLocaleString('en-US')} records`);
  return { ok: true, rows };
}

function isKnownIdValue(value: string): boolean {
  if (/^20\d{2}\.\d{2}\.\d{2}-\d+$/.test(value)) return true;
  return KNOWN_ID_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}-`));
}

function isPureNumber(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value);
}

function expectedFactTargets(questions: unknown): ExpectedFact[] {
  const byValue = new Map<string, ExpectedFact>();
  for (const question of Array.isArray(questions) ? questions : []) {
    const source = stringValue((question as Entity).id || (question as Entity).demo || 'question');
    for (const rawFact of Array.isArray((question as Entity).expectedFacts) ? (question as Entity).expectedFacts : []) {
      const value = stringValue(rawFact).trim();
      if (!value || (!isPureNumber(value) && !isKnownIdValue(value))) continue;
      const existing = byValue.get(value);
      if (existing) {
        existing.sources.push(source);
      } else {
        byValue.set(value, { value, sources: [source], numeric: isPureNumber(value), found: false, foundAt: null });
      }
    }
  }
  return [...byValue.values()];
}

function markExpectedFactsInPrimitive(value: unknown, location: string, facts: ExpectedFact[]): void {
  if (facts.length === 0) return;
  if (typeof value === 'number') {
    for (const fact of facts) {
      if (!fact.found && fact.numeric && approxEqual(value, Number(fact.value), 0.000001)) {
        fact.found = true;
        fact.foundAt = location;
      }
    }
    return;
  }
  if (typeof value !== 'string') return;
  for (const fact of facts) {
    if (!fact.found && value.includes(fact.value)) {
      fact.found = true;
      fact.foundAt = location;
    }
  }
}

function markExpectedFactsInValue(value: unknown, location: string, facts: ExpectedFact[]): void {
  markExpectedFactsInPrimitive(value, location, facts);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) markExpectedFactsInValue(value[i], `${location}[${i}]`, facts);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) markExpectedFactsInValue(child, `${location}.${key}`, facts);
}

function idKindForKey(key: string): IdKind | null {
  const normalized = normalizeKey(key);
  if (normalized.endsWith('regionid') || normalized.endsWith('regionids')) return 'region';
  if (normalized.endsWith('productid') || normalized.endsWith('productids')) return 'product';
  if (normalized.endsWith('campaignid') || normalized.endsWith('campaignids')) return 'campaign';
  if (normalized === 'orderlineid' || normalized === 'orderlineids') return null;
  if (normalized.endsWith('lineid') || normalized.endsWith('lineids')) return 'line';
  if (normalized.endsWith('plantid') || normalized.endsWith('plantids')) return 'plant';
  if (normalized.endsWith('productionorderid') || normalized.endsWith('productionorderids')) return 'productionOrder';
  if (normalized.endsWith('policyid') || normalized.endsWith('policyids')) return 'policy';
  if (normalized.endsWith('actionid') || normalized.endsWith('actionids')) return 'action';
  if (normalized.endsWith('receiptid') || normalized.endsWith('receiptids')) return 'receipt';
  if (normalized.endsWith('caseid') || normalized.endsWith('caseids')) return 'case';
  return null;
}

function addMapSample(map: Map<string, string[]>, value: string, location: string): void {
  const locations = map.get(value) ?? [];
  if (locations.length < 5) locations.push(location);
  map.set(value, locations);
}

function addReference(references: Map<IdKind, Set<string>>, kind: IdKind, value: unknown): void {
  if (isBlank(value)) return;
  references.get(kind)?.add(String(value));
}

function hasReference(references: Map<IdKind, Set<string>>, kind: IdKind, value: string): boolean {
  return references.get(kind)?.has(value) ?? false;
}

function makeReferenceMap(): Map<IdKind, Set<string>> {
  const entries = Object.keys(ID_KIND_LABELS).map((kind) => [kind as IdKind, new Set<string>()] as [IdKind, Set<string>]);
  return new Map(entries);
}

function makeOccurrenceMap(): Map<IdKind, Map<string, string[]>> {
  const entries = BROAD_REFERENTIAL_KINDS.map((kind) => [kind, new Map<string, string[]>()] as [IdKind, Map<string, string[]>]);
  return new Map(entries);
}

function recordIdentifierOccurrence(
  occurrences: Map<IdKind, Map<string, string[]>>,
  key: string,
  value: unknown,
  location: string,
): void {
  if (isBlank(value)) return;
  const kind = idKindForKey(key);
  if (!kind || !BROAD_REFERENTIAL_KINDS.includes(kind)) return;
  const map = occurrences.get(kind);
  if (!map) return;
  const raw = String(value);
  // Evidence projections encode id lists as '; '-delimited strings so they survive
  // a flat CSV column. Split them so every id is checked individually rather than
  // the whole list being treated as one unresolvable identifier.
  const candidates = raw.includes(';') ? raw.split(';').map((part) => part.trim()) : [raw];
  for (const candidate of candidates) {
    if (candidate !== '') addMapSample(map, candidate, location);
  }
}

function scanJsonIdentifiers(
  value: unknown,
  location: string,
  key: string | null,
  occurrences: Map<IdKind, Map<string, string[]>>,
): void {
  if (key && (typeof value === 'string' || typeof value === 'number')) {
    recordIdentifierOccurrence(occurrences, key, value, location);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanJsonIdentifiers(value[i], `${location}[${i}]`, key, occurrences);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [childKey, child] of Object.entries(value)) {
    scanJsonIdentifiers(child, `${location}.${childKey}`, childKey, occurrences);
  }
}

function scanCsvIdentifiers(row: CsvRow, location: string, occurrences: Map<IdKind, Map<string, string[]>>): void {
  for (const [column, value] of Object.entries(row)) recordIdentifierOccurrence(occurrences, column, value, `${location}.${column}`);
}

function addScenarioReferences(scenario: Entity, references: Map<IdKind, Set<string>>): void {
  for (const region of asArray(scenario.regions)) addReference(references, 'region', region.regionId);
  for (const product of asArray(scenario.products)) addReference(references, 'product', product.productId);
  for (const campaign of asArray(scenario.campaigns)) addReference(references, 'campaign', campaign.campaignId);
  for (const plant of asArray(scenario.plants)) addReference(references, 'plant', plant.plantId);
  for (const line of asArray(scenario.productionLines)) addReference(references, 'line', line.lineId);
  for (const policy of asArray(scenario.policies)) {
    addReference(references, 'policy', policy.policyId);
    if (!isBlank(policy.policyId) && !isBlank(policy.version)) addReference(references, 'policyKey', `${policy.policyId}:${policy.version}`);
  }
  for (const action of asArray(scenario.actions)) {
    addReference(references, 'action', action.actionId);
    addReference(references, 'receipt', action.receiptId);
  }
  for (const option of asArray(scenario.options)) addReference(references, 'option', option.optionId);
  for (const commercialScenario of asArray(scenario.scenarios)) addReference(references, 'scenario', commercialScenario.scenarioId);
  for (const assumption of asArray(scenario.forecast?.assumptions)) addReference(references, 'signal', assumption.invalidatedBySignalId);
  for (const role of Array.isArray(scenario.approverRoles) ? scenario.approverRoles : []) addReference(references, 'role', role);
  addReference(references, 'launchPlan', scenario.launchPlan?.launchPlanId);
  addReference(references, 'commitment', scenario.commitment?.commitmentId);
  addReference(references, 'signal', scenario.externalSignal?.signalId);
  addReference(references, 'case', scenario.decisionCase?.caseId);
  addReference(references, 'case', scenario.commitment?.originCaseId);
  addReference(references, 'maintenanceWindow', scenario.maintenance?.maintenanceWindowId);
  const baselineVersionId = scenario.evidenceChain?.hops?.find?.((hop: Entity) => hop.relation === 'campaign_built_on_forecast_version')?.to;
  addReference(references, 'forecastVersion', baselineVersionId);
}

function seedGovernedActionsFromScenario(scenario: Entity, governedActions: Entity[]): void {
  for (const [index, action] of asArray(scenario.actions).entries()) {
    governedActions.push({
      actionId: action.actionId,
      role: action.approvedByRole ?? action.approverRole,
      receiptId: action.receiptId,
      location: `scenario.json.actions[${index}]`,
    });
  }
}

function uniqueIds(items: Entity[], key: string): string[] {
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = stringValue(item[key]);
    if (!value) continue;
    if (seen.has(value)) duplicates.push(value);
    else seen.add(value);
  }
  return duplicates;
}

function collectScenarioUniquenessFailures(scenario: Entity): string[] {
  const checks = [
    ['regions', 'regionId', asArray(scenario.regions)],
    ['products', 'productId', asArray(scenario.products)],
    ['campaigns', 'campaignId', asArray(scenario.campaigns)],
    ['plants', 'plantId', asArray(scenario.plants)],
    ['productionLines', 'lineId', asArray(scenario.productionLines)],
    ['options', 'optionId', asArray(scenario.options)],
    ['scenarios', 'scenarioId', asArray(scenario.scenarios)],
    ['actions', 'actionId', asArray(scenario.actions)],
    ['personas', 'personaId', asArray(scenario.personas)],
  ];
  const failures: string[] = [];
  for (const [label, key, items] of checks) {
    const duplicates = uniqueIds(items as Entity[], key as string);
    if (duplicates.length > 0) failures.push(`${label}.${key}: ${duplicates.join(', ')}`);
  }
  const policyKeys = new Set<string>();
  for (const policy of asArray(scenario.policies)) {
    const key = `${policy.policyId}:${policy.version}`;
    if (policyKeys.has(key)) failures.push(`policies.policyId/version: ${key}`);
    else policyKeys.add(key);
  }
  return failures;
}

function isRoleIdentifierColumn(column: string): boolean {
  const key = normalizeKey(column);
  return (
    key === 'approvedbyrole' ||
    key === 'approverrole' ||
    key === 'requiredapproverrole' ||
    key === 'secondaryapproverrole' ||
    key === 'proposedbyrole' ||
    key === 'actorrole'
  );
}

function scanApprovalValue(
  column: string,
  value: string,
  location: string,
  personaNamesLower: string[],
  violations: string[],
): void {
  if (isBlank(value)) return;
  const key = normalizeKey(column);
  if (key.includes('approv')) {
    const lower = value.toLowerCase();
    for (const personaName of personaNamesLower) {
      if (personaName && lower.includes(personaName)) {
        pushSample(violations, `${location} contains persona display name`);
        break;
      }
    }
  }
  if (isRoleIdentifierColumn(column) && !/^ROLE-[A-Z0-9-]+$/.test(value)) {
    pushSample(violations, `${location} must contain a ROLE-* identifier, found '${value}'`);
  }
}

function scanJsonSafety(
  value: unknown,
  location: string,
  key: string | null,
  personaNamesLower: string[],
  personaLeaks: string[],
  approvalViolations: string[],
): void {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    for (const personaName of personaNamesLower) {
      if (personaName && lower.includes(personaName) && (!key || !JSON_PERSONA_ALLOWED_KEYS.has(key))) {
        pushSample(personaLeaks, `${location} contains persona display name outside narrative text fields`);
        break;
      }
    }
    if (key) scanApprovalValue(key, value, location, personaNamesLower, approvalViolations);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanJsonSafety(value[i], `${location}[${i}]`, key, personaNamesLower, personaLeaks, approvalViolations);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [childKey, child] of Object.entries(value)) {
    scanJsonSafety(child, `${location}.${childKey}`, childKey, personaNamesLower, personaLeaks, approvalViolations);
  }
}

function scanCsvSafety(
  relativePath: string,
  row: CsvRow,
  lineNumber: number,
  personaNamesLower: string[],
  personaLeaks: string[],
  approvalViolations: string[],
): void {
  const fileName = normalizedCsvName(relativePath);
  for (const [column, value] of Object.entries(row)) {
    const location = `${relativePath}:${lineNumber}.${column}`;
    if (fileName !== 'personas.csv') {
      const lower = value.toLowerCase();
      for (const personaName of personaNamesLower) {
        if (personaName && lower.includes(personaName)) {
          pushSample(personaLeaks, `${location} contains persona display name`);
          break;
        }
      }
    }
    scanApprovalValue(column, value, location, personaNamesLower, approvalViolations);
  }
}

function scanCsvHeadersForPersonalFields(relativePath: string, header: string[], violations: string[]): void {
  for (const column of header) {
    const normalized = normalizeKey(column);
    const term = PERSONAL_HEADER_TERMS.find((candidate) => normalized.includes(candidate));
    if (term) pushSample(violations, `${relativePath}.${column} matches personal field '${term}'`);
  }
}

function addReferenceFromCsvRow(relativePath: string, row: CsvRow, references: Map<IdKind, Set<string>>): void {
  switch (relativePath) {
    case 'fabric-sql/action_receipts.csv':
      addReference(references, 'receipt', row.receiptId);
      addReference(references, 'action', row.actionId);
      addReference(references, 'policy', row.policyId);
      addReference(references, 'policyKey', `${row.policyId}:${row.policyVersion}`);
      break;
    case 'fabric-sql/approved_policies.csv':
      addReference(references, 'policy', row.policyId);
      addReference(references, 'policyKey', `${row.policyId}:${row.policyVersion}`);
      break;
    case 'fabric-sql/campaign_commitments.csv':
      addReference(references, 'commitment', row.commitmentId);
      break;
    case 'fabric-sql/campaign_scenarios.csv':
      addReference(references, 'scenario', row.scenarioId);
      break;
    case 'fabric-sql/campaigns.csv':
      addReference(references, 'campaign', row.campaignId);
      break;
    case 'fabric-sql/decision_cases.csv':
      addReference(references, 'case', row.caseId);
      break;
    case 'fabric-sql/external_signals.csv':
      addReference(references, 'signal', row.signalId);
      break;
    case 'fabric-sql/forecast_versions.csv':
      addReference(references, 'forecastVersion', row.forecastVersionId);
      break;
    case 'fabric-sql/governed_actions.csv':
      addReference(references, 'action', row.actionId);
      break;
    case 'fabric-sql/launch_plans.csv':
      addReference(references, 'launchPlan', row.launchPlanId);
      break;
    case 'fabric-sql/maintenance_windows.csv':
      addReference(references, 'maintenanceWindow', row.maintenanceWindowId);
      break;
    case 'fabric-sql/plants.csv':
      addReference(references, 'plant', row.plantId);
      break;
    case 'fabric-sql/production_lines.csv':
      addReference(references, 'line', row.lineId);
      break;
    case 'fabric-sql/production_options.csv':
      addReference(references, 'option', row.optionId);
      break;
    case 'fabric-sql/production_orders.csv':
      addReference(references, 'productionOrder', row.productionOrderId);
      break;
    case 'fabric-sql/products.csv':
      addReference(references, 'product', row.productId);
      break;
    case 'fabric-sql/regions.csv':
      addReference(references, 'region', row.regionId);
      break;
    default:
      break;
  }
}

function policyKey(policyId: unknown, version: unknown): string {
  return `${stringValue(policyId)}:${stringValue(version)}`;
}

function initializePrimaryKeyTrackers(): Map<string, { columns: string[]; seen: Set<string>; duplicates: string[]; blanks: string[]; rows: number }> {
  const trackers = new Map<string, { columns: string[]; seen: Set<string>; duplicates: string[]; blanks: string[]; rows: number }>();
  for (const [file, columns] of PRIMARY_KEY_RULES.entries()) {
    trackers.set(file, { columns, seen: new Set(), duplicates: [], blanks: [], rows: 0 });
  }
  return trackers;
}

function updatePrimaryKeyTracker(
  relativePath: string,
  row: CsvRow,
  lineNumber: number,
  trackers: Map<string, { columns: string[]; seen: Set<string>; duplicates: string[]; blanks: string[]; rows: number }>,
): void {
  const tracker = trackers.get(relativePath);
  if (!tracker) return;
  tracker.rows += 1;
  const values = tracker.columns.map((column) => row[column] ?? '');
  const key = values.join('|');
  if (values.some((value) => value.trim() === '')) {
    pushSample(tracker.blanks, `${relativePath}:${lineNumber} has blank key (${tracker.columns.join(', ')})`);
    return;
  }
  if (tracker.seen.has(key)) {
    pushSample(tracker.duplicates, `${relativePath}:${lineNumber} duplicate key ${key}`);
  } else {
    tracker.seen.add(key);
  }
}

function initializeFkTrackers(): Map<string, { rule: (typeof FK_RULES)[number]; values: Map<string, string[]> }> {
  const trackers = new Map<string, { rule: (typeof FK_RULES)[number]; values: Map<string, string[]> }>();
  for (const rule of FK_RULES) trackers.set(rule.label, { rule, values: new Map() });
  return trackers;
}

function updateFkTrackers(
  relativePath: string,
  row: CsvRow,
  lineNumber: number,
  trackers: Map<string, { rule: (typeof FK_RULES)[number]; values: Map<string, string[]> }>,
): void {
  for (const tracker of trackers.values()) {
    if (tracker.rule.file !== relativePath) continue;
    const value = row[tracker.rule.column];
    if (isBlank(value)) continue;
    addMapSample(tracker.values, value, `${relativePath}:${lineNumber}.${tracker.rule.column}`);
  }
}

function collectJsonlReferences(relativePath: string, record: unknown, lineNumber: number, references: Map<IdKind, Set<string>>): void {
  if (!isPlainObject(record)) return;
  if (relativePath === 'lakehouse/decision-cases/decision-cases.jsonl') {
    addReference(references, 'case', record.caseId);
    for (const action of Array.isArray(record.governedActions) ? record.governedActions : []) addReference(references, 'action', action.actionId);
  } else if (relativePath === 'lakehouse/retrieval/retrieval-corpus.jsonl') {
    addReference(references, 'case', record.caseId);
  } else if (relativePath.startsWith('lakehouse/external-signals/')) {
    addReference(references, 'signal', record.signalId);
  }
  if (relativePath === 'lakehouse/decision-cases/decision-case-timeline.jsonl') addReference(references, 'case', record.caseId);
  if (relativePath === 'lakehouse/retrieval/retrieval-probes.jsonl') addReference(references, 'case', record.expectedCaseId);
}

function collectGovernedActionsFromJsonl(relativePath: string, record: unknown, lineNumber: number, governedActions: Entity[]): void {
  if (relativePath !== 'lakehouse/decision-cases/decision-cases.jsonl' || !isPlainObject(record)) return;
  const actions = Array.isArray(record.governedActions) ? record.governedActions : [];
  for (const [index, action] of actions.entries()) {
    governedActions.push({
      actionId: action.actionId,
      role: action.approverRole ?? action.approvedByRole,
      receiptId: action.receiptId,
      location: `${relativePath}:${lineNumber}.governedActions[${index}]`,
    });
  }
}

function collectReferencesFromReceiptsJson(receipts: unknown, references: Map<IdKind, Set<string>>, receiptJsonIds: Set<string>): void {
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    addReference(references, 'receipt', receipt.receiptId);
    addReference(references, 'action', receipt.actionId);
    if (!isBlank(receipt.receiptId)) receiptJsonIds.add(String(receipt.receiptId));
  }
}

function collectRetrievalProbeData(
  relativePath: string,
  record: unknown,
  retrievalChunkIds: Set<string>,
  probeExpectations: { probeId: string; caseId: string; chunkIds: string[]; location: string }[],
): void {
  if (!isPlainObject(record)) return;
  if (relativePath === 'lakehouse/retrieval/retrieval-corpus.jsonl') {
    if (!isBlank(record.chunkId)) retrievalChunkIds.add(String(record.chunkId));
  }
  if (relativePath === 'lakehouse/retrieval/retrieval-probes.jsonl') {
    probeExpectations.push({
      probeId: stringValue(record.probeId),
      caseId: stringValue(record.expectedCaseId),
      chunkIds: Array.isArray(record.expectedChunkIds) ? record.expectedChunkIds.map(String) : [],
      location: relativePath,
    });
  }
}

function addReceiptReferencesFromJson(receipts: unknown, references: Map<IdKind, Set<string>>): void {
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    addReference(references, 'receipt', receipt.receiptId);
    addReference(references, 'action', receipt.actionId);
  }
}

type NumberAggregate = { sum: number; count: number };
type WeatherDailyObservation = {
  temperatureMeanC: number;
  uvIndex: number;
  temperatureMeanAnomalyC: number;
  uvIndexAnomaly: number;
  location: string;
};
type WeatherNormal = { temperatureMeanNormalC: number; uvIndexNormal: number; location: string };
type WeatherHourlyAggregate = { temperatureSum: number; uvMax: number; count: number };
type WeatherEventSource = {
  rows: number;
  ids: Set<string>;
  duplicateIds: string[];
  eventTypes: Set<string>;
  unknownRegionIds: string[];
  ensoSignalViolations: string[];
  unaffectedRegionIds: Set<string>;
  irrelevantEventTypes: Set<string>;
};
type WeatherValidationState = {
  csvRowCounts: Map<string, number>;
  csvHeaders: Map<string, string[]>;
  jsonlRowCounts: Map<string, number>;
  dailyObservations: Map<string, WeatherDailyObservation>;
  dailyWindowUvAnomalies: Map<string, NumberAggregate>;
  dailyWindowTemperatureAnomalies: Map<string, NumberAggregate>;
  climateSignalUvByRegionDate: Map<string, { uvIndex: number; location: string }>;
  normalsByRegionDayOfYear: Map<string, WeatherNormal>;
  hourlyAggregates: Map<string, WeatherHourlyAggregate>;
  hourlyNightUvViolations: string[];
  forecastBandViolations: string[];
  forecastBandViolationCount: number;
  forecastSkillByLeadDay: Map<number, NumberAggregate>;
  forecastSkillByRegionTarget: Map<string, Map<number, number>>;
  decisionForecastByRegion: Map<string, { leads: Set<number>; positiveViolations: string[]; nearZeroViolations: string[] }>;
  decisionForecastMaxTargetDate: string;
  demandResponseFormulaViolations: string[];
  demandResponseWindowUplift: Map<string, NumberAggregate>;
  demandResponseModelViolations: string[];
  demandReconciliationViolations: string[];
  demandReconciliationRegions: Set<string>;
  physicalViolations: string[];
  uvAlertViolationCount: number;
  csvDisclosureViolations: string[];
  csvFilesWithSyntheticLabelling: Set<string>;
  csvFilesWithoutSyntheticLabelling: Set<string>;
  jsonDisclosureViolations: string[];
  eventSources: Record<string, WeatherEventSource>;
  decisionBriefing: { record: Entity; location: string } | null;
};

function makeWeatherValidationState(): WeatherValidationState {
  return {
    csvRowCounts: new Map(),
    csvHeaders: new Map(),
    jsonlRowCounts: new Map(),
    dailyObservations: new Map(),
    dailyWindowUvAnomalies: new Map(),
    dailyWindowTemperatureAnomalies: new Map(),
    climateSignalUvByRegionDate: new Map(),
    normalsByRegionDayOfYear: new Map(),
    hourlyAggregates: new Map(),
    hourlyNightUvViolations: [],
    forecastBandViolations: [],
    forecastBandViolationCount: 0,
    forecastSkillByLeadDay: new Map(),
    forecastSkillByRegionTarget: new Map(),
    decisionForecastByRegion: new Map(),
    decisionForecastMaxTargetDate: '',
    demandResponseFormulaViolations: [],
    demandResponseWindowUplift: new Map(),
    demandResponseModelViolations: [],
    demandReconciliationViolations: [],
    demandReconciliationRegions: new Set(),
    physicalViolations: [],
    uvAlertViolationCount: 0,
    csvDisclosureViolations: [],
    csvFilesWithSyntheticLabelling: new Set(),
    csvFilesWithoutSyntheticLabelling: new Set(),
    jsonDisclosureViolations: [],
    eventSources: {
      'eventhouse/WeatherEvents.csv': makeWeatherEventSource(),
      'fabric-sql/weather_events.csv': makeWeatherEventSource(),
      'lakehouse/external-signals/weather-events.jsonl': makeWeatherEventSource(),
    },
    decisionBriefing: null,
  };
}

function makeWeatherEventSource(): WeatherEventSource {
  return {
    rows: 0,
    ids: new Set(),
    duplicateIds: [],
    eventTypes: new Set(),
    unknownRegionIds: [],
    ensoSignalViolations: [],
    unaffectedRegionIds: new Set(),
    irrelevantEventTypes: new Set(),
  };
}

function addNumberAggregate<K extends string | number>(map: Map<K, NumberAggregate>, key: K, value: number): void {
  const aggregate = map.get(key) ?? { sum: 0, count: 0 };
  aggregate.sum += value;
  aggregate.count += 1;
  map.set(key, aggregate);
}

function aggregateMean(aggregate: NumberAggregate | undefined): number {
  return aggregate && aggregate.count > 0 ? aggregate.sum / aggregate.count : Number.NaN;
}

function weatherRegionDateKey(regionId: string, dateKey: string): string {
  return `${regionId}|${dateKey}`;
}

function weatherRegionDayOfYearKey(regionId: string, dayOfYear: number): string {
  return `${regionId}|${dayOfYear}`;
}

function dayOfYearUtc(dateValue: string): number {
  const date = parseDate(dateValue);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000) + 1;
}

function hasLeapYear(startYear: number, endYear: number): boolean {
  for (let year = startYear; year <= endYear; year += 1) {
    if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) return true;
  }
  return false;
}

function climatologyDayCount(climatology: Entity): number {
  const start = parseDate(stringValue(climatology.baselinePeriodStart));
  const end = parseDate(stringValue(climatology.baselinePeriodEnd));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error('scenario.weather.climatology baseline period is missing or invalid');
  return hasLeapYear(start.getUTCFullYear(), end.getUTCFullYear()) ? 366 : 365;
}

function addDaysString(dateValue: string, days: number): string {
  const date = parseDate(dateValue);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function numericCsvValue(value: string, location: string, violations: string[]): number | null {
  if (isBlank(value)) {
    pushSample(violations, `${location} is blank`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    pushSample(violations, `${location} is not numeric: '${value}'`);
    return null;
  }
  return parsed;
}

function optionalNumericCsvValue(value: string): number | null {
  if (isBlank(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Words that must never appear in the payload. Disclosure is delivered by the
 * deck, the presenter guide and the repository documentation; inside the data it
 * simply leaks into grounded agent answers, which is what prompted this rule.
 */
const DISCLOSURE_MARKER = /synthetic|BRK390|LTG243|fictional|lab evidence|demo only|not a real forecast|simulated/i;

function syntheticLabelValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().includes('synthetic');
}

function csvColumn(row: CsvRow, camelCase: string, snakeCase?: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(row, camelCase)) return row[camelCase];
  if (snakeCase && Object.prototype.hasOwnProperty.call(row, snakeCase)) return row[snakeCase];
  return undefined;
}

function recordWeatherCsvDisclosureHeader(relativePath: string, header: string[], state: WeatherValidationState): void {
  // Disclosure now lives out of band, in the deck and the documentation, so the
  // payload must not carry labelling columns at all. A grounded agent quotes
  // whatever it reads, and an in-row "SYNTHETIC" label ends up in its answers.
  const normalized = new Set(header.map(normalizeKey));
  const banned = ['syntheticevidence', 'syntheticdisclaimer'].filter((column) => normalized.has(column));
  if (banned.length > 0) {
    state.csvFilesWithSyntheticLabelling.add(`${relativePath} (${banned.join(', ')})`);
  } else {
    state.csvFilesWithoutSyntheticLabelling.add(relativePath);
  }
}

function recordWeatherCsvDisclosureRow(relativePath: string, row: CsvRow, lineNumber: number, state: WeatherValidationState): void {
  const location = `${relativePath}:${lineNumber}`;
  const provenance = csvColumn(row, 'provenance');
  if (provenance !== undefined && provenance !== 'external') {
    pushSample(state.csvDisclosureViolations, `${location}.provenance=${provenance || 'blank'}, expected external`);
  }
  for (const [column, value] of [
    ['sourceLabel', csvColumn(row, 'sourceLabel', 'source_label')],
    ['baselineLabel', csvColumn(row, 'baselineLabel', 'baseline_label')],
  ] as const) {
    if (value !== undefined && DISCLOSURE_MARKER.test(value)) {
      pushSample(state.csvDisclosureViolations, `${location}.${column} still carries disclosure text: '${value.slice(0, 60)}'`);
    }
  }
}

function recordWeatherJsonDisclosure(relativePath: string, record: Entity, location: string, state: WeatherValidationState): void {
  if (isBlank(record.sourceLabel)) {
    pushSample(state.jsonDisclosureViolations, `${location}.sourceLabel is missing`);
  } else if (DISCLOSURE_MARKER.test(stringValue(record.sourceLabel))) {
    pushSample(state.jsonDisclosureViolations, `${location}.sourceLabel still carries disclosure text`);
  }
  for (const banned of ['syntheticEvidence', 'syntheticDisclaimer']) {
    if (Object.prototype.hasOwnProperty.call(record, banned)) {
      pushSample(state.jsonDisclosureViolations, `${location}.${banned} should no longer exist in the payload`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, 'provenance') && record.provenance !== 'external') {
    pushSample(state.jsonDisclosureViolations, `${location}.provenance=${stringValue(record.provenance) || 'blank'}, expected external`);
  }
}

function decimalPlaces(value: unknown): number {
  const [, fraction = ''] = stringValue(value).split('.');
  return fraction.length;
}

function uvAlertLevelFor(uvIndex: number, alertLevels: Entity[]): string | null {
  if (alertLevels.length === 0) return null;
  // Bands are contiguous and half-open: minUvIndex <= uvIndex < maxUvIndexExclusive.
  // Values outside the declared range clamp to the first or last band rather than
  // falling through, which is the bug this check exists to catch.
  const match = alertLevels.find(
    (level) =>
      uvIndex >= numericValue(level.minUvIndex) && uvIndex < numericValue(level.maxUvIndexExclusive),
  );
  if (match) return stringValue(match.level);
  const first = alertLevels[0];
  const last = alertLevels[alertLevels.length - 1];
  if (uvIndex < numericValue(first.minUvIndex)) return stringValue(first.level);
  if (uvIndex >= numericValue(last.maxUvIndexExclusive)) return stringValue(last.level);
  return null;
}

function recordWeatherPhysicalChecks(relativePath: string, row: CsvRow, lineNumber: number, scenario: Entity, state: WeatherValidationState): void {
  const location = `${relativePath}:${lineNumber}`;
  const numericColumns = [
    ['uvIndex', 0, Number.POSITIVE_INFINITY],
    ['uvIndex_p10', 0, Number.POSITIVE_INFINITY],
    ['uvIndex_p50', 0, Number.POSITIVE_INFINITY],
    ['uvIndex_p90', 0, Number.POSITIVE_INFINITY],
    ['humidityPct', 0, 100],
    ['cloudCoverPct', 0, 100],
    ['precipitationMm', 0, Number.POSITIVE_INFINITY],
    ['precipitationMm_p50', 0, Number.POSITIVE_INFINITY],
  ] as const;
  for (const [column, min, max] of numericColumns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    const value = numericCsvValue(row[column], `${location}.${column}`, state.physicalViolations);
    if (value === null) continue;
    if (value < min || value > max) pushSample(state.physicalViolations, `${location}.${column}=${value} outside ${min}..${max}`);
  }
  if (Object.prototype.hasOwnProperty.call(row, 'uvAlertLevel') && Object.prototype.hasOwnProperty.call(row, 'uvIndex')) {
    const uvIndex = optionalNumericCsvValue(row.uvIndex);
    const expectedLevel = uvIndex === null ? null : uvAlertLevelFor(uvIndex, asArray(scenario.weather?.uvAlertLevels));
    if (!expectedLevel || row.uvAlertLevel !== expectedLevel) {
      state.uvAlertViolationCount += 1;
      pushSample(state.physicalViolations, `${location}.uvAlertLevel=${row.uvAlertLevel}, expected ${expectedLevel ?? 'no matching level'} for uvIndex=${row.uvIndex}`);
    }
  }
  if (row.regionId === 'REG-CENTRAL' && (relativePath === 'eventhouse/WeatherObservationsDaily.csv' || relativePath === 'fabric-sql/weather_stations.csv')) {
    for (const column of ['seaSurfaceTemperatureC', 'seaSurfaceAnomalyC', 'baseSeaSurfaceTemperatureC']) {
      if (Object.prototype.hasOwnProperty.call(row, column) && !isBlank(row[column])) {
        pushSample(state.physicalViolations, `${location}.${column}=${row[column]}, expected blank for landlocked REG-CENTRAL`);
      }
    }
  }
}

function recordWeatherEvent(
  source: WeatherEventSource,
  event: Entity,
  location: string,
  knownRegionIds: Set<string>,
  unaffectedRegionIds: Set<string>,
  expectedSignalId: string,
): void {
  source.rows += 1;
  const eventId = stringValue(event.eventId);
  if (!eventId) {
    pushSample(source.duplicateIds, `${location}.eventId is blank`);
  } else if (source.ids.has(eventId)) {
    pushSample(source.duplicateIds, `${location}.eventId duplicate ${eventId}`);
  } else {
    source.ids.add(eventId);
  }
  const eventType = stringValue(event.eventType);
  if (eventType) source.eventTypes.add(eventType);
  const regionId = stringValue(event.regionId);
  if (!knownRegionIds.has(regionId)) pushSample(source.unknownRegionIds, `${location}.regionId '${regionId}' is not in scenario.regions`);
  if (unaffectedRegionIds.has(regionId)) source.unaffectedRegionIds.add(regionId);
  if (!boolValue(event.relevantToHeroProduct)) source.irrelevantEventTypes.add(eventType || '(blank)');
  if (eventType === 'enso_phase' && stringValue(event.signalId) !== expectedSignalId) {
    pushSample(source.ensoSignalViolations, `${location}.signalId=${stringValue(event.signalId) || 'blank'}, expected ${expectedSignalId}`);
  }
}

function collectWeatherCsvRow(
  relativePath: string,
  row: CsvRow,
  lineNumber: number,
  scenario: Entity,
  knownRegionIds: Set<string>,
  unaffectedRegionIds: Set<string>,
  state: WeatherValidationState,
): void {
  recordWeatherCsvDisclosureRow(relativePath, row, lineNumber, state);
  recordWeatherPhysicalChecks(relativePath, row, lineNumber, scenario, state);

  const location = `${relativePath}:${lineNumber}`;
  const weather = isPlainObject(scenario.weather) ? scenario.weather : {};
  const demandResponse = isPlainObject(weather.demandResponse) ? weather.demandResponse : {};
  const betaUv = numericValue(demandResponse.betaUv);
  const betaTempC = numericValue(demandResponse.betaTempC);
  const tolerancePct = numericValue(demandResponse.tolerancePct);
  const varianceWindowStart = stringValue(scenario.clock?.varianceWindowStart);
  const varianceWindowEnd = stringValue(scenario.clock?.varianceWindowEnd);
  const decisionDayIssue = stringValue(weather.forecast?.decisionDayIssue);
  const expectedSignalId = stringValue(scenario.externalSignal?.signalId);

  if (relativePath === 'fabric-sql/climate_normals.csv') {
    const dayOfYear = Number(row.dayOfYear);
    const temperatureMeanNormalC = numericCsvValue(row.temperatureMeanNormalC, `${location}.temperatureMeanNormalC`, state.physicalViolations);
    const uvIndexNormal = numericCsvValue(row.uvIndexNormal, `${location}.uvIndexNormal`, state.physicalViolations);
    if (Number.isInteger(dayOfYear) && temperatureMeanNormalC !== null && uvIndexNormal !== null) {
      state.normalsByRegionDayOfYear.set(weatherRegionDayOfYearKey(row.regionId, dayOfYear), {
        temperatureMeanNormalC,
        uvIndexNormal,
        location,
      });
    }
    return;
  }

  if (relativePath === 'eventhouse/ClimateSignalObservations.csv') {
    const dateKey = dateKeyFromTimestamp(row.timestamp);
    const uvIndex = numericCsvValue(row.uvIndex, `${location}.uvIndex`, state.physicalViolations);
    if (uvIndex !== null) state.climateSignalUvByRegionDate.set(weatherRegionDateKey(row.regionId, dateKey), { uvIndex, location });
    return;
  }

  if (relativePath === 'eventhouse/WeatherObservationsDaily.csv') {
    const dateKey = dateKeyFromTimestamp(row.timestamp);
    const temperatureMeanC = numericCsvValue(row.temperatureMeanC, `${location}.temperatureMeanC`, state.physicalViolations);
    const uvIndex = numericCsvValue(row.uvIndex, `${location}.uvIndex`, state.physicalViolations);
    const temperatureMeanAnomalyC = numericCsvValue(row.temperatureMeanAnomalyC, `${location}.temperatureMeanAnomalyC`, state.physicalViolations);
    const uvIndexAnomaly = numericCsvValue(row.uvIndexAnomaly, `${location}.uvIndexAnomaly`, state.physicalViolations);
    if (temperatureMeanC !== null && uvIndex !== null && temperatureMeanAnomalyC !== null && uvIndexAnomaly !== null) {
      state.dailyObservations.set(weatherRegionDateKey(row.regionId, dateKey), {
        temperatureMeanC,
        uvIndex,
        temperatureMeanAnomalyC,
        uvIndexAnomaly,
        location,
      });
      if (isBetweenDate(dateKey, varianceWindowStart, varianceWindowEnd)) {
        addNumberAggregate(state.dailyWindowUvAnomalies, row.regionId, uvIndexAnomaly);
        addNumberAggregate(state.dailyWindowTemperatureAnomalies, row.regionId, temperatureMeanAnomalyC);
      }
    }
    return;
  }

  if (relativePath === 'eventhouse/WeatherObservationsHourly.csv') {
    const dateKey = dateKeyFromTimestamp(row.timestamp);
    const key = weatherRegionDateKey(row.regionId, dateKey);
    const temperatureC = numericCsvValue(row.temperatureC, `${location}.temperatureC`, state.physicalViolations);
    const uvIndex = numericCsvValue(row.uvIndex, `${location}.uvIndex`, state.physicalViolations);
    if (temperatureC !== null && uvIndex !== null) {
      const aggregate = state.hourlyAggregates.get(key) ?? { temperatureSum: 0, uvMax: Number.NEGATIVE_INFINITY, count: 0 };
      aggregate.temperatureSum += temperatureC;
      aggregate.uvMax = Math.max(aggregate.uvMax, uvIndex);
      aggregate.count += 1;
      state.hourlyAggregates.set(key, aggregate);
      const hour = parseDate(row.timestamp).getUTCHours();
      if ((hour < 5 || hour > 20) && uvIndex !== 0) pushSample(state.hourlyNightUvViolations, `${location}.uvIndex=${uvIndex} at hour ${hour}, expected 0 at night`);
    }
    return;
  }

  if (relativePath === 'eventhouse/WeatherForecastDaily.csv') {
    const uvP10 = numericCsvValue(row.uvIndex_p10, `${location}.uvIndex_p10`, state.physicalViolations);
    const uvP50 = numericCsvValue(row.uvIndex_p50, `${location}.uvIndex_p50`, state.physicalViolations);
    const uvP90 = numericCsvValue(row.uvIndex_p90, `${location}.uvIndex_p90`, state.physicalViolations);
    const tempP10 = numericCsvValue(row.temperatureMeanC_p10, `${location}.temperatureMeanC_p10`, state.physicalViolations);
    const tempP50 = numericCsvValue(row.temperatureMeanC_p50, `${location}.temperatureMeanC_p50`, state.physicalViolations);
    const tempP90 = numericCsvValue(row.temperatureMeanC_p90, `${location}.temperatureMeanC_p90`, state.physicalViolations);
    if (uvP10 !== null && uvP50 !== null && uvP90 !== null && !(uvP10 <= uvP50 && uvP50 <= uvP90)) {
      state.forecastBandViolationCount += 1;
      pushSample(state.forecastBandViolations, `${location} UV p10/p50/p90=${uvP10}/${uvP50}/${uvP90}`);
    }
    if (tempP10 !== null && tempP50 !== null && tempP90 !== null && !(tempP10 <= tempP50 && tempP50 <= tempP90)) {
      state.forecastBandViolationCount += 1;
      pushSample(state.forecastBandViolations, `${location} temperature p10/p50/p90=${tempP10}/${tempP50}/${tempP90}`);
    }
    if (uvP50 !== null) {
      const observed = state.dailyObservations.get(weatherRegionDateKey(row.regionId, row.targetDate));
      if (observed) {
        const leadDays = numericValue(row.leadDays);
        const error = Math.abs(uvP50 - observed.uvIndex);
        addNumberAggregate(state.forecastSkillByLeadDay, leadDays, error);
        const targetKey = weatherRegionDateKey(row.regionId, row.targetDate);
        const targetErrors = state.forecastSkillByRegionTarget.get(targetKey) ?? new Map<number, number>();
        targetErrors.set(leadDays, error);
        state.forecastSkillByRegionTarget.set(targetKey, targetErrors);
      }
    }
    if (row.issueDate === decisionDayIssue) {
      const leadDays = Number(row.leadDays);
      const regionState = state.decisionForecastByRegion.get(row.regionId) ?? { leads: new Set<number>(), positiveViolations: [], nearZeroViolations: [] };
      if (Number.isInteger(leadDays)) regionState.leads.add(leadDays);
      const uvAnomalyP50 = numericCsvValue(row.uvIndexAnomaly_p50, `${location}.uvIndexAnomaly_p50`, state.physicalViolations);
      if (uvAnomalyP50 !== null) {
        if (Array.isArray(scenario.externalSignal?.affectedRegionIds) && scenario.externalSignal.affectedRegionIds.includes(row.regionId) && uvAnomalyP50 <= 0) {
          pushSample(regionState.positiveViolations, `${row.regionId} lead ${row.leadDays} uvIndexAnomaly_p50=${uvAnomalyP50}`);
        }
        const nearZeroThreshold = 0.5;
        if (unaffectedRegionIds.has(row.regionId) && Math.abs(uvAnomalyP50) >= nearZeroThreshold) {
          pushSample(regionState.nearZeroViolations, `${row.regionId} lead ${row.leadDays} uvIndexAnomaly_p50=${uvAnomalyP50}, expected |value| < ${nearZeroThreshold}`);
        }
      }
      state.decisionForecastByRegion.set(row.regionId, regionState);
      if (row.targetDate > state.decisionForecastMaxTargetDate) state.decisionForecastMaxTargetDate = row.targetDate;
    }
    return;
  }

  if (relativePath === 'fabric-sql/weather_demand_response.csv') {
    const uvIndexAnomaly = numericCsvValue(row.uvIndexAnomaly, `${location}.uvIndexAnomaly`, state.physicalViolations);
    const temperatureMeanAnomalyC = numericCsvValue(row.temperatureMeanAnomalyC, `${location}.temperatureMeanAnomalyC`, state.physicalViolations);
    const modelledUpliftPct = numericCsvValue(row.modelledUpliftPct, `${location}.modelledUpliftPct`, state.physicalViolations);
    if (!approxEqual(numericValue(row.betaUv), betaUv, 0.000001)) {
      pushSample(state.demandResponseModelViolations, `${location}.betaUv=${row.betaUv}, expected ${betaUv}`);
    }
    if (!approxEqual(numericValue(row.betaTempC), betaTempC, 0.000001)) {
      pushSample(state.demandResponseModelViolations, `${location}.betaTempC=${row.betaTempC}, expected ${betaTempC}`);
    }
    if (stringValue(row.modelId) !== stringValue(demandResponse.modelId)) {
      pushSample(state.demandResponseModelViolations, `${location}.modelId=${row.modelId}, expected ${demandResponse.modelId}`);
    }
    if (uvIndexAnomaly !== null && temperatureMeanAnomalyC !== null && modelledUpliftPct !== null) {
      const expected = betaUv * uvIndexAnomaly + betaTempC * temperatureMeanAnomalyC;
      if (!approxEqual(modelledUpliftPct, expected, 0.0001)) {
        pushSample(state.demandResponseFormulaViolations, `${location}.modelledUpliftPct=${modelledUpliftPct}, expected ${round(expected, 4)}`);
      }
      if (isBetweenDate(row.observationDate, varianceWindowStart, varianceWindowEnd)) {
        addNumberAggregate(state.demandResponseWindowUplift, row.regionId, modelledUpliftPct);
      }
    }
    return;
  }

  if (relativePath === 'lakehouse/dashboard/weather-demand-reconciliation.csv') {
    state.demandReconciliationRegions.add(row.region_id);
    const modelled = numericCsvValue(row.modelled_weather_uplift_pct, `${location}.modelled_weather_uplift_pct`, state.physicalViolations);
    const actual = numericCsvValue(row.actual_sales_variance_pct, `${location}.actual_sales_variance_pct`, state.physicalViolations);
    const difference = numericCsvValue(row.difference_pct, `${location}.difference_pct`, state.physicalViolations);
    const zeroTolerance = tolerancePct / Math.max(1, knownRegionIds.size);
    if (modelled !== null && actual !== null && !approxEqual(modelled, actual, zeroTolerance)) {
      pushSample(state.demandReconciliationViolations, `${location}: modelled ${modelled}% != actual ${actual}%`);
    }
    if (difference !== null && !approxEqual(difference, 0, zeroTolerance)) {
      pushSample(state.demandReconciliationViolations, `${location}: difference_pct=${difference}, expected 0`);
    }
    return;
  }

  if (relativePath === 'eventhouse/WeatherEvents.csv' || relativePath === 'fabric-sql/weather_events.csv') {
    const source = state.eventSources[relativePath];
    if (source) recordWeatherEvent(source, row, location, knownRegionIds, unaffectedRegionIds, expectedSignalId);
  }
}

function collectWeatherJsonlRecord(
  relativePath: string,
  record: unknown,
  lineNumber: number,
  scenario: Entity,
  knownRegionIds: Set<string>,
  unaffectedRegionIds: Set<string>,
  state: WeatherValidationState,
): void {
  if (!isPlainObject(record)) return;
  const location = `${relativePath}:${lineNumber}`;
  recordWeatherJsonDisclosure(relativePath, record, location, state);
  if (relativePath === 'lakehouse/external-signals/weather-events.jsonl') {
    recordWeatherEvent(
      state.eventSources[relativePath],
      record,
      location,
      knownRegionIds,
      unaffectedRegionIds,
      stringValue(scenario.externalSignal?.signalId),
    );
  } else if (relativePath === 'lakehouse/external-signals/forecast-briefings.jsonl' && record.issueDate === scenario.weather?.forecast?.decisionDayIssue) {
    state.decisionBriefing = { record, location };
  }
}

function compareStringArrays(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function parseKqlTableDefinitions(text: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const tablePattern = /\.create-merge\s+table\s+(\w+)\s*\(([^)]*)\)/g;
  for (const match of text.matchAll(tablePattern)) {
    const columns = match[2]
      .split(',')
      .map((part) => part.trim().split(':')[0]?.trim() ?? '')
      .filter(Boolean);
    tables.set(match[1], columns);
  }
  return tables;
}

function parseKqlCsvMappings(text: string): Map<string, { columns: string[]; failures: string[] }> {
  const mappings = new Map<string, { columns: string[]; failures: string[] }>();
  const mappingPattern = /\.create-or-alter\s+table\s+(\w+)\s+ingestion\s+csv\s+mapping\s+'[^']+'\s+'([^']+)'/g;
  for (const match of text.matchAll(mappingPattern)) {
    const tableName = match[1];
    const failures: string[] = [];
    const columnsByOrdinal = new Map<number, string>();
    try {
      const parsed = JSON.parse(match[2]);
      if (!Array.isArray(parsed)) {
        failures.push(`${tableName} mapping JSON is not an array`);
      } else {
        for (const [index, entry] of parsed.entries()) {
          const column = stringValue(entry?.column);
          const ordinal = Number(entry?.Properties?.Ordinal);
          if (!column) failures.push(`${tableName} mapping entry ${index} has blank column`);
          if (!Number.isInteger(ordinal) || ordinal < 0) {
            failures.push(`${tableName}.${column || `entry${index}`} has invalid ordinal '${entry?.Properties?.Ordinal}'`);
            continue;
          }
          if (columnsByOrdinal.has(ordinal)) failures.push(`${tableName} has duplicate ordinal ${ordinal}`);
          columnsByOrdinal.set(ordinal, column);
        }
      }
    } catch (error) {
      failures.push(`${tableName} mapping JSON is invalid: ${errorMessage(error)}`);
    }
    const columns: string[] = [];
    for (let ordinal = 0; ordinal < columnsByOrdinal.size; ordinal += 1) {
      const column = columnsByOrdinal.get(ordinal);
      if (!column) failures.push(`${tableName} mapping is missing ordinal ${ordinal}`);
      else columns.push(column);
    }
    mappings.set(tableName, { columns, failures });
  }
  return mappings;
}

async function readRequiredTextFile(group: string, name: string, relativePath: string): Promise<string | null> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) {
    fail(group, name, `Missing file (checked ${relativePath})`);
    return null;
  }
  try {
    const text = await readFile(found.absolutePath, 'utf8');
    if (text.trim() === '') {
      fail(group, name, 'file is empty');
      return null;
    }
    pass(group, name, 'readable');
    return text;
  } catch (error) {
    fail(group, name, errorMessage(error));
    return null;
  }
}

const ONTOLOGY_ROOT = '../src/fabric/CaldovaLaunch.Ontology';
const SEMANTIC_MODEL_ROOT = '../src/fabric/CaldovaLaunch.SemanticModel';
// model.bim is the authored source and lives outside the item folder, because
// Fabric rejects an item containing both TMSL (model.bim) and TMDL definitions.
const SEMANTIC_MODEL_SOURCE = '../src/fabric/semantic-model-source';
const DATA_AGENT_ROOT = '../src/fabric/CaldovaLaunch.DataAgent';
const DAX_KEYWORDS = new Set([
  'ALL',
  'AND',
  'AVERAGE',
  'CALCULATE',
  'DATE',
  'DISTINCTCOUNT',
  'DIVIDE',
  'FALSE',
  'FILTER',
  'IF',
  'KEEPFILTERS',
  'MAX',
  'MIN',
  'NOT',
  'OR',
  'ROUND',
  'SUM',
  'SUMX',
  'TRUE',
  'VALUES',
  'VAR',
  'RETURN',
]);

type JsonFileState = { value: unknown; error: string | null; exists: boolean };
type OntologyTypeDefinition = Entity & { directoryName: string; relativePath: string };
type OntologyState = {
  platform: JsonFileState;
  definition: JsonFileState;
  bindings: JsonFileState;
  entityTypes: OntologyTypeDefinition[];
  relationshipTypes: OntologyTypeDefinition[];
  entityDirectoryError: string | null;
  relationshipDirectoryError: string | null;
  entityDefinitionErrors: string[];
  relationshipDefinitionErrors: string[];
};
type GeneratedTable = { tableName: string; relativePath: string; header: string[]; headerSet: Set<string>; error: string | null };
type GeneratedTables = { tables: Map<string, GeneratedTable>; errors: string[] };
type OntologyEdge = { from: string; to: string; name: string; id: string };
type BindingReference = {
  table: string;
  location: string;
  columns: { physicalColumn: string; location: string }[];
  columnFailures: string[];
};
type SemanticModelState = {
  platform: JsonFileState;
  modelBim: JsonFileState;
};

async function loadJsonFileState(relativePath: string, required = true): Promise<JsonFileState> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) {
    return {
      value: undefined,
      error: required ? `Missing file (checked ${relativePath})` : null,
      exists: false,
    };
  }
  try {
    return { value: JSON.parse(await readFile(found.absolutePath, 'utf8')), error: null, exists: true };
  } catch (error) {
    return { value: undefined, error: errorMessage(error), exists: true };
  }
}

async function readDirectoryNames(relativePath: string): Promise<{ entries: string[]; error: string | null }> {
  try {
    const entries = await readdir(join(DATA_ROOT, relativePath), { withFileTypes: true });
    return {
      entries: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b)),
      error: null,
    };
  } catch (error) {
    return { entries: [], error: errorMessage(error) };
  }
}

async function loadOntologyDefinitions(kind: 'EntityTypes' | 'RelationshipTypes'): Promise<{
  definitions: OntologyTypeDefinition[];
  directoryError: string | null;
  definitionErrors: string[];
}> {
  const directory = await readDirectoryNames(`${ONTOLOGY_ROOT}/${kind}`);
  const definitions: OntologyTypeDefinition[] = [];
  const definitionErrors: string[] = [];
  for (const directoryName of directory.entries) {
    const relativePath = `${ONTOLOGY_ROOT}/${kind}/${directoryName}/definition.json`;
    const parsed = await loadJsonFileState(relativePath);
    if (parsed.error) {
      definitionErrors.push(`${relativePath}: ${parsed.error}`);
      continue;
    }
    if (!isPlainObject(parsed.value)) {
      definitionErrors.push(`${relativePath}: definition is not a JSON object`);
      continue;
    }
    definitions.push({ ...parsed.value, directoryName, relativePath });
  }
  return { definitions, directoryError: directory.error, definitionErrors };
}

async function loadOntologyState(): Promise<OntologyState> {
  const [platform, definition, bindings, entities, relationships] = await Promise.all([
    loadJsonFileState(`${ONTOLOGY_ROOT}/.platform`),
    loadJsonFileState(`${ONTOLOGY_ROOT}/definition.json`),
    loadJsonFileState(`${ONTOLOGY_ROOT}/bindings.json`, false),
    loadOntologyDefinitions('EntityTypes'),
    loadOntologyDefinitions('RelationshipTypes'),
  ]);
  return {
    platform,
    definition,
    bindings,
    entityTypes: entities.definitions,
    relationshipTypes: relationships.definitions,
    entityDirectoryError: entities.directoryError,
    relationshipDirectoryError: relationships.directoryError,
    entityDefinitionErrors: entities.definitionErrors,
    relationshipDefinitionErrors: relationships.definitionErrors,
  };
}

async function loadSemanticModelState(): Promise<SemanticModelState> {
  const [platform, modelBim] = await Promise.all([
    loadJsonFileState(`${SEMANTIC_MODEL_ROOT}/.platform`),
    loadJsonFileState(`${SEMANTIC_MODEL_SOURCE}/model.bim`),
  ]);
  return { platform, modelBim };
}

async function readCsvHeaderOnly(relativePath: string): Promise<{ header: string[]; error: string | null }> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) return { header: [], error: `Missing file (checked ${relativePath} or ${relativePath}.gz)` };
  try {
    const reader = createInterface({ input: createTransparentReadStream(found.absolutePath), crlfDelay: Infinity });
    for await (const rawLine of reader) {
      const parsed = parseCsvLine(rawLine.replace(/^\uFEFF/, ''));
      reader.close();
      if (!parsed.ok) return { header: [], error: `line 1: ${parsed.error}` };
      if (parsed.values.length === 0 || parsed.values.every((column) => column.trim() === '')) {
        return { header: [], error: 'line 1: missing header' };
      }
      return { header: parsed.values, error: null };
    }
    return { header: [], error: 'empty file' };
  } catch (error) {
    return { header: [], error: errorMessage(error) };
  }
}

async function collectGeneratedTables(): Promise<GeneratedTables> {
  const tables = new Map<string, GeneratedTable>();
  const errors: string[] = [];
  for (const directory of ['fabric-sql', 'eventhouse']) {
    let entries: string[];
    try {
      entries = await readdir(join(DATA_ROOT, directory));
    } catch (error) {
      errors.push(`${directory}: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      if (!entry.endsWith('.csv') && !entry.endsWith('.csv.gz')) continue;
      const tableName = entry.replace(/\.csv(?:\.gz)?$/, '');
      const relativePath = `${directory}/${tableName}.csv`;
      const headerResult = await readCsvHeaderOnly(relativePath);
      if (tables.has(tableName)) errors.push(`duplicate generated table name '${tableName}'`);
      tables.set(tableName, {
        tableName,
        relativePath,
        header: headerResult.header,
        headerSet: new Set(headerResult.header),
        error: headerResult.error,
      });
    }
  }
  // The Lakehouse also carries dashboard and evidence projections. Deployment names
  // dashboard tables with a 'dash_' prefix to avoid colliding with the fabric-sql
  // table of the same name, and both directories convert hyphens to underscores.
  for (const [directory, prefix] of [
    ['lakehouse/dashboard', 'dash_'],
    ['lakehouse/evidence', ''],
  ] as const) {
    let entries: string[];
    try {
      entries = await readdir(join(DATA_ROOT, directory));
    } catch (error) {
      errors.push(`${directory}: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      if (!entry.endsWith('.csv') && !entry.endsWith('.csv.gz')) continue;
      const fileStem = entry.replace(/\.csv(?:\.gz)?$/, '');
      const tableName = `${prefix}${fileStem.replace(/-/g, '_')}`;
      const relativePath = `${directory}/${fileStem}.csv`;
      const headerResult = await readCsvHeaderOnly(relativePath);
      if (tables.has(tableName)) errors.push(`duplicate generated table name '${tableName}'`);
      tables.set(tableName, {
        tableName,
        relativePath,
        header: headerResult.header,
        headerSet: new Set(headerResult.header),
        error: headerResult.error,
      });
    }
  }
  return { tables, errors };
}

async function listDecisionMemoryCsvFiles(): Promise<string[]> {
  try {
    const entries = await readdir(join(DATA_ROOT, 'fabric-sql'));
    return entries
      .filter((entry) => /^decision_.*\.csv(?:\.gz)?$/.test(entry))
      .map((entry) => `fabric-sql/${entry.replace(/\.gz$/, '')}`)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function requiredJsonObject(state: JsonFileState, label: string): Entity {
  if (state.error) throw new Error(state.error);
  if (!isPlainObject(state.value)) throw new Error(`${label} is not a JSON object`);
  return state.value;
}

function ontologyEntityNameById(state: OntologyState): Map<string, string> {
  const names = new Map<string, string>();
  for (const entityType of state.entityTypes) {
    const id = stringValue(entityType.id);
    const name = stringValue(entityType.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

function ontologyGraph(state: OntologyState): Map<string, OntologyEdge[]> {
  const namesById = ontologyEntityNameById(state);
  const graph = new Map<string, OntologyEdge[]>();
  for (const relationship of state.relationshipTypes) {
    const from = namesById.get(stringValue(relationship.source?.entityTypeId));
    const to = namesById.get(stringValue(relationship.target?.entityTypeId));
    if (!from || !to) continue;
    const edges = graph.get(from) ?? [];
    edges.push({ from, to, name: stringValue(relationship.name), id: stringValue(relationship.id) });
    graph.set(from, edges);
  }
  return graph;
}

function traverseOntologyChain(state: OntologyState, chain: string[]): string {
  const entityNames = new Set(state.entityTypes.map((entityType) => stringValue(entityType.name)).filter(Boolean));
  for (const name of chain) {
    if (!entityNames.has(name)) throw new Error(`missing entity type ${name}`);
  }
  const graph = ontologyGraph(state);
  const segments: string[] = [chain[0]];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const from = chain[index];
    const to = chain[index + 1];
    const edge = (graph.get(from) ?? []).find((candidate) => candidate.to === to);
    if (!edge) throw new Error(`missing hop ${from} -> ${to}`);
    segments.push(`--${edge.name || edge.id}-->`, to);
  }
  return segments.join(' ');
}

function collectOntologyIds(state: OntologyState): { duplicates: string[]; blanks: string[] } {
  const locationsById = new Map<string, string[]>();
  const blanks: string[] = [];
  const record = (id: unknown, location: string) => {
    const value = stringValue(id);
    if (!value) {
      pushSample(blanks, `${location} has blank id`);
      return;
    }
    const locations = locationsById.get(value) ?? [];
    locations.push(location);
    locationsById.set(value, locations);
  };
  for (const entityType of state.entityTypes) {
    record(entityType.id, entityType.relativePath);
    for (const property of asArray(entityType.properties)) record(property.id, `${entityType.relativePath}.properties.${stringValue(property.name) || '(blank)'}`);
    for (const property of asArray(entityType.timeseriesProperties)) {
      record(property.id, `${entityType.relativePath}.timeseriesProperties.${stringValue(property.name) || '(blank)'}`);
    }
  }
  for (const relationship of state.relationshipTypes) record(relationship.id, relationship.relativePath);
  const duplicates = [...locationsById.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([id, locations]) => `${id} at ${locations.join(', ')}`);
  return { duplicates, blanks };
}

function collectBindingReferences(bindings: unknown): BindingReference[] {
  const references: BindingReference[] = [];
  const visit = (value: unknown, pathParts: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...pathParts, `[${index}]`]));
      return;
    }
    if (!isPlainObject(value)) return;
    if (typeof value.table === 'string') {
      const table = value.table;
      const columnFailures: string[] = [];
      const columns: { physicalColumn: string; location: string }[] = [];
      const columnsPath = [...pathParts, 'columns'].join('.');
      if (Object.prototype.hasOwnProperty.call(value, 'columns')) {
        if (isPlainObject(value.columns)) {
          for (const [logicalColumn, physicalColumn] of Object.entries(value.columns)) {
            const resolvedPhysicalColumn = stringValue(physicalColumn);
            if (!resolvedPhysicalColumn) columnFailures.push(`${columnsPath}.${logicalColumn} maps to a blank physical column`);
            else columns.push({ physicalColumn: resolvedPhysicalColumn, location: `${columnsPath}.${logicalColumn}` });
          }
        } else if (Array.isArray(value.columns)) {
          for (const [index, physicalColumn] of value.columns.entries()) {
            const resolvedPhysicalColumn = isPlainObject(physicalColumn) ? stringValue(physicalColumn.column ?? physicalColumn.sourceColumn) : stringValue(physicalColumn);
            if (!resolvedPhysicalColumn) columnFailures.push(`${columnsPath}[${index}] maps to a blank physical column`);
            else columns.push({ physicalColumn: resolvedPhysicalColumn, location: `${columnsPath}[${index}]` });
          }
        } else {
          columnFailures.push(`${columnsPath} is not an object or array`);
        }
      }
      if (!isBlank(value.timestampColumn)) {
        columns.push({ physicalColumn: stringValue(value.timestampColumn), location: [...pathParts, 'timestampColumn'].join('.') });
      }
      references.push({ table, location: [...pathParts, 'table'].join('.'), columns, columnFailures });
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key]);
  };
  visit(bindings, ['bindings.json']);
  return references;
}

function semanticModelObject(state: SemanticModelState): Entity {
  const modelBim = requiredJsonObject(state.modelBim, 'model.bim');
  if (!isPlainObject(modelBim.model)) throw new Error('model.bim.model is not a JSON object');
  return modelBim.model;
}

function semanticTables(model: Entity): Entity[] {
  return asArray(model.tables);
}

function directLakeEntityNames(table: Entity): string[] {
  return asArray(table.partitions)
    .filter((partition) => stringValue(partition.mode) === 'directLake')
    .map((partition) => stringValue(partition.source?.entityName))
    .filter(Boolean);
}

function semanticTableSourcesByName(tables: Entity[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const table of tables) {
    const [entityName] = directLakeEntityNames(table);
    if (entityName) sources.set(stringValue(table.name), entityName);
  }
  return sources;
}

function semanticColumnsByName(table: Entity): Map<string, Entity> {
  return new Map(asArray(table.columns).map((column) => [stringValue(column.name), column]));
}

function measureExpressionText(expression: unknown): string {
  if (Array.isArray(expression)) return expression.map(stringValue).join('\n');
  return stringValue(expression);
}

function extractDaxColumnReferences(expression: string): { table: string; column: string }[] {
  const references: { table: string; column: string }[] = [];
  const quotedSpans: [number, number][] = [];
  const quotedPattern = /'((?:[^']|'')+)'\s*\[([^\]]+)\]/g;
  for (const match of expression.matchAll(quotedPattern)) {
    quotedSpans.push([match.index, match.index + match[0].length]);
    references.push({ table: match[1].replace(/''/g, "'"), column: match[2] });
  }
  const unquotedPattern = /(^|[^A-Za-z0-9_'])\b([A-Za-z_][A-Za-z0-9_]*)\s*\[([^\]]+)\]/g;
  for (const match of expression.matchAll(unquotedPattern)) {
    const start = match.index + match[1].length;
    if (quotedSpans.some(([spanStart, spanEnd]) => start >= spanStart && start < spanEnd)) continue;
    references.push({ table: match[2], column: match[3] });
  }
  return references;
}

function runOntologyChecks(state: OntologyState, generatedTables: GeneratedTables): void {
  runCheck('Ontology', '.platform declares Ontology', () => {
    const platform = requiredJsonObject(state.platform, `${ONTOLOGY_ROOT}/.platform`);
    if (platform.metadata?.type !== 'Ontology') throw new Error(`metadata.type=${stringValue(platform.metadata?.type) || 'blank'}, expected Ontology`);
    return 'metadata.type=Ontology';
  });

  runCheck('Ontology', 'property valueTypes are supported by the Fabric API', () => {
    // The Fabric Ontology API accepts only these types. It has NO integer type:
    // Int64/Integer/Int/Long/Int32/Number/Decimal are all rejected, and a single
    // unsupported value fails the entire artifact with a generic
    // ALMOperationBadRequest that names neither the file nor the property.
    const supported = new Set(['String', 'Boolean', 'Double', 'DateTime', 'Float']);
    const offenders: string[] = [];
    for (const entityType of state.entityTypes) {
      const definition = entityType as unknown as Entity;
      const all = [
        ...asArray(definition.properties),
        ...asArray(definition.timeseriesProperties),
      ];
      for (const property of all) {
        const valueType = stringValue((property as Entity).valueType);
        if (!supported.has(valueType)) {
          offenders.push(`${stringValue(definition.name)}.${stringValue((property as Entity).name)} = ${valueType}`);
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(`unsupported valueType(s): ${offenders.slice(0, 8).join('; ')}`);
    }
  });

  runCheck('Ontology', 'definition.json exists and parses', () => {
    requiredJsonObject(state.definition, `${ONTOLOGY_ROOT}/definition.json`);
    return 'valid JSON';
  });

  runCheck('Ontology', 'type definition files parse and match directory ids', () => {
    const failures = [...state.entityDefinitionErrors, ...state.relationshipDefinitionErrors];
    if (state.entityDirectoryError) failures.push(`EntityTypes: ${state.entityDirectoryError}`);
    if (state.relationshipDirectoryError) failures.push(`RelationshipTypes: ${state.relationshipDirectoryError}`);
    if (!state.entityDirectoryError && state.entityTypes.length === 0) failures.push('EntityTypes has no type directories');
    if (!state.relationshipDirectoryError && state.relationshipTypes.length === 0) failures.push('RelationshipTypes has no type directories');
    for (const entityType of state.entityTypes) {
      if (stringValue(entityType.id) !== entityType.directoryName) {
        failures.push(`${entityType.relativePath}: directory ${entityType.directoryName} != id ${stringValue(entityType.id) || 'blank'}`);
      }
    }
    for (const relationshipType of state.relationshipTypes) {
      if (stringValue(relationshipType.id) !== relationshipType.directoryName) {
        failures.push(`${relationshipType.relativePath}: directory ${relationshipType.directoryName} != id ${stringValue(relationshipType.id) || 'blank'}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.entityTypes.length} entity types and ${state.relationshipTypes.length} relationship types`;
  });

  runCheck('Ontology', 'ids are globally unique', () => {
    const { duplicates, blanks } = collectOntologyIds(state);
    const failures = [...blanks, ...duplicates];
    if (failures.length > 0) throw new Error(sample(failures));
    return 'entity, property, time-series property, and relationship ids are unique';
  });

  runCheck('Ontology', 'entity identity and display properties resolve', () => {
    const failures: string[] = [];
    for (const entityType of state.entityTypes) {
      if (!Array.isArray(entityType.properties)) {
        failures.push(`${entityType.name || entityType.directoryName}: properties is not an array`);
        continue;
      }
      const propertyIds = new Set(entityType.properties.map((property: Entity) => stringValue(property.id)).filter(Boolean));
      for (const entityIdPart of Array.isArray(entityType.entityIdParts) ? entityType.entityIdParts : []) {
        if (!propertyIds.has(stringValue(entityIdPart))) {
          failures.push(`${entityType.name || entityType.directoryName}: entityIdParts references missing property id ${stringValue(entityIdPart) || 'blank'}`);
        }
      }
      if (!propertyIds.has(stringValue(entityType.displayNamePropertyId))) {
        failures.push(`${entityType.name || entityType.directoryName}: displayNamePropertyId ${stringValue(entityType.displayNamePropertyId) || 'blank'} is not a property id`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.entityTypes.length} entity identity definitions checked`;
  });

  runCheck('Ontology', 'relationship endpoints resolve to entity types', () => {
    const entityIds = new Set(state.entityTypes.map((entityType) => stringValue(entityType.id)).filter(Boolean));
    const failures: string[] = [];
    for (const relationshipType of state.relationshipTypes) {
      const sourceId = stringValue(relationshipType.source?.entityTypeId);
      const targetId = stringValue(relationshipType.target?.entityTypeId);
      if (!entityIds.has(sourceId)) failures.push(`${relationshipType.name || relationshipType.directoryName}: source.entityTypeId ${sourceId || 'blank'} is missing`);
      if (!entityIds.has(targetId)) failures.push(`${relationshipType.name || relationshipType.directoryName}: target.entityTypeId ${targetId || 'blank'} is missing`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.relationshipTypes.length} relationship endpoints checked`;
  });

  runCheck('Ontology', 'Act 1 evidence chain is traversable', () => {
    return traverseOntologyChain(state, ['ExternalSignal', 'Region', 'Product', 'Campaign', 'DemandForecast', 'ForecastAssumption']);
  });

  runCheck('Ontology', 'Act 3 impact chain is traversable', () => {
    return traverseOntologyChain(state, ['MaintenanceWindow', 'ProductionLine', 'ProductionOrder', 'CampaignCommitment']);
  });

  runCheck('Ontology', 'DecisionCase directly connects to correction, action and outcome', () => {
    const targets = new Set((ontologyGraph(state).get('DecisionCase') ?? []).map((edge) => edge.to));
    const missing = ['Correction', 'Action', 'Outcome'].filter((target) => !targets.has(target));
    if (missing.length > 0) throw new Error(`DecisionCase missing direct relationship(s) to ${missing.join(', ')}`);
    return 'DecisionCase -> Correction, Action, Outcome';
  });

  runCheck('Ontology', 'retired shipment concepts are absent', () => {
    const failures: string[] = [];
    for (const entityType of state.entityTypes) {
      if (stringValue(entityType.name) === 'Shipment') failures.push(`${entityType.relativePath}: entity type Shipment is retired`);
      for (const property of [...asArray(entityType.properties), ...asArray(entityType.timeseriesProperties)]) {
        const propertyName = stringValue(property.name);
        const normalized = propertyName.toLowerCase();
        if (normalized.includes('carrierthreshold') || normalized.includes('shipment')) {
          failures.push(`${entityType.name}.${propertyName} contains retired concept`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return 'no Shipment entity or retired shipment/carrierThreshold properties';
  });

  runCheck('Ontology', 'time series are modelled as properties, not entities', () => {
    const retiredEntityNames = new Set(['WeatherObservation', 'SensorReading']);
    const failures = state.entityTypes
      .filter((entityType) => retiredEntityNames.has(stringValue(entityType.name)))
      .map((entityType) => `${entityType.relativePath}: ${entityType.name} must be a time-series property, not an entity`);
    const entitiesWithTimeSeries = state.entityTypes.filter((entityType) => asArray(entityType.timeseriesProperties).length > 0);
    if (entitiesWithTimeSeries.length === 0) failures.push('no entity type declares timeseriesProperties');
    if (failures.length > 0) throw new Error(sample(failures));
    return `${entitiesWithTimeSeries.length} entity type(s) carry timeseriesProperties`;
  });

  runCheck('Ontology', 'bindings reference generated tables', () => {
    if (!state.bindings.exists) return 'bindings.json not present; skipped';
    const bindings = requiredJsonObject(state.bindings, `${ONTOLOGY_ROOT}/bindings.json`);
    const failures = [...generatedTables.errors];
    const references = collectBindingReferences(bindings);
    for (const reference of references) {
      if (!generatedTables.tables.has(reference.table)) failures.push(`${reference.location} references missing generated table '${reference.table}'`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${references.length} binding table references resolve`;
  });

  runCheck('Ontology', 'binding column mappings exist in CSV headers', () => {
    if (!state.bindings.exists) return 'bindings.json not present; skipped';
    const bindings = requiredJsonObject(state.bindings, `${ONTOLOGY_ROOT}/bindings.json`);
    const failures: string[] = [];
    let checked = 0;
    for (const reference of collectBindingReferences(bindings)) {
      failures.push(...reference.columnFailures);
      const table = generatedTables.tables.get(reference.table);
      if (!table || table.error) {
        if (table?.error) failures.push(`${reference.table}: CSV header unavailable (${table.error})`);
        continue;
      }
      for (const column of reference.columns) {
        checked += 1;
        if (!table.headerSet.has(column.physicalColumn)) {
          failures.push(`${column.location} maps to missing ${reference.table}.${column.physicalColumn}`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked} physical column mappings resolve`;
  });
}

function runSemanticModelChecks(state: SemanticModelState, generatedTables: GeneratedTables): void {
  runCheck('Semantic model', '.platform declares SemanticModel', () => {
    const platform = requiredJsonObject(state.platform, `${SEMANTIC_MODEL_ROOT}/.platform`);
    if (platform.metadata?.type !== 'SemanticModel') {
      throw new Error(`metadata.type=${stringValue(platform.metadata?.type) || 'blank'}, expected SemanticModel`);
    }
    return 'metadata.type=SemanticModel';
  });

  runCheck('Semantic model', 'model.bim parses as JSON', () => {
    const model = semanticModelObject(state);
    return `${semanticTables(model).length} model tables`;
  });

  runCheck('Semantic model', 'Direct Lake partitions reference generated tables', () => {
    const failures = [...generatedTables.errors];
    const tables = semanticTables(semanticModelObject(state));
    let checked = 0;
    for (const table of tables) {
      const entityNames = directLakeEntityNames(table);
      if (entityNames.length === 0) {
        failures.push(`${stringValue(table.name) || '(blank table)'} has no Direct Lake partition source.entityName`);
        continue;
      }
      for (const entityName of entityNames) {
        checked += 1;
        if (!generatedTables.tables.has(entityName)) failures.push(`${stringValue(table.name)} partition source.entityName '${entityName}' has no generated CSV`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked} Direct Lake partition sources resolve`;
  });

  runCheck('Semantic model', 'relationship columns exist in CSV headers', () => {
    const model = semanticModelObject(state);
    const tables = semanticTables(model);
    const tablesByName = new Map(tables.map((table) => [stringValue(table.name), table]));
    const sourcesByTable = semanticTableSourcesByName(tables);
    const failures: string[] = [];
    let checked = 0;
    for (const relationship of asArray(model.relationships)) {
      for (const side of [
        ['from', relationship.fromTable, relationship.fromColumn],
        ['to', relationship.toTable, relationship.toColumn],
      ] as const) {
        const [, tableNameRaw, columnNameRaw] = side;
        const tableName = stringValue(tableNameRaw);
        const columnName = stringValue(columnNameRaw);
        const table = tablesByName.get(tableName);
        if (!table) {
          failures.push(`${relationship.name || '(unnamed relationship)'}.${side[0]}Table '${tableName || 'blank'}' is not a model table`);
          continue;
        }
        const sourceEntityName = sourcesByTable.get(tableName);
        const generatedTable = sourceEntityName ? generatedTables.tables.get(sourceEntityName) : undefined;
        if (!sourceEntityName || !generatedTable || generatedTable.error) {
          failures.push(`${relationship.name || '(unnamed relationship)'}.${side[0]}Table '${tableName}' has no readable generated CSV header`);
          continue;
        }
        const modelColumn = semanticColumnsByName(table).get(columnName);
        if (!modelColumn) {
          failures.push(`${relationship.name || '(unnamed relationship)'}.${side[0]}Column '${columnName || 'blank'}' is not a model column on ${tableName}`);
          continue;
        }
        const physicalColumn = stringValue(modelColumn.sourceColumn) || columnName;
        checked += 1;
        if (!generatedTable.headerSet.has(physicalColumn)) {
          failures.push(`${relationship.name || '(unnamed relationship)'}.${side[0]}Column ${tableName}.${columnName} maps to missing ${sourceEntityName}.${physicalColumn}`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked} relationship endpoint columns resolve`;
  });

  runCheck('Semantic model', 'measures have descriptions', () => {
    const failures: string[] = [];
    let measures = 0;
    for (const table of semanticTables(semanticModelObject(state))) {
      for (const measure of asArray(table.measures)) {
        measures += 1;
        if (isBlank(measure.description)) failures.push(`${stringValue(table.name)}[${stringValue(measure.name) || '(blank measure)'}] is missing description`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${measures} measures have descriptions`;
  });

  runCheck('Semantic model', 'tables have descriptions', () => {
    const failures: string[] = [];
    const tables = semanticTables(semanticModelObject(state));
    for (const table of tables) {
      if (isBlank(table.description)) failures.push(`${stringValue(table.name) || '(blank table)'} is missing description`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${tables.length} tables have descriptions`;
  });

  runCheck('Semantic model', 'measure DAX column references resolve', () => {
    const model = semanticModelObject(state);
    const tables = semanticTables(model);
    const tablesByName = new Map(tables.map((table) => [stringValue(table.name), table]));
    const sourcesByTable = semanticTableSourcesByName(tables);
    const measureNames = new Set<string>();
    for (const table of tables) for (const measure of asArray(table.measures)) measureNames.add(stringValue(measure.name));
    const failures: string[] = [];
    let checked = 0;
    for (const table of tables) {
      for (const measure of asArray(table.measures)) {
        const measureName = stringValue(measure.name);
        const expression = measureExpressionText(measure.expression);
        for (const reference of extractDaxColumnReferences(expression)) {
          if (measureNames.has(reference.column) || DAX_KEYWORDS.has(reference.table.toUpperCase())) continue;
          const referencedTable = tablesByName.get(reference.table);
          if (!referencedTable) {
            failures.push(`${stringValue(table.name)}[${measureName}] references missing table '${reference.table}'`);
            continue;
          }
          const sourceEntityName = sourcesByTable.get(reference.table);
          const generatedTable = sourceEntityName ? generatedTables.tables.get(sourceEntityName) : undefined;
          if (!sourceEntityName || !generatedTable || generatedTable.error) {
            failures.push(`${stringValue(table.name)}[${measureName}] references ${reference.table}[${reference.column}] but ${reference.table} has no readable generated CSV header`);
            continue;
          }
          const modelColumn = semanticColumnsByName(referencedTable).get(reference.column);
          if (!modelColumn) {
            failures.push(`${stringValue(table.name)}[${measureName}] references missing model column ${reference.table}[${reference.column}]`);
            continue;
          }
          const physicalColumn = stringValue(modelColumn.sourceColumn) || reference.column;
          checked += 1;
          if (!generatedTable.headerSet.has(physicalColumn)) {
            failures.push(`${stringValue(table.name)}[${measureName}] references ${reference.table}[${reference.column}] mapped to missing ${sourceEntityName}.${physicalColumn}`);
          }
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked} DAX table[column] references resolve`;
  });

  runCheck('Semantic model', 'linguistic metadata cultures are present', () => {
    const model = semanticModelObject(state);
    const cultures = asArray(model.cultures);
    if (cultures.length === 0) throw new Error('model.cultures has no entries');
    const withMetadata = cultures.filter((culture) => isPlainObject(culture.linguisticMetadata));
    if (withMetadata.length === 0) throw new Error('model.cultures has no linguisticMetadata entries');
    return `${cultures.length} culture entry with linguistic metadata`;
  });
}

function runDecisionMemoryChecks(
  scenario: Entity,
  decisionMemoryCsvFiles: string[],
  csvParseResults: Map<string, { ok: boolean; rows: number; header: string[] }>,
  decisionRows: Map<string, CsvRow[]>,
  governedActionIds: Set<string>,
  actionReceiptIds: Set<string>,
  approvedPolicyKeys: Set<string>,
  personaNamesLower: string[],
): void {
  runCheck('Decision memory', 'all decision_*.csv files exist and parse', () => {
    const failures: string[] = [];
    let rows = 0;
    for (const file of decisionMemoryCsvFiles) {
      const result = csvParseResults.get(file);
      if (!result) failures.push(`${file}: not parsed`);
      else if (!result.ok) failures.push(`${file}: failed to parse (see Structure result)`);
      else rows += result.rows;
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${decisionMemoryCsvFiles.length} files, ${rows} rows`;
  });

  runCheck('Decision memory', 'child caseId values resolve to decision_cases', () => {
    const caseIds = new Set((decisionRows.get('fabric-sql/decision_cases.csv') ?? []).map((row) => row.caseId).filter(Boolean));
    const failures: string[] = [];
    for (const file of decisionMemoryCsvFiles.filter((candidate) => candidate !== 'fabric-sql/decision_cases.csv')) {
      for (const [index, row] of (decisionRows.get(file) ?? []).entries()) {
        if (!caseIds.has(row.caseId)) failures.push(`${file}:${index + 2}.caseId '${row.caseId || 'blank'}' has no decision_cases row`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${caseIds.size} decision cases referenced by child tables`;
  });

  runCheck('Decision memory', 'main case outcomes match scenario contract', () => {
    const caseId = stringValue(scenario.decisionCase?.caseId);
    const cases = decisionRows.get('fabric-sql/decision_cases.csv') ?? [];
    const outcomes = decisionRows.get('fabric-sql/decision_outcomes.csv') ?? [];
    const failures: string[] = [];
    if (!caseId) throw new Error('scenario.decisionCase.caseId is missing');
    if (!cases.some((row) => row.caseId === caseId)) failures.push(`${caseId} is missing from decision_cases.csv`);

    const heroOutcomes = outcomes.filter((row) => row.caseId === caseId);
    if (!isOutcomeSlice()) {
      // The default dataset stops at the decision, so the hero case must not yet
      // have delivered anything. Asserting the outcomes exist here would be
      // asserting the demo's own punchline before the demo happens.
      if (heroOutcomes.length > 0) {
        failures.push(`${caseId} has ${heroOutcomes.length} recorded outcome(s) but the decision has not been taken`);
      }
      if (failures.length > 0) throw new Error(sample(failures));
      return `${caseId} present and open, no outcomes recorded yet`;
    }

    for (const outcomeId of ['OUT-DEMAND-001', 'OUT-REVENUE-002']) {
      const scenarioOutcome = asArray(scenario.decisionCase?.outcomes).find((outcome) => outcome.outcomeId === outcomeId);
      if (!scenarioOutcome) {
        failures.push(`scenario.decisionCase.outcomes missing ${outcomeId}`);
        continue;
      }
      const row = outcomes.find((candidate) => candidate.caseId === caseId && candidate.outcomeId === outcomeId);
      if (!row) {
        failures.push(`${caseId} missing ${outcomeId} in decision_outcomes.csv`);
        continue;
      }
      if (!approxEqual(numericValue(row.metricValue), numericValue(scenarioOutcome.metricValue), 0.000001)) {
        failures.push(`${outcomeId}.metricValue ${row.metricValue} != scenario ${scenarioOutcome.metricValue}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${caseId} outcome slice matches the scenario contract`;
  });

  runCheck('Decision memory', 'case actions resolve governed actions and receipts', () => {
    const failures: string[] = [];
    for (const [index, row] of (decisionRows.get('fabric-sql/decision_case_actions.csv') ?? []).entries()) {
      if (!governedActionIds.has(row.actionId)) failures.push(`decision_case_actions.csv:${index + 2}.actionId '${row.actionId || 'blank'}' missing from governed_actions.csv`);
      if (!actionReceiptIds.has(row.receiptId)) failures.push(`decision_case_actions.csv:${index + 2}.receiptId '${row.receiptId || 'blank'}' missing from action_receipts.csv`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${decisionRows.get('fabric-sql/decision_case_actions.csv')?.length ?? 0} case action references checked`;
  });

  runCheck('Decision memory', 'case policies resolve approved policy versions', () => {
    const failures: string[] = [];
    for (const [index, row] of (decisionRows.get('fabric-sql/decision_case_policies.csv') ?? []).entries()) {
      const key = policyKey(row.policyId, row.policyVersion);
      if (!approvedPolicyKeys.has(key)) failures.push(`decision_case_policies.csv:${index + 2} ${key} missing from approved_policies.csv`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${decisionRows.get('fabric-sql/decision_case_policies.csv')?.length ?? 0} policy references checked`;
  });

  runCheck('Decision memory', 'approval columns use ROLE-* identifiers only', () => {
    const failures: string[] = [];
    for (const file of decisionMemoryCsvFiles) {
      for (const [index, row] of (decisionRows.get(file) ?? []).entries()) {
        for (const [column, value] of Object.entries(row)) {
          const key = normalizeKey(column);
          const approvalStyle = key.includes('approv') || key.endsWith('role') || isRoleIdentifierColumn(column);
          if (!approvalStyle || isBlank(value)) continue;
          const lower = value.toLowerCase();
          for (const personaName of personaNamesLower) {
            if (personaName && lower.includes(personaName)) failures.push(`${file}:${index + 2}.${column} contains persona display name`);
          }
          if ((key.endsWith('role') || isRoleIdentifierColumn(column)) && !/^ROLE-[A-Z0-9-]+$/.test(value)) {
            failures.push(`${file}:${index + 2}.${column} must contain a ROLE-* identifier, found '${value}'`);
          }
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return 'decision approval-style columns contain role identifiers, not personas';
  });
}

function runWeatherChecks(
  scenario: Entity,
  regions: Entity[],
  knownRegionIds: Set<string>,
  affectedRegionIds: Set<string>,
  unaffectedRegionIds: Set<string>,
  state: WeatherValidationState,
  staticText: Map<string, string>,
): void {
  const weather = isPlainObject(scenario.weather) ? scenario.weather : {};
  const observationWindow = isPlainObject(weather.observationWindow) ? weather.observationWindow : {};
  const weatherForecast = isPlainObject(weather.forecast) ? weather.forecast : {};
  const climatology = isPlainObject(weather.climatology) ? weather.climatology : {};
  const demandResponse = isPlainObject(weather.demandResponse) ? weather.demandResponse : {};
  const tolerancePct = numericValue(demandResponse.tolerancePct);
  const betaUv = numericValue(demandResponse.betaUv);
  const betaTempC = numericValue(demandResponse.betaTempC);
  const horizonDays = numericValue(weatherForecast.horizonDays);
  const varianceWindowStart = stringValue(scenario.clock?.varianceWindowStart);
  const varianceWindowEnd = stringValue(scenario.clock?.varianceWindowEnd);
  const varianceWindowDays = eachDate(varianceWindowStart, varianceWindowEnd).length;

  runCheck('Weather structure', 'weather row counts match scenario contract', () => {
    // The default dataset stops at the as-of boundary, so the expected counts are
    // computed over the observable window rather than the full authored one. The
    // check stays exact; only the window it derives from changes.
    const asOf = stringValue((scenario.clock as Entity | undefined)?.asOf);
    const clamp = (endDate: string): string => (!isOutcomeSlice() && asOf && endDate > asOf ? asOf : endDate);
    const dailyDays = eachDate(stringValue(observationWindow.dailyStart), clamp(stringValue(observationWindow.dailyEnd))).length;
    const hourlyDays = eachDate(stringValue(observationWindow.hourlyStart), clamp(stringValue(observationWindow.hourlyEnd))).length;
    const issueDays = eachDate(stringValue(weatherForecast.issueStart), clamp(stringValue(weatherForecast.issueEnd))).length;
    const climateSignalDays = eachDate(
      stringValue(scenario.externalSignal?.observationPeriodStart),
      clamp(stringValue(scenario.externalSignal?.persistenceThrough)),
    ).length;
    const dailyExpected = regions.length * dailyDays;
    const expectations = [
      ['eventhouse/WeatherObservationsDaily.csv', dailyExpected],
      ['eventhouse/WeatherObservationsHourly.csv', regions.length * hourlyDays * 24],
      ['eventhouse/WeatherForecastDaily.csv', regions.length * issueDays * horizonDays],
      ['eventhouse/ClimateSignalObservations.csv', regions.length * climateSignalDays],
      ['fabric-sql/weather_stations.csv', regions.length],
      ['fabric-sql/climate_normals.csv', regions.length * climatologyDayCount(climatology)],
      ['fabric-sql/weather_demand_response.csv', dailyExpected],
      ['fabric-sql/weather_elasticity_params.csv', boolValue(demandResponse.coefficientsAreGlobal) ? 1 : regions.length],
      ['lakehouse/dashboard/weather-anomaly-by-region.csv', regions.length],
      ['lakehouse/dashboard/weather-forecast-outlook.csv', regions.length * horizonDays],
      ['lakehouse/dashboard/weather-demand-reconciliation.csv', regions.length],
    ] as [string, number][];
    const failures: string[] = [];
    for (const [file, expected] of expectations) {
      const actual = state.csvRowCounts.get(file);
      if (actual !== expected) failures.push(`${file}: expected ${expected.toLocaleString('en-US')} rows, found ${actual === undefined ? 'not parsed' : actual.toLocaleString('en-US')}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${expectations.length} weather CSV row counts checked`;
  });

  runCheck('Weather structure', 'KQL weather tables and CSV mappings match committed headers', () => {
    const tableText = staticText.get('eventhouse/004_weather_tables.kql');
    const mappingText = staticText.get('eventhouse/005_weather_mappings.kql');
    if (!tableText || !mappingText) throw new Error('weather KQL table or mapping file was missing/unreadable');
    const tableDefinitions = parseKqlTableDefinitions(tableText);
    const mappings = parseKqlCsvMappings(mappingText);
    const failures: string[] = [];
    for (const file of WEATHER_EVENTHOUSE_CSV_FILES.filter((relativePath) => normalizedCsvName(relativePath).startsWith('Weather'))) {
      const tableName = normalizedCsvName(file).replace(/\.csv$/, '');
      const header = state.csvHeaders.get(file);
      if (!header || header.length === 0) {
        failures.push(`${file}: CSV header unavailable`);
        continue;
      }
      const tableColumns = tableDefinitions.get(tableName);
      if (!tableColumns) {
        failures.push(`${tableName}: missing .create-merge table definition`);
      } else if (!compareStringArrays(tableColumns, header)) {
        failures.push(`${tableName}: table columns ${tableColumns.join(',')} != CSV header ${header.join(',')}`);
      }
      const mapping = mappings.get(tableName);
      if (!mapping) {
        failures.push(`${tableName}: missing ingestion csv mapping`);
      } else {
        failures.push(...mapping.failures);
        if (!compareStringArrays(mapping.columns, header)) {
          failures.push(`${tableName}: mapping ordinals ${mapping.columns.join(',')} != CSV header ${header.join(',')}`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return '4 Weather*.csv tables and ordinal mappings match their CSV headers';
  });

  runCheck('Weather invariants', 'WeatherObservationsDaily elasticity round-trip matches variancePct', () => {
    const failures: string[] = [];
    for (const region of regions) {
      const regionId = stringValue(region.regionId);
      const uvAggregate = state.dailyWindowUvAnomalies.get(regionId);
      const temperatureAggregate = state.dailyWindowTemperatureAnomalies.get(regionId);
      if (!uvAggregate || !temperatureAggregate || uvAggregate.count !== varianceWindowDays || temperatureAggregate.count !== varianceWindowDays) {
        failures.push(`${regionId}: expected ${varianceWindowDays} variance-window daily rows, found uv=${uvAggregate?.count ?? 0}, temp=${temperatureAggregate?.count ?? 0}`);
        continue;
      }
      const meanUv = aggregateMean(uvAggregate);
      const meanTemperature = aggregateMean(temperatureAggregate);
      const modelled = betaUv * meanUv + betaTempC * meanTemperature;
      if (!approxEqual(modelled, numericValue(region.variancePct), tolerancePct)) {
        failures.push(`${regionId}: modelled ${round(modelled, 3)}% != variancePct ${region.variancePct}% (mean uvIndexAnomaly=${round(meanUv, 4)}, mean temperatureMeanAnomalyC=${round(meanTemperature, 4)}, tolerance=${tolerancePct}pp)`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${regions.length} regional elasticity round-trips checked`;
  });

  runCheck('Weather invariants', 'weather_demand_response recomputes and matches variancePct', () => {
    const failures = [...state.demandResponseModelViolations, ...state.demandResponseFormulaViolations];
    for (const region of regions) {
      const regionId = stringValue(region.regionId);
      const aggregate = state.demandResponseWindowUplift.get(regionId);
      if (!aggregate || aggregate.count !== varianceWindowDays) {
        failures.push(`${regionId}: expected ${varianceWindowDays} demand-response rows in variance window, found ${aggregate?.count ?? 0}`);
        continue;
      }
      const meanUplift = aggregateMean(aggregate);
      if (!approxEqual(meanUplift, numericValue(region.variancePct), tolerancePct)) {
        failures.push(`${regionId}: weather_demand_response window mean ${round(meanUplift, 3)}% != variancePct ${region.variancePct}% (tolerance=${tolerancePct}pp)`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.csvRowCounts.get('fabric-sql/weather_demand_response.csv') ?? 0} rows recomputed; ${regions.length} regional means checked`;
  });

  runCheck('Weather invariants', 'weather-demand-reconciliation modelled uplift equals actual sales variance', () => {
    const failures = [...state.demandReconciliationViolations];
    for (const regionId of knownRegionIds) {
      if (!state.demandReconciliationRegions.has(regionId)) failures.push(`lakehouse/dashboard/weather-demand-reconciliation.csv missing ${regionId}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.demandReconciliationRegions.size} regions reconcile with zero difference`;
  });

  runCheck('Weather invariants', 'WeatherForecastDaily forecast bands are ordered', () => {
    if (state.forecastBandViolationCount > 0) {
      throw new Error(`${state.forecastBandViolationCount.toLocaleString('en-US')} band-order violations: ${sample(state.forecastBandViolations)}`);
    }
    return '0 band-order violations';
  });

  runCheck('Weather invariants', 'decision-day forecast continuation matches affected-region story', () => {
    const failures: string[] = [];
    const decisionDayIssue = stringValue(weatherForecast.decisionDayIssue);
    const horizonEnd = stringValue(weatherForecast.decisionDayHorizonEnd);
    const computedHorizonEnd = addDaysString(decisionDayIssue, horizonDays);
    if (computedHorizonEnd !== horizonEnd) failures.push(`scenario.weather.forecast.decisionDayHorizonEnd ${horizonEnd} != ${decisionDayIssue} + ${horizonDays} days (${computedHorizonEnd})`);
    if (state.decisionForecastMaxTargetDate !== horizonEnd) {
      failures.push(`issue ${decisionDayIssue} max targetDate ${state.decisionForecastMaxTargetDate || 'none'} != decisionDayHorizonEnd ${horizonEnd}`);
    }
    for (const regionId of knownRegionIds) {
      const regionState = state.decisionForecastByRegion.get(regionId);
      if (!regionState) {
        failures.push(`${regionId}: no decision-day forecast rows for issue ${decisionDayIssue}`);
        continue;
      }
      for (let lead = 1; lead <= horizonDays; lead += 1) {
        if (!regionState.leads.has(lead)) failures.push(`${regionId}: missing leadDays=${lead} for decision-day issue`);
      }
      if (affectedRegionIds.has(regionId) && regionState.positiveViolations.length > 0) failures.push(sample(regionState.positiveViolations));
      if (unaffectedRegionIds.has(regionId) && regionState.nearZeroViolations.length > 0) failures.push(sample(regionState.nearZeroViolations));
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${affectedRegionIds.size} affected regions positive for all ${horizonDays} lead days; ${unaffectedRegionIds.size} controls near zero through ${horizonEnd}`;
  });

  runCheck('Weather invariants', 'WeatherForecastDaily p50 UV forecast skill improves with shorter leads', () => {
    const shortLeadMax = Math.max(1, Math.floor(horizonDays / 3));
    const longLeadMin = Math.max(shortLeadMax + 1, horizonDays - shortLeadMax + 1);
    let pairedShortSum = 0;
    let pairedLongSum = 0;
    let pairedCount = 0;
    for (const leadErrors of state.forecastSkillByRegionTarget.values()) {
      let shortSum = 0;
      let shortCount = 0;
      let longSum = 0;
      let longCount = 0;
      for (const [leadDay, error] of leadErrors.entries()) {
        if (leadDay <= shortLeadMax) {
          shortSum += error;
          shortCount += 1;
        }
        if (leadDay >= longLeadMin) {
          longSum += error;
          longCount += 1;
        }
      }
      if (shortCount > 0 && longCount > 0) {
        pairedShortSum += shortSum / shortCount;
        pairedLongSum += longSum / longCount;
        pairedCount += 1;
      }
    }
    if (pairedCount === 0) throw new Error('insufficient forecast/observation overlap for paired skill check');
    const shortMean = pairedShortSum / pairedCount;
    const longMean = pairedLongSum / pairedCount;
    if (!(shortMean < longMean)) {
      throw new Error(`paired mean UV p50 absolute error for short leads 1..${shortLeadMax} (${round(shortMean, 4)}) is not lower than long leads ${longLeadMin}..${horizonDays} (${round(longMean, 4)})`);
    }
    return `paired short-lead mean abs error ${round(shortMean, 4)} < long-lead ${round(longMean, 4)} (${pairedCount} region/date samples)`;
  });

  runCheck('Weather invariants', 'ClimateSignalObservations UV matches WeatherObservationsDaily', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [key, climateRow] of state.climateSignalUvByRegionDate.entries()) {
      const dailyRow = state.dailyObservations.get(key);
      if (!dailyRow) {
        pushSample(failures, `${climateRow.location}: no matching WeatherObservationsDaily row for ${key}`);
        continue;
      }
      checked += 1;
      if (climateRow.uvIndex !== dailyRow.uvIndex) {
        pushSample(failures, `${key}: ClimateSignalObservations uvIndex ${climateRow.uvIndex} != WeatherObservationsDaily uvIndex ${dailyRow.uvIndex}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked.toLocaleString('en-US')} shared region/date UV values match exactly`;
  });

  runCheck('Weather invariants', 'WeatherObservationsDaily anomalies match climate_normals', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [key, dailyRow] of state.dailyObservations.entries()) {
      const [regionId, dateKey] = key.split('|');
      const normal = state.normalsByRegionDayOfYear.get(weatherRegionDayOfYearKey(regionId, dayOfYearUtc(dateKey)));
      if (!normal) {
        pushSample(failures, `${dailyRow.location}: no climate_normals row for ${regionId} day ${dayOfYearUtc(dateKey)}`);
        continue;
      }
      checked += 1;
      const temperatureAnomaly = dailyRow.temperatureMeanC - normal.temperatureMeanNormalC;
      const uvAnomaly = dailyRow.uvIndex - normal.uvIndexNormal;
      if (!approxEqual(temperatureAnomaly, dailyRow.temperatureMeanAnomalyC, 0.05)) {
        pushSample(failures, `${key}: temperature anomaly ${round(temperatureAnomaly, 3)} != ${dailyRow.temperatureMeanAnomalyC}`);
      }
      if (!approxEqual(uvAnomaly, dailyRow.uvIndexAnomaly, 0.05)) {
        pushSample(failures, `${key}: UV anomaly ${round(uvAnomaly, 3)} != ${dailyRow.uvIndexAnomaly}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked.toLocaleString('en-US')} daily rows matched to day-of-year normals`;
  });

  runCheck('Weather invariants', 'WeatherObservationsHourly coheres with daily observations', () => {
    const failures = [...state.hourlyNightUvViolations];
    let checked = 0;
    for (const [key, aggregate] of state.hourlyAggregates.entries()) {
      const dailyRow = state.dailyObservations.get(key);
      if (!dailyRow) {
        pushSample(failures, `${key}: no matching WeatherObservationsDaily row`);
        continue;
      }
      if (aggregate.count !== 24) pushSample(failures, `${key}: expected 24 hourly rows, found ${aggregate.count}`);
      const meanTemperature = aggregate.temperatureSum / aggregate.count;
      if (!approxEqual(meanTemperature, dailyRow.temperatureMeanC, 0.6)) {
        pushSample(failures, `${key}: hourly mean temperature ${round(meanTemperature, 3)} != daily temperatureMeanC ${dailyRow.temperatureMeanC}`);
      }
      if (!approxEqual(aggregate.uvMax, dailyRow.uvIndex, 0.6)) {
        pushSample(failures, `${key}: hourly max UV ${round(aggregate.uvMax, 3)} != daily uvIndex ${dailyRow.uvIndex}`);
      }
      checked += 1;
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked.toLocaleString('en-US')} region/dates checked; nighttime UV is zero`;
  });

  runCheck('Weather invariants', 'weather values are physically plausible and UV alert levels match', () => {
    if (state.physicalViolations.length > 0) {
      const prefix = state.uvAlertViolationCount > 0 ? `${state.uvAlertViolationCount.toLocaleString('en-US')} UV alert level violations; ` : '';
      throw new Error(`${prefix}${state.physicalViolations.slice(0, 8).join('; ')}`);
    }
    return 'UV, humidity, cloud cover, precipitation, alert levels, and landlocked sea-surface fields are valid';
  });

  runCheck('Weather invariants', 'weather events cover catalogue and agree across stores', () => {
    const expectedTypes = new Set(asArray(weather.eventCatalogue).map((event) => stringValue(event.eventType)).filter(Boolean));
    const eventhouse = state.eventSources['eventhouse/WeatherEvents.csv'];
    const fabric = state.eventSources['fabric-sql/weather_events.csv'];
    const lakehouse = state.eventSources['lakehouse/external-signals/weather-events.jsonl'];
    const failures = [
      ...eventhouse.duplicateIds,
      ...fabric.duplicateIds,
      ...lakehouse.duplicateIds,
      ...eventhouse.unknownRegionIds,
      ...fabric.unknownRegionIds,
      ...lakehouse.unknownRegionIds,
      ...eventhouse.ensoSignalViolations,
      ...fabric.ensoSignalViolations,
      ...lakehouse.ensoSignalViolations,
    ];
    const missingTypes = sorted([...expectedTypes].filter((eventType) => !eventhouse.eventTypes.has(eventType)));
    const extraTypes = sorted([...eventhouse.eventTypes].filter((eventType) => !expectedTypes.has(eventType)));
    if (missingTypes.length > 0 || extraTypes.length > 0) failures.push(`WeatherEvents.csv event types mismatch; missing=${missingTypes.join(', ') || 'none'} extra=${extraTypes.join(', ') || 'none'}`);
    const unaffectedMissing = sorted([...unaffectedRegionIds].filter((regionId) => !eventhouse.unaffectedRegionIds.has(regionId)));
    if (unaffectedMissing.length > 0) failures.push(`WeatherEvents.csv missing events for unaffected regions: ${unaffectedMissing.join(', ')}`);
    if (eventhouse.irrelevantEventTypes.size === 0) failures.push('WeatherEvents.csv has no events marked relevantToHeroProduct=false');
    const compareSources = [
      ['fabric-sql/weather_events.csv', fabric.ids],
      ['lakehouse/external-signals/weather-events.jsonl', lakehouse.ids],
    ] as [string, Set<string>][];
    for (const [sourceName, ids] of compareSources) {
      if (!setEquals(eventhouse.ids, ids)) {
        const missing = sorted([...eventhouse.ids].filter((eventId) => !ids.has(eventId)));
        const extra = sorted([...ids].filter((eventId) => !eventhouse.ids.has(eventId)));
        failures.push(`${sourceName} event ids differ from WeatherEvents.csv; missing=${sample(missing, 4) || 'none'} extra=${sample(extra, 4) || 'none'}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${eventhouse.ids.size} event ids, ${expectedTypes.size} catalogue types, ${eventhouse.irrelevantEventTypes.size} distractor event types`;
  });

  runCheck('Weather disclosure', 'weather payload carries provenance but no disclosure labelling', () => {
    const failures = [...state.csvDisclosureViolations, ...state.jsonDisclosureViolations];
    const stillLabelled = sorted(state.csvFilesWithSyntheticLabelling);
    if (stillLabelled.length > 0) {
      failures.push(`weather CSV files still carry a disclosure column: ${stillLabelled.join(', ')}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${state.csvFilesWithoutSyntheticLabelling.size} weather CSV files and ${WEATHER_JSONL_FILES.length + WEATHER_JSON_FILES.length} weather JSON/JSONL files are clean, provenance intact`;
  });

  runCheck('Weather disclosure', 'decision-day forecast briefing mentions horizon end and seasonal persistence', () => {
    const decisionDayIssue = stringValue(weatherForecast.decisionDayIssue);
    const horizonEnd = stringValue(weatherForecast.decisionDayHorizonEnd);
    const persistenceProbability = numericValue(weather.seasonalOutlook?.persistenceProbability);
    const briefing = state.decisionBriefing;
    if (!briefing) throw new Error(`forecast-briefings.jsonl has no briefing for issueDate ${decisionDayIssue}`);
    const text = JSON.stringify(briefing.record);
    const persistencePercent = `${round(persistenceProbability * 100, 1).toString().replace(/\.0$/, '')}%`;
    const persistenceWholePercent = `${round(persistenceProbability * 100, 0)}%`;
    const failures: string[] = [];
    if (stringValue(briefing.record.horizonEndDate) !== horizonEnd) {
      failures.push(`${briefing.location}.horizonEndDate=${stringValue(briefing.record.horizonEndDate) || 'blank'}, expected ${horizonEnd}`);
    }
    if (!text.includes(horizonEnd)) failures.push(`${briefing.location} does not mention horizon end ${horizonEnd}`);
    if (!text.includes(String(persistenceProbability)) && !text.includes(persistencePercent) && !text.includes(persistenceWholePercent)) {
      failures.push(`${briefing.location} does not mention seasonal persistence probability ${persistenceProbability} (${persistenceWholePercent})`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${decisionDayIssue} briefing carries horizon ${horizonEnd} and persistence ${persistenceWholePercent}`;
  });
}

async function readEvidenceCsvRows(relativePath: string): Promise<{ header: string[]; rows: CsvRow[]; error: string | null }> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) return { header: [], rows: [], error: `Missing file (checked ${relativePath})` };
  try {
    const text = await readFile(found.absolutePath, 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) return { header: [], rows: [], error: 'empty file' };
    const headerParsed = parseCsvLine(lines[0]);
    if (!headerParsed.ok) return { header: [], rows: [], error: `header: ${headerParsed.error}` };
    const header = headerParsed.values;
    const rows: CsvRow[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const parsed = parseCsvLine(lines[i]);
      if (!parsed.ok) return { header, rows, error: `line ${i + 1}: ${parsed.error}` };
      const row: CsvRow = {};
      for (let c = 0; c < header.length; c += 1) row[header[c]] = parsed.values[c] ?? '';
      rows.push(row);
    }
    return { header, rows, error: null };
  } catch (error) {
    return { header: [], rows: [], error: errorMessage(error) };
  }
}

async function readEvidenceJsonlRecords(relativePath: string): Promise<{ records: Entity[]; error: string | null }> {
  const found = await resolveLogicalFile(relativePath);
  if (!found) return { records: [], error: `Missing file (checked ${relativePath})` };
  try {
    const text = await readFile(found.absolutePath, 'utf8');
    const records: Entity[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      records.push(JSON.parse(lines[i]) as Entity);
    }
    return { records, error: null };
  } catch (error) {
    return { records: [], error: errorMessage(error) };
  }
}

/**
 * The data agent grounds on the CSV projections, but the JSONL documents remain the
 * authored source. These checks exist so the two cannot drift apart silently: a
 * projection that loses a row, an id or a disclosure would let the agent cite
 * evidence that no longer matches the narrative it was derived from.
 */
async function runAgentEvidenceChecks(scenario: Entity, knownRegionIds: Set<string>): Promise<void> {
  const group = 'Agent evidence';
  const explanationCsv = await readEvidenceCsvRows('lakehouse/evidence/demand_signal_explanation.csv');

  // This table exists so the Act 1 question is answerable in one query instead
  // of a three-source fan-out that exceeds the agent's time limit. It is a
  // derived join, so it can silently drift from the contract it was derived
  // from; these checks are what stop that.
  runCheck(group, 'Act 1 explanation table reproduces the scenario contract', () => {
    if (explanationCsv.error) throw new Error(explanationCsv.error);
    const regions = asArray(scenario.regions);
    if (explanationCsv.rows.length !== regions.length) {
      throw new Error(`${explanationCsv.rows.length} rows for ${regions.length} regions`);
    }
    const clock = (scenario.clock ?? {}) as Entity;
    const outlook = (scenario.weather as Entity | undefined)?.seasonalOutlook as Entity | undefined;
    const horizonEnd = stringValue((scenario.weather as Entity | undefined)?.forecast?.decisionDayHorizonEnd);
    const failures: string[] = [];

    for (const region of regions) {
      const regionId = stringValue(region.regionId);
      const row = explanationCsv.rows.find((candidate) => stringValue(candidate.regionId) === regionId);
      if (!row) {
        failures.push(`no row for ${regionId}`);
        continue;
      }
      const variance = Number(row.forecastVariancePct);
      if (!approxEqual(variance, numericValue(region.variancePct), 0.000001)) {
        failures.push(`${regionId} variance ${variance} != scenario ${stringValue(region.variancePct)}`);
      }
      // The whole Act 1 claim is that modelled weather uplift explains observed
      // variance. If these ever diverge the explanation is no longer true.
      if (!approxEqual(Number(row.modelledWeatherUpliftPct), variance, 0.05)) {
        failures.push(`${regionId} modelled uplift ${row.modelledWeatherUpliftPct} does not reconcile with variance ${variance}`);
      }
      if (stringValue(row.observedThrough) !== stringValue(clock.asOf)) {
        failures.push(`${regionId} observedThrough ${stringValue(row.observedThrough)} != asOf ${stringValue(clock.asOf)}`);
      }
      if (stringValue(row.campaignEndsOn) !== stringValue(clock.campaignEnd)) {
        failures.push(`${regionId} campaignEndsOn does not match the scenario clock`);
      }
      if (horizonEnd && stringValue(row.forecastHorizonEndsOn) !== horizonEnd) {
        failures.push(`${regionId} forecastHorizonEndsOn does not match the scenario forecast`);
      }
      const affected = region.signalAffected === true;
      if (affected && !approxEqual(Number(row.persistenceProbability), numericValue(outlook?.persistenceProbability), 0.000001)) {
        failures.push(`${regionId} persistence ${stringValue(row.persistenceProbability)} != scenario`);
      }
      if (!affected && stringValue(row.signalId) !== '') {
        failures.push(`${regionId} is a control region but carries signalId ${stringValue(row.signalId)}`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${explanationCsv.rows.length} regions reconcile variance, uplift, persistence and horizon`;
  });

  // The horizon-honesty point only lands if the forecast genuinely stops short
  // of the campaign. If a future calendar move made it cover the campaign, the
  // Act 1 narrative would quietly become wrong.
  runCheck(group, 'the forecast horizon stops short of the campaign end', () => {
    if (explanationCsv.error) throw new Error(explanationCsv.error);
    const row = explanationCsv.rows[0];
    if (!row) throw new Error('no explanation rows');
    const horizonEnd = stringValue(row.forecastHorizonEndsOn);
    const campaignEnd = stringValue(row.campaignEndsOn);
    if (horizonEnd >= campaignEnd) {
      throw new Error(`horizon ${horizonEnd} reaches the campaign end ${campaignEnd}; the seasonal outlook is no longer needed`);
    }
    if (stringValue(row.horizonCoversCampaign).toLowerCase() !== 'false') {
      throw new Error(`horizonCoversCampaign is ${stringValue(row.horizonCoversCampaign)}, expected false`);
    }
    return `horizon ends ${horizonEnd}, campaign runs to ${campaignEnd}`;
  });

  // The Act 2 and Act 3 summaries are derived joins that exist purely so each demo
  // question is answerable in one query. They restate frozen contract numbers, so
  // they are exactly the kind of table that can drift silently.
  const decisionStatusCsv = await readEvidenceCsvRows('lakehouse/evidence/campaign_decision_status.csv');
  const capacitySummaryCsv = await readEvidenceCsvRows('lakehouse/evidence/capacity_conflict_summary.csv');

  runCheck(group, 'decision status summary agrees with the open-decision state', () => {
    if (decisionStatusCsv.error) throw new Error(decisionStatusCsv.error);
    const scenarios = asArray(scenario.scenarios);
    if (decisionStatusCsv.rows.length !== scenarios.length) {
      throw new Error(`${decisionStatusCsv.rows.length} rows for ${scenarios.length} scenarios`);
    }
    const failures: string[] = [];
    const isTrue = (value: unknown) => ['true', '1', 'yes'].includes(stringValue(value).toLowerCase());
    for (const row of decisionStatusCsv.rows) {
      const scenarioId = stringValue(row.scenarioId);
      const source = scenarios.find((candidate) => stringValue(candidate.scenarioId) === scenarioId);
      if (!source) {
        failures.push(`${scenarioId} is not in the scenario contract`);
        continue;
      }
      if (isTrue(row.recommended) !== (source.recommended === true)) {
        failures.push(`${scenarioId} recommended flag disagrees with the contract`);
      }
      if (!isOutcomeSlice()) {
        if (isTrue(row.approved)) failures.push(`${scenarioId} is approved in the default slice`);
        if (isTrue(row.commitmentExists)) failures.push(`${scenarioId} claims a commitment exists`);
        if (Number(row.governedActionsExecuted) !== 0) failures.push(`${scenarioId} reports executed governed actions`);
        if (Number(row.receiptsIssued) !== 0) failures.push(`${scenarioId} reports issued receipts`);
        if (source.recommended === true && !/not approved/i.test(stringValue(row.decisionState))) {
          failures.push(`${scenarioId} decisionState '${stringValue(row.decisionState)}' does not say it is unapproved`);
        }
      }
      if (stringValue(row.asOfDate) !== stringValue((scenario.clock as Entity | undefined)?.asOf)) {
        failures.push(`${scenarioId} asOfDate does not match the scenario clock`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    const recommended = decisionStatusCsv.rows.filter((row) => isTrue(row.recommended));
    return `${decisionStatusCsv.rows.length} scenarios, ${recommended.length} recommended, none approved or committed`;
  });

  runCheck(group, 'capacity summary reproduces the frozen capacity numbers', () => {
    if (capacitySummaryCsv.error) throw new Error(capacitySummaryCsv.error);
    const options = asArray(scenario.options);
    if (capacitySummaryCsv.rows.length !== options.length) {
      throw new Error(`${capacitySummaryCsv.rows.length} rows for ${options.length} production options`);
    }
    const expected = (scenario.capacityModel as Entity | undefined)?.expected as Entity | undefined;
    const maintenance = (scenario.maintenance ?? {}) as Entity;
    const stress = (scenario.stressModel ?? {}) as Entity;
    if (!isPlainObject(expected)) throw new Error('scenario.capacityModel.expected is missing');
    const recommendedId = stringValue(scenario.recommendedOptionId);
    const row = capacitySummaryCsv.rows.find((candidate) => stringValue(candidate.optionId) === recommendedId);
    if (!row) throw new Error(`recommended option ${recommendedId} is missing from the summary`);
    const failures: string[] = [];
    const check = (column: string, want: unknown) => {
      if (!approxEqual(Number(row[column]), numericValue(want), 0.001)) {
        failures.push(`${column} ${stringValue(row[column])} != contract ${stringValue(want)}`);
      }
    };
    check('campaignShortfallUnits', expected.shortfallUnits);
    check('requiredIncrementalUnits', expected.requiredIncrementalUnits);
    check('headroomWithMaintenanceUnits', expected.headroomWithMaintenanceUnits);
    check('capacityWithMaintenanceUnits', expected.capacityWithMaintenanceUnits);
    check('deferralDays', maintenance.deferralDays);
    check('stressCeilingPct', stress.stressCeilingPct);
    const stressPct = (numericValue(stress.projectedStressAtDeferredMaintenance) / numericValue(stress.thresholdStressIndex)) * 100;
    check('projectedStressPctOfThreshold', round(stressPct, 2));
    if (stringValue(row.maintenanceWindowId) !== stringValue(maintenance.maintenanceWindowId)) {
      failures.push('maintenanceWindowId does not match the contract');
    }
    if (stringValue(row.withinStressCeiling).toLowerCase() !== 'true') {
      failures.push('recommended option is reported as breaching the stress ceiling');
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${recommendedId}: shortfall ${stringValue(row.campaignShortfallUnits)}, deferral ${stringValue(row.deferralDays)} days, stress ${stringValue(row.projectedStressPctOfThreshold)}%`;
  });

  const [advisoriesCsv, briefingsCsv, briefingRegionsCsv, traceCsv, providerCsv] = await Promise.all([
    readEvidenceCsvRows('lakehouse/evidence/climate_advisories.csv'),
    readEvidenceCsvRows('lakehouse/evidence/forecast_briefings.csv'),
    readEvidenceCsvRows('lakehouse/evidence/forecast_briefing_regions.csv'),
    readEvidenceCsvRows('lakehouse/evidence/signal_evidence_trace.csv'),
    readEvidenceCsvRows('lakehouse/evidence/weather_provider.csv'),
  ]);
  const [advisoriesJsonl, briefingsJsonl, traceJsonl] = await Promise.all([
    readEvidenceJsonlRecords('lakehouse/external-signals/climate-advisories.jsonl'),
    readEvidenceJsonlRecords('lakehouse/external-signals/forecast-briefings.jsonl'),
    readEvidenceJsonlRecords('lakehouse/external-signals/signal-evidence-trace.jsonl'),
  ]);
  const providerJson = await parseJsonFile('lakehouse/external-signals/weather-provider.json', group);

  const projections = [
    { label: 'climate advisories', csv: advisoriesCsv, records: advisoriesJsonl, idKey: 'signalId' },
    { label: 'forecast briefings', csv: briefingsCsv, records: briefingsJsonl, idKey: 'briefingId' },
    { label: 'signal evidence trace', csv: traceCsv, records: traceJsonl, idKey: 'hop' },
  ];

  for (const projection of projections) {
    runCheck(group, `${projection.label} CSV projects the JSONL document without drift`, () => {
      if (projection.csv.error) throw new Error(`CSV: ${projection.csv.error}`);
      if (projection.records.error) throw new Error(`JSONL: ${projection.records.error}`);
      const csvRows = projection.csv.rows;
      const jsonRecords = projection.records.records;
      if (csvRows.length !== jsonRecords.length) {
        throw new Error(`${csvRows.length} CSV rows vs ${jsonRecords.length} JSONL records`);
      }
      const failures: string[] = [];
      for (let i = 0; i < jsonRecords.length; i += 1) {
        const expected = stringValue(jsonRecords[i][projection.idKey]);
        const actual = stringValue(csvRows[i][projection.idKey]);
        if (expected !== actual) failures.push(`row ${i + 1}: ${projection.idKey} CSV '${actual}' vs JSONL '${expected}'`);
      }
      if (failures.length > 0) throw new Error(sample(failures));
      return `${csvRows.length} rows aligned on ${projection.idKey}`;
    });
  }

  runCheck(group, 'weather provider CSV projects weather-provider.json', () => {
    if (providerCsv.error) throw new Error(`CSV: ${providerCsv.error}`);
    if (!isPlainObject(providerJson)) throw new Error('weather-provider.json did not parse as an object');
    if (providerCsv.rows.length !== 1) throw new Error(`expected exactly 1 provider row, found ${providerCsv.rows.length}`);
    const row = providerCsv.rows[0];
    const failures: string[] = [];
    for (const key of ['providerId', 'name', 'sourceLabel']) {
      const expected = stringValue((providerJson as Entity)[key]);
      const actual = stringValue(row[key]);
      if (expected !== '' && expected !== actual) failures.push(`${key}: CSV '${actual}' vs JSON '${expected}'`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `provider ${stringValue(row.providerId)} matches`;
  });

  runCheck(group, 'evidence tables carry attribution but no disclosure labelling', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [label, parsed] of [
      ['climate_advisories', advisoriesCsv],
      ['weather_provider', providerCsv],
    ] as const) {
      if (parsed.error) throw new Error(`${label}: ${parsed.error}`);
      for (const banned of ['syntheticEvidence', 'syntheticDisclaimer']) {
        if (parsed.header.includes(banned)) failures.push(`${label} still has a ${banned} column`);
      }
      for (let i = 0; i < parsed.rows.length; i += 1) {
        checked += 1;
        const row = parsed.rows[i];
        const sourceLabel = stringValue(row.sourceLabel);
        if (sourceLabel === '') failures.push(`${label}:${i + 2} has no sourceLabel attribution`);
        else if (DISCLOSURE_MARKER.test(sourceLabel)) {
          failures.push(`${label}:${i + 2} sourceLabel still carries disclosure text: '${sourceLabel.slice(0, 50)}'`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${checked} evidence rows carry clean attribution`;
  });

  runCheck(group, 'advisory persistence and horizon match scenario', () => {
    if (advisoriesCsv.error) throw new Error(advisoriesCsv.error);
    const outlook = (scenario.weather as Entity | undefined)?.seasonalOutlook as Entity | undefined;
    if (!isPlainObject(outlook)) throw new Error('scenario.weather.seasonalOutlook missing');
    const signalId = stringValue(outlook.signalId);
    const row = advisoriesCsv.rows.find((candidate) => stringValue(candidate.signalId) === signalId);
    if (!row) throw new Error(`no advisory row for ${signalId}`);
    const failures: string[] = [];
    const probability = Number(row.persistenceProbability);
    if (probability !== Number(outlook.persistenceProbability)) {
      failures.push(`persistenceProbability ${probability} vs scenario ${stringValue(outlook.persistenceProbability)}`);
    }
    if (stringValue(row.persistenceThrough) !== stringValue(outlook.persistenceThrough)) {
      failures.push(`persistenceThrough '${stringValue(row.persistenceThrough)}' vs scenario '${stringValue(outlook.persistenceThrough)}'`);
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
    return `${signalId} persistence ${probability} through ${stringValue(row.persistenceThrough)}`;
  });

  runCheck(group, 'advisory affected regions match the scenario signal split', () => {
    if (advisoriesCsv.error) throw new Error(advisoriesCsv.error);
    const outlook = (scenario.weather as Entity | undefined)?.seasonalOutlook as Entity | undefined;
    const signalId = stringValue(outlook?.signalId);
    const row = advisoriesCsv.rows.find((candidate) => stringValue(candidate.signalId) === signalId);
    if (!row) throw new Error(`no advisory row for ${signalId}`);
    const affected = stringValue(row.affectedRegionIds).split(';').map((part) => part.trim()).filter((part) => part !== '');
    const expected = asArray(scenario.regions)
      .filter((region) => region.signalAffected === true)
      .map((region) => stringValue(region.regionId));
    if (!compareStringArrays([...affected].sort(), [...expected].sort())) {
      throw new Error(`advisory affected [${affected.join(', ')}] vs scenario [${expected.join(', ')}]`);
    }
    const unknown = affected.filter((regionId) => !knownRegionIds.has(regionId));
    if (unknown.length > 0) throw new Error(`unknown region ids: ${unknown.join(', ')}`);
    return `${affected.length} affected regions match scenario`;
  });

  runCheck(group, 'evidence trace hops are contiguous and resolve to labelled entities', () => {
    if (traceCsv.error) throw new Error(traceCsv.error);
    const rows = traceCsv.rows;
    if (rows.length === 0) throw new Error('no evidence trace rows');
    const failures: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const hop = Number(rows[i].hop);
      if (hop !== i + 1) failures.push(`row ${i + 2}: hop ${stringValue(rows[i].hop)}, expected ${i + 1}`);
      for (const key of ['relation', 'fromEntityId', 'fromLabel', 'toEntityIds', 'toLabels']) {
        if (stringValue(rows[i][key]) === '') failures.push(`row ${i + 2}: ${key} is blank`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${rows.length} contiguous hops`;
  });

  runCheck(group, 'briefing region rows cover every briefing and region', () => {
    if (briefingsCsv.error) throw new Error(briefingsCsv.error);
    if (briefingRegionsCsv.error) throw new Error(briefingRegionsCsv.error);
    const briefingIds = new Set(briefingsCsv.rows.map((row) => stringValue(row.briefingId)));
    const regionIds = new Set<string>();
    const failures: string[] = [];
    for (const row of briefingRegionsCsv.rows) {
      const briefingId = stringValue(row.briefingId);
      const regionId = stringValue(row.regionId);
      if (!briefingIds.has(briefingId)) failures.push(`unknown briefingId '${briefingId}'`);
      if (!knownRegionIds.has(regionId)) failures.push(`unknown regionId '${regionId}'`);
      regionIds.add(regionId);
    }
    const expected = briefingIds.size * regionIds.size;
    if (briefingRegionsCsv.rows.length !== expected) {
      failures.push(`${briefingRegionsCsv.rows.length} rows, expected ${briefingIds.size} briefings x ${regionIds.size} regions = ${expected}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${briefingRegionsCsv.rows.length} rows = ${briefingIds.size} briefings x ${regionIds.size} regions`;
  });
}

/**
 * The agent definition is authored, not portal-tuned, so it can drift away from the
 * estate it grounds on. These checks assert it references only objects that exist,
 * still carries the governance posture Act 1 depends on, and still encodes the two
 * platform constraints that were discovered the hard way.
 */
async function runDataAgentChecks(scenario: Entity, generatedTables: GeneratedTables, semanticState: SemanticModelState): Promise<void> {
  const group = 'Data agent';
  const definition = await parseJsonFile(`${DATA_AGENT_ROOT}/agent.json`, group);
  const instructions = await readRequiredTextFile(group, 'instructions.md', `${DATA_AGENT_ROOT}/instructions.md`);

  const dataSources = isPlainObject(definition) ? asArray((definition as Entity).dataSources) : [];
  const fewShotFiles = new Map<string, unknown>();
  for (const source of dataSources) {
    const fewShotFile = stringValue(source.fewShotFile);
    if (fewShotFile === '' || fewShotFiles.has(fewShotFile)) continue;
    const found = await resolveLogicalFile(`${DATA_AGENT_ROOT}/${fewShotFile}`);
    if (!found) {
      fewShotFiles.set(fewShotFile, null);
      continue;
    }
    try {
      fewShotFiles.set(fewShotFile, JSON.parse(await readFile(found.absolutePath, 'utf8')));
    } catch (error) {
      fewShotFiles.set(fewShotFile, errorMessage(error));
    }
  }

  runCheck(group, 'agent.json declares the expected shape', () => {
    if (!isPlainObject(definition)) throw new Error('agent.json did not parse as an object');
    const missing = ['name', 'description', 'instructionsFile', 'fewShotDirectory', 'dataSources'].filter(
      (key) => isBlank((definition as Entity)[key]),
    );
    if (missing.length > 0) throw new Error(`missing keys: ${missing.join(', ')}`);
    if (dataSources.length === 0) throw new Error('no data sources declared');
    return `${stringValue((definition as Entity).name)} with ${dataSources.length} data sources`;
  });

  runCheck(group, 'every data source declares a resolvable attach mode', () => {
    const failures: string[] = [];
    for (const source of dataSources) {
      const label = stringValue(source.itemName) || '(blank)';
      const attachAs = stringValue(source.attachAs);
      if (!['DataSource', 'PeerSurface'].includes(attachAs)) failures.push(`${label}: attachAs='${attachAs}'`);
      if (typeof source.fewShotsUploadable !== 'boolean') failures.push(`${label}: fewShotsUploadable is not a boolean`);
      if (isBlank(source.artifactType)) failures.push(`${label}: artifactType is blank`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${dataSources.length} data sources declare attachAs and fewShotsUploadable`;
  });

  // Regression guard: 'OntologyAddAsDataSourceBlocked'. Attaching the ontology as a
  // data agent data source is rejected by the service; it is consumed via the
  // ontology surface instead.
  runCheck(group, 'ontology is declared as a peer surface, not a data source', () => {
    const ontology = dataSources.find((source) => stringValue(source.artifactType) === 'Ontology');
    if (!ontology) throw new Error('no Ontology entry declared');
    const attachAs = stringValue(ontology.attachAs);
    if (attachAs !== 'PeerSurface') {
      throw new Error(`attachAs='${attachAs}'; attaching an ontology as a data source is rejected with OntologyAddAsDataSourceBlocked`);
    }
    if (isBlank(ontology.consumedVia)) throw new Error('ontology does not record how it is consumed');
    return `ontology consumed via ${stringValue(ontology.consumedVia)}`;
  });

  // Regression guard: few-shots against a semantic model report success but store
  // nothing, so the definition must mark them as not uploadable.
  runCheck(group, 'semantic model source marks few-shots as not uploadable', () => {
    const model = dataSources.find((source) => stringValue(source.artifactType) === 'SemanticModel');
    if (!model) throw new Error('no SemanticModel entry declared');
    if (model.fewShotsUploadable !== false) {
      throw new Error('fewShotsUploadable must be false; the service silently discards few-shots for SemanticModel sources');
    }
    return 'semantic model few-shots flagged reference-only';
  });

  runCheck(group, 'few-shot files parse and use the documented question/query shape', () => {
    const failures: string[] = [];
    let examples = 0;
    for (const source of dataSources) {
      const fewShotFile = stringValue(source.fewShotFile);
      if (fewShotFile === '') continue;
      const loaded = fewShotFiles.get(fewShotFile);
      if (loaded === null) {
        failures.push(`${fewShotFile} is missing`);
        continue;
      }
      if (typeof loaded === 'string') {
        failures.push(`${fewShotFile}: ${loaded}`);
        continue;
      }
      if (!Array.isArray(loaded)) {
        failures.push(`${fewShotFile} is not an array`);
        continue;
      }
      if (loaded.length === 0) failures.push(`${fewShotFile} is empty`);
      for (let i = 0; i < loaded.length; i += 1) {
        const example = loaded[i];
        examples += 1;
        if (!isPlainObject(example)) {
          failures.push(`${fewShotFile}[${i}] is not an object`);
          continue;
        }
        if (isBlank((example as Entity).question)) failures.push(`${fewShotFile}[${i}] has a blank question`);
        if (isBlank((example as Entity).query)) failures.push(`${fewShotFile}[${i}] has a blank query`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${examples} examples across ${fewShotFiles.size} files`;
  });

  runCheck(group, 'instructions carry the Act 1 governance posture', () => {
    if (!instructions) throw new Error('instructions.md missing');
    const horizonEnd = stringValue((scenario.weather as Entity | undefined)?.forecast?.decisionDayHorizonEnd);
    const campaignEnd = stringValue((scenario.clock as Entity | undefined)?.campaignEnd);
    const persistence = stringValue((scenario.weather as Entity | undefined)?.seasonalOutlook?.persistenceProbability);
    const failures: string[] = [];
    // Disclosure is deliberately absent now, so the posture that remains is
    // honesty about the horizon and about what has actually been approved.
    if (DISCLOSURE_MARKER.test(instructions)) {
      failures.push('still instructs the agent to label evidence as synthetic or reference the session code');
    }
    if (horizonEnd && !instructions.includes(horizonEnd)) failures.push(`does not state the forecast horizon ${horizonEnd}`);
    if (campaignEnd && !instructions.includes(campaignEnd)) failures.push(`does not state the campaign end ${campaignEnd}`);
    if (!/approv/i.test(instructions)) failures.push('does not address approval posture');
    if (!/not\s+(yet\s+)?(been\s+)?approved|recommend/i.test(instructions)) {
      failures.push('does not require distinguishing a recommendation from an approved decision');
    }
    if (persistence && !instructions.includes(persistence)) failures.push(`does not carry the ${persistence} persistence probability`);
    if (failures.length > 0) throw new Error(sample(failures));
    return `${instructions.length.toLocaleString('en-US')} characters covering horizon ${horizonEnd}, campaign end ${campaignEnd}, approval posture and persistence ${persistence}`;
  });

  runCheck(group, 'selected lakehouse elements exist as generated tables', () => {
    const lakehouse = dataSources.find((source) => stringValue(source.artifactType) === 'Lakehouse');
    if (!lakehouse) throw new Error('no Lakehouse entry declared');
    const failures = [...generatedTables.errors];
    const selected = asArray(lakehouse.selectedElements).map((element) => stringValue(element));
    if (selected.length === 0) throw new Error('no selected elements; the agent would see every table');
    for (const element of selected) {
      if (!generatedTables.tables.has(element)) failures.push(`'${element}' has no generated CSV`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${selected.length} lakehouse tables resolve`;
  });

  runCheck(group, 'selected semantic model elements exist in the model', () => {
    const model = dataSources.find((source) => stringValue(source.artifactType) === 'SemanticModel');
    if (!model) throw new Error('no SemanticModel entry declared');
    const selected = asArray(model.selectedElements).map((element) => stringValue(element));
    if (selected.length === 0) throw new Error('no selected elements; the agent would see every table');
    const tableNames = new Set(semanticTables(semanticModelObject(semanticState)).map((table) => stringValue(table.name)));
    const failures = selected.filter((element) => !tableNames.has(element)).map((element) => `'${element}' is not a model table`);
    if (failures.length > 0) throw new Error(sample(failures));
    return `${selected.length} semantic model tables resolve`;
  });
}

/**
 * The payload must read like a real enterprise estate. Disclosure lives in the
 * deck, the presenter guide and the repository documentation; a grounded agent
 * quotes whatever it reads, so a label inside the data ends up inside its
 * answers. This scans every deployable payload file, which is the only way to
 * stop the labels creeping back one column at a time.
 */
async function runPayloadCleanlinessChecks(): Promise<void> {
  const group = 'Payload realism';
  const offenders: string[] = [];
  let scanned = 0;

  for (const relativePath of EXPECTED_PAYLOAD_FILES) {
    // scenario.json is a build input, not something an agent grounds on, and it
    // should stay honest about what this dataset is. The disclosure it carries is
    // the repository describing itself, not a label inside the estate.
    if (relativePath === 'scenario.json') continue;
    const found = await resolveLogicalFile(relativePath);
    if (!found) continue;
    scanned += 1;
    let lineNumber = 0;
    try {
      const reader = createInterface({ input: createTransparentReadStream(found.absolutePath), crlfDelay: Infinity });
      for await (const line of reader) {
        lineNumber += 1;
        const match = line.match(DISCLOSURE_MARKER);
        if (match) {
          pushSample(offenders, `${relativePath}:${lineNumber} contains '${match[0]}'`);
          break; // one report per file is enough to act on
        }
      }
    } catch (error) {
      pushSample(offenders, `${relativePath}: ${errorMessage(error)}`);
    }
  }

  runCheck(group, 'no payload file carries disclosure labelling', () => {
    if (offenders.length > 0) throw new Error(sample(offenders));
    return `${scanned} payload files scanned, none mention synthetic/BRK390/LTG243/fictional/simulated`;
  });
}

/**
 * The dataset is a snapshot taken on scenario.clock.asOf, and the Act 2 demo only
 * works if the decision is genuinely still open. These checks encode both: that
 * observed facts stop at the boundary, and that nothing has been approved,
 * actioned or resolved yet for the hero case. The eight historical cases are
 * deliberately exempt - they are what Demo 5 reuses.
 */
async function runAsOfBoundaryChecks(scenario: Entity): Promise<void> {
  const group = 'As-of boundary';
  const clock = (scenario.clock ?? {}) as Entity;
  const asOf = stringValue(clock.asOf) || stringValue(clock.decisionDay);

  runCheck(group, 'scenario declares an as-of boundary', () => {
    if (!asOf) throw new Error('scenario.clock.asOf is missing');
    if (asOf !== stringValue(clock.decisionDay)) {
      throw new Error(`asOf ${asOf} does not match decisionDay ${stringValue(clock.decisionDay)}`);
    }
    return `as of ${asOf} (${stringValue(clock.decisionDayWeekday)})`;
  });

  // Observed series only. Plans, schedules and issued forecasts legitimately
  // look forward, so they are not listed here.
  const observedSeries: { file: string; column: string }[] = [
    { file: 'fabric-sql/sales_order_lines.csv', column: 'orderDate' },
    { file: 'eventhouse/ForecastActualDaily.csv', column: 'timestamp' },
    { file: 'eventhouse/InventorySnapshots.csv', column: 'timestamp' },
    { file: 'eventhouse/LineSignals.csv', column: 'timestamp' },
    { file: 'eventhouse/WeatherObservationsDaily.csv', column: 'timestamp' },
    { file: 'eventhouse/ClimateSignalObservations.csv', column: 'timestamp' },
  ];

  for (const series of observedSeries) {
    const found = await resolveLogicalFile(series.file);
    if (!found) continue;
    let latest = '';
    let rows = 0;
    let columnIndex = -1;
    try {
      const reader = createInterface({ input: createTransparentReadStream(found.absolutePath), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const rawLine of reader) {
        lineNumber += 1;
        const parsed = parseCsvLine(lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine);
        if (!parsed.ok) continue;
        if (lineNumber === 1) {
          columnIndex = parsed.values.findIndex((name) => normalizeKey(name) === normalizeKey(series.column));
          continue;
        }
        if (columnIndex < 0) break;
        rows += 1;
        const value = (parsed.values[columnIndex] ?? '').slice(0, 10);
        if (value > latest) latest = value;
      }
    } catch {
      // structure checks already report unreadable files
    }
    runCheck(group, `${series.file} stops at the as-of boundary`, () => {
      if (columnIndex < 0) throw new Error(`no '${series.column}' column found`);
      if (rows === 0) throw new Error('no data rows');
      if (isOutcomeSlice()) {
        // The reveal deliberately runs past the decision; what matters is that it
        // actually does, otherwise it is not revealing anything.
        if (latest <= asOf) throw new Error(`outcome slice latest ${series.column} is ${latest}, no later than as-of ${asOf}`);
        return `${rows.toLocaleString('en-US')} rows, extends to ${latest} (outcome slice)`;
      }
      if (latest > asOf) throw new Error(`latest ${series.column} is ${latest}, after as-of ${asOf}`);
      return `${rows.toLocaleString('en-US')} rows, latest ${latest}`;
    });
  }

  const [scenarios, commitments, campaigns, actions, receipts, cases, outcomes] = await Promise.all([
    readEvidenceCsvRows('fabric-sql/campaign_scenarios.csv'),
    readEvidenceCsvRows('fabric-sql/campaign_commitments.csv'),
    readEvidenceCsvRows('fabric-sql/campaigns.csv'),
    readEvidenceCsvRows('fabric-sql/governed_actions.csv'),
    readEvidenceCsvRows('fabric-sql/action_receipts.csv'),
    readEvidenceCsvRows('fabric-sql/decision_cases.csv'),
    readEvidenceCsvRows('fabric-sql/decision_outcomes.csv'),
  ]);

  runCheck(group, 'the campaign decision is still open', () => {
    const approved = scenarios.rows.filter((row) => ['true', '1', 'yes'].includes(stringValue(row.approved).toLowerCase()));
    const allocated = campaigns.rows.filter((row) => Number(row.incrementalBudgetUsd || 0) > 0);
    const failures: string[] = [];

    if (isOutcomeSlice()) {
      // In the reveal the decision has been taken, so the opposite must hold.
      if (approved.length !== 1) failures.push(`expected exactly one approved scenario, found ${approved.length}`);
      if (commitments.rows.length !== 1) failures.push(`expected exactly one commitment, found ${commitments.rows.length}`);
      if (allocated.length === 0) failures.push('no campaign carries an incremental budget after approval');
      if (actions.rows.length === 0) failures.push('no governed actions were executed after approval');
      if (receipts.rows.length !== actions.rows.length) {
        failures.push(`${actions.rows.length} governed actions but ${receipts.rows.length} receipts`);
      }
      if (failures.length > 0) throw new Error(sample(failures));
      return `outcome slice: ${stringValue(approved[0]?.scenarioId)} approved, ${commitments.rows.length} commitment, ${actions.rows.length} actions with receipts`;
    }

    if (approved.length > 0) {
      failures.push(`${approved.length} campaign scenario(s) already approved: ${approved.map((row) => stringValue(row.scenarioId)).join(', ')}`);
    }
    if (commitments.rows.length > 0) {
      failures.push(`${commitments.rows.length} campaign commitment row(s) exist; the decision has already been taken`);
    }
    if (allocated.length > 0) {
      failures.push(`${allocated.length} campaign(s) already carry an incremental budget; allocating it is the decision`);
    }
    if (actions.rows.length > 0) {
      failures.push(`${actions.rows.length} governed action(s) exist; nothing should have been actioned yet`);
    }
    if (receipts.rows.length > 0) failures.push(`${receipts.rows.length} action receipt(s) exist`);
    if (failures.length > 0) throw new Error(sample(failures));
    const recommended = scenarios.rows.filter((row) => ['true', '1', 'yes'].includes(stringValue(row.recommended).toLowerCase()));
    return `${scenarios.rows.length} scenarios, ${recommended.length} recommended, none approved, no commitment, no governed actions`;
  });

  runCheck(group, 'the hero case is open while historical cases stay resolved', () => {
    if (cases.error) throw new Error(cases.error);
    const heroId = stringValue((scenario.decisionCase as Entity | undefined)?.caseId);
    if (!heroId) throw new Error('scenario.decisionCase.caseId is missing');
    const hero = cases.rows.find((row) => stringValue(row.caseId) === heroId);
    if (!hero) throw new Error(`hero case ${heroId} not found in decision_cases.csv`);
    const failures: string[] = [];
    const heroOutcomes = outcomes.rows.filter((row) => stringValue(row.caseId) === heroId);

    if (isOutcomeSlice()) {
      if (stringValue(hero.status) !== 'resolved') failures.push(`${heroId} should be resolved in the outcome slice`);
      if (stringValue(hero.resolvedAt) === '') failures.push(`${heroId} has no resolvedAt in the outcome slice`);
      if (heroOutcomes.length === 0) failures.push(`${heroId} has no recorded outcomes in the outcome slice`);
    } else {
      if (stringValue(hero.status) === 'resolved') failures.push(`${heroId} is resolved; it should still be open`);
      if (stringValue(hero.resolvedAt) !== '') failures.push(`${heroId} has resolvedAt=${stringValue(hero.resolvedAt)}`);
      if (stringValue(hero.commitmentId) !== '') failures.push(`${heroId} already points at commitment ${stringValue(hero.commitmentId)}`);
      if (heroOutcomes.length > 0) failures.push(`${heroId} already has ${heroOutcomes.length} recorded outcome(s)`);
    }

    const historical = cases.rows.filter((row) => stringValue(row.caseId) !== heroId);
    const unresolved = historical.filter((row) => stringValue(row.status) !== 'resolved');
    if (historical.length === 0) failures.push('no historical cases remain; Demo 5 has nothing to reuse');
    if (unresolved.length > 0) {
      failures.push(`${unresolved.length} historical case(s) are not resolved: ${unresolved.map((row) => stringValue(row.caseId)).join(', ')}`);
    }
    for (const row of historical) {
      const openedAt = stringValue(row.openedAt).slice(0, 10);
      if (openedAt && openedAt > asOf) failures.push(`${stringValue(row.caseId)} opens at ${openedAt}, after as-of ${asOf}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${heroId} open, ${historical.length} historical cases resolved`;
  });
}

/**
 * Whether the payload on disk is the post-decision reveal slice. The default
 * dataset stops at the decision, so checks that assert on the commitment, the
 * executed actions or the recorded outcomes only apply to the reveal. Detected
 * from the data itself rather than a flag, so validating a directory always
 * asks the right questions of whatever is actually there.
 */
let outcomeSliceDetected = false;

function isOutcomeSlice(): boolean {
  return outcomeSliceDetected;
}

async function detectOutcomeSlice(): Promise<void> {
  const commitments = await readEvidenceCsvRows('fabric-sql/campaign_commitments.csv');
  outcomeSliceDetected = commitments.rows.length > 0;
}

function printResults(quiet: boolean, verbose: boolean): void {
  const visibleResults = quiet ? results.filter((result) => result.status === 'failed') : results;
  let currentGroup = '';
  for (const result of visibleResults) {
    if (result.group !== currentGroup) {
      if (currentGroup !== '') console.log('');
      currentGroup = result.group;
      console.log(`${currentGroup}:`);
    }
    const marker = result.status === 'passed' ? 'PASS' : 'FAIL';
    const detail = result.detail && (verbose || result.status === 'failed') ? ` - ${result.detail}` : '';
    console.log(`  ${marker} ${result.name}${detail}`);
  }
  if (visibleResults.length > 0) console.log('');
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  console.log(`${passed} passed, ${failed} failed`);
}

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const verbose = process.argv.includes('--verbose');

  const scenarioJson = await parseJsonFile('scenario.json');
  await detectOutcomeSlice();
  const questionsJson = await parseJsonFile('evaluation/questions.json');
  const expectedResultsJson = await parseJsonFile('evaluation/expected-results.json');
  const receiptsJson = await parseJsonFile('receipts/action-receipts.json');
  const weatherProviderJson = await parseJsonFile('lakehouse/external-signals/weather-provider.json', 'Weather structure');
  const scenario = isPlainObject(scenarioJson) ? scenarioJson : {};
  const questions = questionsJson;
  const expectedFacts = expectedFactTargets(questions);
  markExpectedFactsInValue(scenarioJson, 'scenario.json', expectedFacts);
  markExpectedFactsInValue(questionsJson, 'evaluation/questions.json', expectedFacts);
  markExpectedFactsInValue(expectedResultsJson, 'evaluation/expected-results.json', expectedFacts);
  markExpectedFactsInValue(receiptsJson, 'receipts/action-receipts.json', expectedFacts);
  markExpectedFactsInValue(weatherProviderJson, 'lakehouse/external-signals/weather-provider.json', expectedFacts);

  const references = makeReferenceMap();
  const occurrences = makeOccurrenceMap();
  const primaryKeyTrackers = initializePrimaryKeyTrackers();
  const fkTrackers = initializeFkTrackers();
  const receiptJsonIds = new Set<string>();
  const governedActions: Entity[] = [];
  const csvPersonaLeaks: string[] = [];
  const jsonPersonaLeaks: string[] = [];
  const approvalViolations: string[] = [];
  const personalHeaderViolations: string[] = [];
  const externalSignalLabelViolations: string[] = [];
  const retrievalChunkIds = new Set<string>();
  const retrievalProbeExpectations: { probeId: string; caseId: string; chunkIds: string[]; location: string }[] = [];
  const weatherState = makeWeatherValidationState();
  const csvParseResults = new Map<string, { ok: boolean; rows: number; header: string[] }>();
  const decisionRows = new Map<string, CsvRow[]>();
  const governedActionIds = new Set<string>();
  const actionReceiptIds = new Set<string>();
  const approvedPolicyKeys = new Set<string>();

  const regions = asArray(scenario.regions);
  const regionsById = new Map(regions.map((region) => [String(region.regionId), region]));
  const knownRegionIds = new Set(regions.map((region) => stringValue(region.regionId)).filter(Boolean));
  const heroProductId = stringValue(scenario.heroProductId);
  const windowStart = stringValue(scenario.clock?.varianceWindowStart);
  const windowEnd = stringValue(scenario.clock?.varianceWindowEnd);
  const campaignStart = stringValue(scenario.clock?.campaignStart);
  const launchPlanStart = stringValue(scenario.launchPlan?.startsOn);
  const campaignEnd = stringValue(scenario.clock?.campaignEnd);
  const operatingDays = Array.isArray(scenario.clock?.operatingDays) ? scenario.clock.operatingDays.map(Number) : [];
  const affectedRegionIds = new Set(Array.isArray(scenario.externalSignal?.affectedRegionIds) ? scenario.externalSignal.affectedRegionIds.map(String) : []);
  const unaffectedRegionIds = new Set(
    Array.isArray(scenario.externalSignal?.unaffectedRegionIds) ? scenario.externalSignal.unaffectedRegionIds.map(String) : [],
  );
  const personaNamesLower = asArray(scenario.personas)
    .map((persona) => stringValue(persona.displayName).toLowerCase())
    .filter(Boolean);
  const roleIds = new Set(Array.isArray(scenario.approverRoles) ? scenario.approverRoles.map(String) : []);
  const recommendedOption = asArray(scenario.options).find((option) => option.optionId === scenario.recommendedOptionId) ?? {};
  const maintenance = isPlainObject(scenario.maintenance) ? scenario.maintenance : {};
  const capacityModel = isPlainObject(scenario.capacityModel) ? scenario.capacityModel : {};
  const stressModel = isPlainObject(scenario.stressModel) ? scenario.stressModel : {};

  addScenarioReferences(scenario, references);
  addReceiptReferencesFromJson(receiptsJson, references);
  collectReferencesFromReceiptsJson(receiptsJson, references, receiptJsonIds);
  seedGovernedActionsFromScenario(scenario, governedActions);
  scanJsonIdentifiers(scenarioJson, 'scenario.json', null, occurrences);

  const salesVarianceUnits = new Map<string, number>();
  const salesObservationVarianceUnits = new Map<string, number>();
  const campaignTelemetry = new Map<string, { spendUsd: number; attributedUnits: number; revenueUsd: number }>();
  // Hero units sold per region across the launch plan's observed days, which is
  // the only window an attribution share can honestly be compared against.
  const heroUnitsInPlanWindow = new Map<string, number>();
  const capacityAggregates = {
    baselineIncludingMaintenance: 0,
    baselineExcludingMaintenance: 0,
    approvedTotal: 0,
    baselineRows: 0,
    approvedRows: 0,
  };
  const maintenancePolicyRows = new Map<string, CsvRow>();
  const lineSignals = {
    rowsForLine: 0,
    peakStress: Number.NEGATIVE_INFINITY,
    peakStressAt: '',
    rateUtilisationViolations: [] as string[],
    maintenanceOutsideDeferred: [] as string[],
    maintenanceInDeferredRows: 0,
  };
  const climate = {
    rows: 0,
    affectedRows: 0,
    unaffectedRows: 0,
    minAffectedAnomaly: Number.POSITIVE_INFINITY,
    maxUnaffectedAbsAnomaly: 0,
    labelViolations: [] as string[],
  };

  const decisionMemoryCsvFiles = sorted(new Set([...DECISION_MEMORY_CSV_FILES, ...(await listDecisionMemoryCsvFiles())]));
  const decisionMemoryCsvFileSet = new Set(decisionMemoryCsvFiles);
  const csvFilesToRead = [...CSV_FILES, ...decisionMemoryCsvFiles.filter((file) => !CSV_FILES.includes(file))];
  const expectedPayloadFiles = sorted(new Set([...EXPECTED_PAYLOAD_FILES, ...decisionMemoryCsvFiles]));

  for (const expectedPath of expectedPayloadFiles) {
    const found = await resolveLogicalFile(expectedPath);
    if (found) pass('Structure', `${expectedPath} exists`, found.compressed ? `found ${found.relativePath}` : 'found');
    else fail('Structure', `${expectedPath} exists`, `Missing file (checked ${expectedPath}${expectedPath.endsWith('.csv') || expectedPath.endsWith('.jsonl') ? ` and ${expectedPath}.gz` : ''})`);
  }

  for (const relativePath of csvFilesToRead) {
    const csvResult = await streamCsv(relativePath, {
      onHeader: (header) => {
        scanCsvHeadersForPersonalFields(relativePath, header, personalHeaderViolations);
        if (WEATHER_CSV_FILE_SET.has(relativePath)) {
          weatherState.csvHeaders.set(relativePath, header);
          recordWeatherCsvDisclosureHeader(relativePath, header, weatherState);
        }
      },
      onRow: (row, context) => {
        addReferenceFromCsvRow(relativePath, row, references);
        updatePrimaryKeyTracker(relativePath, row, context.lineNumber, primaryKeyTrackers);
        updateFkTrackers(relativePath, row, context.lineNumber, fkTrackers);
        scanCsvIdentifiers(row, `${relativePath}:${context.lineNumber}`, occurrences);
        scanCsvSafety(relativePath, row, context.lineNumber, personaNamesLower, csvPersonaLeaks, approvalViolations);
        for (const [column, value] of Object.entries(row)) markExpectedFactsInPrimitive(value, `${relativePath}:${context.lineNumber}.${column}`, expectedFacts);
        if (decisionMemoryCsvFileSet.has(relativePath)) {
          const rows = decisionRows.get(relativePath) ?? [];
          rows.push(row);
          decisionRows.set(relativePath, rows);
        }
        if (relativePath === 'fabric-sql/governed_actions.csv') governedActionIds.add(row.actionId);
        if (relativePath === 'fabric-sql/action_receipts.csv') actionReceiptIds.add(row.receiptId);
        if (relativePath === 'fabric-sql/approved_policies.csv') approvedPolicyKeys.add(policyKey(row.policyId, row.policyVersion));
        if (WEATHER_CSV_FILE_SET.has(relativePath)) {
          collectWeatherCsvRow(relativePath, row, context.lineNumber, scenario, knownRegionIds, unaffectedRegionIds, weatherState);
        }

        if (relativePath === 'fabric-sql/sales_order_lines.csv') {
          if (row.productId === heroProductId && isBetweenDate(row.orderDate, windowStart, windowEnd)) {
            salesVarianceUnits.set(row.regionId, (salesVarianceUnits.get(row.regionId) ?? 0) + numericValue(row.units));
          }
          if (row.productId === heroProductId && row.orderDate >= launchPlanStart) {
            heroUnitsInPlanWindow.set(row.regionId, (heroUnitsInPlanWindow.get(row.regionId) ?? 0) + numericValue(row.units));
          }
        } else if (relativePath === 'eventhouse/SalesObservations.csv') {
          const dateKey = dateKeyFromTimestamp(row.timestamp);
          if (row.productId === heroProductId && isBetweenDate(dateKey, windowStart, windowEnd)) {
            salesObservationVarianceUnits.set(row.regionId, (salesObservationVarianceUnits.get(row.regionId) ?? 0) + numericValue(row.units));
          }
        } else if (relativePath === 'eventhouse/CampaignSignals.csv') {
          const totals = campaignTelemetry.get(row.campaignId) ?? { spendUsd: 0, attributedUnits: 0, revenueUsd: 0 };
          totals.spendUsd += numericValue(row.spendUsd);
          totals.attributedUnits += numericValue(row.attributedUnits);
          totals.revenueUsd += numericValue(row.revenueUsd);
          campaignTelemetry.set(row.campaignId, totals);
        } else if (relativePath === 'fabric-sql/capacity_plan.csv') {
          const dateKey = row.planDate;
          const inCampaign = isBetweenDate(dateKey, campaignStart, campaignEnd);
          const operating = operatingDays.length > 0 && isOperatingDay(parseDate(dateKey), operatingDays);
          if (row.lineId === stringValue(capacityModel.lineId) && inCampaign && operating) {
            const units = numericValue(row.plannedUnits);
            if (row.planVariant === 'baseline') {
              capacityAggregates.baselineRows += 1;
              capacityAggregates.baselineIncludingMaintenance += units;
              if (!boolValue(row.isMaintenanceDay)) capacityAggregates.baselineExcludingMaintenance += units;
            } else if (row.planVariant === 'approved') {
              capacityAggregates.approvedRows += 1;
              capacityAggregates.approvedTotal += units;
            }
          }
        } else if (relativePath === 'fabric-sql/maintenance_policy_evaluations.csv') {
          maintenancePolicyRows.set(row.optionId, row);
        } else if (relativePath === 'eventhouse/LineSignals.csv') {
          if (row.lineId === stringValue(capacityModel.lineId)) {
            lineSignals.rowsForLine += 1;
            const dateKey = dateKeyFromTimestamp(row.timestamp);
            const stress = numericValue(row.cumulativeStressIndex);
            if (stress > lineSignals.peakStress) {
              lineSignals.peakStress = stress;
              lineSignals.peakStressAt = row.timestamp;
            }
            const producing = boolValue(row.producing);
            if (row.state === 'maintenance') {
              if (isBetweenDate(dateKey, stringValue(maintenance.deferredStart), stringValue(maintenance.deferredEnd))) {
                lineSignals.maintenanceInDeferredRows += 1;
              } else {
                pushSample(lineSignals.maintenanceOutsideDeferred, `${row.timestamp} state=maintenance outside deferred window`);
              }
            } else if (dateKey < campaignStart) {
              if (!approxEqual(numericValue(row.rateFactor), numericValue(capacityModel.baselineRateFactor), 0.001)) {
                pushSample(lineSignals.rateUtilisationViolations, `${row.timestamp} rateFactor=${row.rateFactor}, expected ${capacityModel.baselineRateFactor}`);
              }
              if (producing && !approxEqual(numericValue(row.utilisation), numericValue(capacityModel.baselineUtilisation), 0.001)) {
                pushSample(lineSignals.rateUtilisationViolations, `${row.timestamp} utilisation=${row.utilisation}, expected ${capacityModel.baselineUtilisation}`);
              }
            } else if (isBetweenDate(dateKey, campaignStart, stringValue(recommendedOption.appliesTo))) {
              if (!approxEqual(numericValue(row.rateFactor), numericValue(capacityModel.planRateFactor), 0.001)) {
                pushSample(lineSignals.rateUtilisationViolations, `${row.timestamp} rateFactor=${row.rateFactor}, expected ${capacityModel.planRateFactor}`);
              }
              if (producing && !approxEqual(numericValue(row.utilisation), numericValue(capacityModel.planUtilisation), 0.001)) {
                pushSample(lineSignals.rateUtilisationViolations, `${row.timestamp} utilisation=${row.utilisation}, expected ${capacityModel.planUtilisation}`);
              }
            }
          }
        } else if (relativePath === 'eventhouse/ClimateSignalObservations.csv') {
          climate.rows += 1;
          if (row.provenance !== 'external') {
            pushSample(climate.labelViolations, `${relativePath}:${context.lineNumber} provenance=${row.provenance}, expected external`);
          }
          if (Object.prototype.hasOwnProperty.call(row, 'syntheticEvidence')) {
            pushSample(climate.labelViolations, `${relativePath}:${context.lineNumber} still has a syntheticEvidence column`);
          }
          const anomaly = numericValue(row.anomalyVsBaselineC);
          if (affectedRegionIds.has(row.regionId)) {
            climate.affectedRows += 1;
            climate.minAffectedAnomaly = Math.min(climate.minAffectedAnomaly, anomaly);
          } else if (unaffectedRegionIds.has(row.regionId)) {
            climate.unaffectedRows += 1;
            climate.maxUnaffectedAbsAnomaly = Math.max(climate.maxUnaffectedAbsAnomaly, Math.abs(anomaly));
          }
        } else if (relativePath === 'fabric-sql/external_signals.csv') {
          if (isBlank(row.sourceLabel) || isBlank(row.provenance)) {
            pushSample(
              externalSignalLabelViolations,
              `${relativePath}:${context.lineNumber} provenance=${row.provenance} sourceLabel=${row.sourceLabel ? 'present' : 'missing'}`,
            );
          } else if (DISCLOSURE_MARKER.test(stringValue(row.sourceLabel))) {
            pushSample(
              externalSignalLabelViolations,
              `${relativePath}:${context.lineNumber} sourceLabel still carries disclosure text`,
            );
          }
          if (Object.prototype.hasOwnProperty.call(row, 'syntheticEvidence')) {
            pushSample(externalSignalLabelViolations, `${relativePath}:${context.lineNumber} still has a syntheticEvidence column`);
          }
        } else if (relativePath === 'fabric-sql/governed_actions.csv') {
          governedActions.push({
            actionId: row.actionId,
            role: row.approvedByRole,
            receiptId: row.receiptId,
            location: `${relativePath}:${context.lineNumber}`,
          });
        }
      },
    });
    csvParseResults.set(relativePath, csvResult);
    if (WEATHER_CSV_FILE_SET.has(relativePath)) {
      weatherState.csvRowCounts.set(relativePath, csvResult.rows);
      if (!weatherState.csvHeaders.has(relativePath) && csvResult.header.length > 0) weatherState.csvHeaders.set(relativePath, csvResult.header);
    }
  }

  for (const relativePath of JSONL_FILES) {
    const jsonlResult = await streamJsonl(relativePath, (record, context) => {
      scanJsonIdentifiers(record, `${relativePath}:${context.lineNumber}`, null, occurrences);
      scanJsonSafety(record, `${relativePath}:${context.lineNumber}`, null, personaNamesLower, jsonPersonaLeaks, approvalViolations);
      markExpectedFactsInValue(record, `${relativePath}:${context.lineNumber}`, expectedFacts);
      collectJsonlReferences(relativePath, record, context.lineNumber, references);
      collectGovernedActionsFromJsonl(relativePath, record, context.lineNumber, governedActions);
      collectRetrievalProbeData(relativePath, record, retrievalChunkIds, retrievalProbeExpectations);
      if (WEATHER_JSONL_FILE_SET.has(relativePath)) {
        collectWeatherJsonlRecord(relativePath, record, context.lineNumber, scenario, knownRegionIds, unaffectedRegionIds, weatherState);
      }
      if (relativePath === 'lakehouse/external-signals/climate-advisories.jsonl' && isPlainObject(record)) {
        if (isBlank(record.sourceLabel) || isBlank(record.provenance)) {
          pushSample(
            externalSignalLabelViolations,
            `${relativePath}:${context.lineNumber} provenance=${stringValue(record.provenance) || 'missing'} sourceLabel=${isBlank(record.sourceLabel) ? 'missing' : 'present'}`,
          );
        } else if (DISCLOSURE_MARKER.test(stringValue(record.sourceLabel))) {
          pushSample(externalSignalLabelViolations, `${relativePath}:${context.lineNumber} sourceLabel still carries disclosure text`);
        }
        if (Object.prototype.hasOwnProperty.call(record, 'syntheticEvidence')) {
          pushSample(externalSignalLabelViolations, `${relativePath}:${context.lineNumber} still has a syntheticEvidence field`);
        }
      }
    });
    if (WEATHER_JSONL_FILE_SET.has(relativePath)) weatherState.jsonlRowCounts.set(relativePath, jsonlResult.rows);
  }

  scanJsonIdentifiers(receiptsJson, 'receipts/action-receipts.json', null, occurrences);
  if (isPlainObject(weatherProviderJson)) {
    scanJsonIdentifiers(weatherProviderJson, 'lakehouse/external-signals/weather-provider.json', null, occurrences);
    scanJsonSafety(weatherProviderJson, 'lakehouse/external-signals/weather-provider.json', null, personaNamesLower, jsonPersonaLeaks, approvalViolations);
    recordWeatherJsonDisclosure('lakehouse/external-signals/weather-provider.json', weatherProviderJson, 'lakehouse/external-signals/weather-provider.json', weatherState);
  }
  const weatherStaticText = new Map<string, string>();
  for (const relativePath of WEATHER_STATIC_FILES) {
    const text = await readRequiredTextFile('Weather structure', `${relativePath} is readable`, relativePath);
    if (text !== null) weatherStaticText.set(relativePath, text);
  }
  runWeatherChecks(scenario, regions, knownRegionIds, affectedRegionIds, unaffectedRegionIds, weatherState, weatherStaticText);
  const generatedTables = await collectGeneratedTables();
  runOntologyChecks(await loadOntologyState(), generatedTables);
  const semanticModelState = await loadSemanticModelState();
  runSemanticModelChecks(semanticModelState, generatedTables);
  runDecisionMemoryChecks(scenario, decisionMemoryCsvFiles, csvParseResults, decisionRows, governedActionIds, actionReceiptIds, approvedPolicyKeys, personaNamesLower);
  await runAgentEvidenceChecks(scenario, knownRegionIds);
  await runDataAgentChecks(scenario, generatedTables, semanticModelState);
  await runPayloadCleanlinessChecks();
  await runAsOfBoundaryChecks(scenario);

  runCheck('Referential integrity', 'scenario reference ids are unique', () => {
    const failures = collectScenarioUniquenessFailures(scenario);
    if (failures.length > 0) throw new Error(sample(failures));
    return 'scenario reference ids are unique';
  });

  for (const [file, tracker] of primaryKeyTrackers.entries()) {
    runCheck('Referential integrity', `${file} primary key is unique`, () => {
      const failures = [...tracker.blanks, ...tracker.duplicates];
      if (failures.length > 0) throw new Error(sample(failures));
      return `${tracker.rows.toLocaleString('en-US')} keys checked (${tracker.columns.join(', ')})`;
    });
  }

  for (const kind of BROAD_REFERENTIAL_KINDS) {
    runCheck('Referential integrity', `all ${ID_KIND_LABELS[kind]} values resolve`, () => {
      const missing: string[] = [];
      for (const [value, locations] of occurrences.get(kind)?.entries() ?? []) {
        if (!hasReference(references, kind, value)) {
          pushSample(missing, `${ID_KIND_LABELS[kind]} '${value}' at ${locations[0]}`);
        }
      }
      if (missing.length > 0) throw new Error(sample(missing));
      return `${occurrences.get(kind)?.size ?? 0} distinct values checked`;
    });
  }

  const fkFailuresByTable = new Map<string, string[]>();
  for (const tracker of fkTrackers.values()) {
    const failures: string[] = [];
    for (const [value, locations] of tracker.values.entries()) {
      if (!hasReference(references, tracker.rule.refKind, value)) {
        pushSample(failures, `${tracker.rule.label} '${value}' at ${locations[0]}`);
      }
    }
    if (failures.length > 0) {
      const tableFailures = fkFailuresByTable.get(tracker.rule.file) ?? [];
      tableFailures.push(...failures);
      fkFailuresByTable.set(tracker.rule.file, tableFailures);
    }
  }
  for (const table of ['fabric-sql/sales_order_lines.csv', 'fabric-sql/production_orders.csv', 'fabric-sql/material_reservations.csv', 'fabric-sql/inventory_positions.csv', 'fabric-sql/capacity_plan.csv', 'fabric-sql/forecast_lines.csv']) {
    runCheck('Referential integrity', `${table} has no orphan foreign keys`, () => {
      const failures = fkFailuresByTable.get(table) ?? [];
      if (failures.length > 0) throw new Error(sample(failures));
      return 'all tracked foreign keys resolve';
    });
  }

  runCheck('Narrative invariants', 'sales_order_lines hero-product variance matches scenario', () => {
    validateVarianceFromUnits(regions, salesVarianceUnits, scenario);
    return varianceDetail(regions, salesVarianceUnits, scenario);
  });

  runCheck('Narrative invariants', 'SalesObservations hero-product variance matches scenario', () => {
    validateVarianceFromUnits(regions, salesObservationVarianceUnits, scenario);
    return varianceDetail(regions, salesObservationVarianceUnits, scenario);
  });

  runCheck('Narrative invariants', 'signal-affected region split matches scenario', () => {
    const affectedFromRegions = new Set(regions.filter((region) => boolValue(region.signalAffected)).map((region) => stringValue(region.regionId)));
    const unaffectedFromRegions = regions.filter((region) => !boolValue(region.signalAffected)).map((region) => stringValue(region.regionId));
    if (affectedFromRegions.size !== 4 || unaffectedFromRegions.length !== 2) {
      throw new Error(`found ${affectedFromRegions.size} signalAffected regions and ${unaffectedFromRegions.length} unaffected regions`);
    }
    if (!setEquals(affectedFromRegions, affectedRegionIds)) {
      throw new Error(`affected set ${sorted(affectedFromRegions).join(', ')} does not equal externalSignal.affectedRegionIds ${sorted(affectedRegionIds).join(', ')}`);
    }
    return `${sorted(affectedFromRegions).join(', ')} affected; ${unaffectedFromRegions.sort().join(', ')} unaffected`;
  });

  runCheck('Narrative invariants', 'campaign telemetry covers the launch plan it runs under', () => {
    // A regression once gated campaign telemetry on clock.campaignStart/End --
    // the *proposed* incremental campaign -- rather than the launch plan the
    // campaigns actually run under. The window fell entirely after the as-of
    // boundary, so every metric silently became zero and no check noticed.
    const planStart = stringValue(scenario.launchPlan?.startsOn);
    const planEnd = stringValue(scenario.launchPlan?.endsOn);
    const observedEnd = stringValue(scenario.clock.asOf);
    const planIsObserved = planStart <= observedEnd;

    if (!planIsObserved) {
      for (const [campaignId, totals] of campaignTelemetry) {
        if (totals.spendUsd !== 0 || totals.attributedUnits !== 0) {
          throw new Error(`${campaignId} reports telemetry although launch plan starts ${planStart}, after the as-of boundary ${observedEnd}`);
        }
      }
      return `launch plan starts ${planStart}, after as-of ${observedEnd}; telemetry correctly empty`;
    }

    const silent: string[] = [];
    for (const campaign of asArray(scenario.campaigns)) {
      const campaignId = stringValue(campaign.campaignId);
      const totals = campaignTelemetry.get(campaignId);
      if (!totals || totals.spendUsd <= 0 || totals.attributedUnits <= 0 || totals.revenueUsd <= 0) {
        silent.push(campaignId);
      }
    }
    if (silent.length > 0) {
      throw new Error(
        `launch plan ${planStart}..${planEnd} overlaps the observed window ending ${observedEnd}, so every campaign must report telemetry; silent: ${silent.join(', ')}`,
      );
    }

    const spend = [...campaignTelemetry.values()].reduce((sum, totals) => sum + totals.spendUsd, 0);
    const units = [...campaignTelemetry.values()].reduce((sum, totals) => sum + totals.attributedUnits, 0);
    return `${campaignTelemetry.size} campaigns report ${Math.round(spend).toLocaleString('en-US')} USD spend and ${units.toLocaleString('en-US')} attributed units`;
  });

  runCheck('Narrative invariants', 'campaign attribution stays below observed sales', () => {
    // Attribution is a share of baseline demand, so a campaign must never be
    // credited with more units than its region actually sold.
    const offenders: string[] = [];
    for (const campaign of asArray(scenario.campaigns)) {
      const campaignId = stringValue(campaign.campaignId);
      const regionId = stringValue(campaign.regionId);
      const attributed = campaignTelemetry.get(campaignId)?.attributedUnits ?? 0;
      const sold = heroUnitsInPlanWindow.get(regionId) ?? 0;
      if (attributed > 0 && sold > 0 && attributed > sold) {
        offenders.push(`${campaignId} attributed ${attributed} > ${regionId} sold ${sold}`);
      }
    }
    if (offenders.length > 0) throw new Error(offenders.join('; '));
    return 'no campaign is credited with more units than its region sold';
  });

  runCheck('Narrative invariants', 'opportunity units and revenue reconcile', () => {
    const units = regions.reduce((sum, region) => sum + numericValue(region.incrementalUnits), 0);
    const revenue = round(units * numericValue(scenario.unitPriceUsd), 2);
    if (units !== numericValue(scenario.opportunity?.incrementalUnits)) {
      throw new Error(`region incrementalUnits sum ${units} != opportunity.incrementalUnits ${scenario.opportunity?.incrementalUnits}`);
    }
    if (!approxEqual(revenue, numericValue(scenario.opportunity?.incrementalRevenueUsd), 0.001)) {
      throw new Error(`incremental revenue ${revenue} != opportunity.incrementalRevenueUsd ${scenario.opportunity?.incrementalRevenueUsd}`);
    }
    return `${units} units at ${scenario.unitPriceUsd} USD = ${revenue} USD`;
  });

  runCheck('Narrative invariants', 'capacity_plan reproduces capacity model expected values', () => {
    const expected = isPlainObject(capacityModel.expected) ? capacityModel.expected : {};
    const required = numericValue(expected.requiredIncrementalUnits);
    const headroomWithMaintenance = capacityAggregates.baselineExcludingMaintenance - numericValue(capacityModel.existingCommittedUnitsInCampaign);
    const shortfall = Math.max(0, required - headroomWithMaintenance);
    const failures: string[] = [];
    if (capacityAggregates.baselineIncludingMaintenance !== numericValue(expected.capacityWithoutMaintenanceUnits)) {
      failures.push(`baseline including maintenance ${capacityAggregates.baselineIncludingMaintenance} != capacityWithoutMaintenanceUnits ${expected.capacityWithoutMaintenanceUnits}`);
    }
    if (capacityAggregates.baselineExcludingMaintenance !== numericValue(expected.capacityWithMaintenanceUnits)) {
      failures.push(`baseline excluding maintenance ${capacityAggregates.baselineExcludingMaintenance} != capacityWithMaintenanceUnits ${expected.capacityWithMaintenanceUnits}`);
    }
    if (capacityAggregates.approvedTotal !== numericValue(recommendedOption.expectedOutputUnits)) {
      failures.push(`approved total ${capacityAggregates.approvedTotal} != ${scenario.recommendedOptionId} expectedOutputUnits ${recommendedOption.expectedOutputUnits}`);
    }
    if (shortfall !== numericValue(expected.shortfallUnits)) {
      failures.push(`derived shortfall ${shortfall} != shortfallUnits ${expected.shortfallUnits}`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `baseline ${capacityAggregates.baselineRows} rows, approved ${capacityAggregates.approvedRows} rows`;
  });

  runCheck('Narrative invariants', 'maintenance_policy_evaluations match OPT-4 and OPT-3 rules', () => {
    const opt4 = maintenancePolicyRows.get(stringValue(scenario.recommendedOptionId));
    const opt3 = maintenancePolicyRows.get('OPT-3');
    const failures: string[] = [];
    if (!opt4) {
      failures.push(`${scenario.recommendedOptionId} policy evaluation missing`);
    } else {
      if (numericValue(opt4.permittedDeferralDays) !== numericValue(maintenance.deferralDays)) {
        failures.push(`${scenario.recommendedOptionId} permittedDeferralDays ${opt4.permittedDeferralDays} != ${maintenance.deferralDays}`);
      }
      if (!boolValue(opt4.policyPass)) failures.push(`${scenario.recommendedOptionId} policyPass is ${opt4.policyPass}, expected true`);
      if (!approxEqual(numericValue(opt4.projectedStressPctOfThreshold), numericValue(stressModel.projectedStressPctOfThreshold), 0.01)) {
        failures.push(`${scenario.recommendedOptionId} projectedStressPctOfThreshold ${opt4.projectedStressPctOfThreshold} != ${stressModel.projectedStressPctOfThreshold}`);
      }
      if (numericValue(opt4.projectedStressPctOfThreshold) > numericValue(opt4.stressCeilingPct)) {
        failures.push(`${scenario.recommendedOptionId} projectedStressPctOfThreshold ${opt4.projectedStressPctOfThreshold} exceeds stressCeilingPct ${opt4.stressCeilingPct}`);
      }
    }
    if (!opt3) {
      failures.push('OPT-3 policy evaluation missing');
    } else {
      if (numericValue(opt3.permittedDeferralDays) !== 0) failures.push(`OPT-3 permittedDeferralDays ${opt3.permittedDeferralDays} != 0`);
      if (boolValue(opt3.policyPass)) failures.push(`OPT-3 policyPass is ${opt3.policyPass}, expected false`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${scenario.recommendedOptionId} permitted ${maintenance.deferralDays} days; OPT-3 blocked`;
  });

  runCheck('Narrative invariants', 'LineSignals PKG-02 stress and plan-state invariants hold', () => {
    const failures: string[] = [];
    if (lineSignals.rowsForLine === 0) failures.push(`${capacityModel.lineId ?? 'capacity line'} has no LineSignals rows`);
    const projectedPeak = numericValue(stressModel.projectedStressAtDeferredMaintenance);

    if (isOutcomeSlice()) {
      // The deferred maintenance window has been reached, so observed telemetry
      // must actually arrive at the projected peak.
      if (!approxEqual(lineSignals.peakStress, projectedPeak, 0.5)) {
        failures.push(`peak cumulativeStressIndex ${round(lineSignals.peakStress, 3)} at ${lineSignals.peakStressAt} != ${projectedPeak}`);
      }
      if (lineSignals.maintenanceInDeferredRows === 0) {
        failures.push(`no maintenance state rows found in deferred window ${maintenance.deferredStart}..${maintenance.deferredEnd}`);
      }
    } else {
      // The deferred window lies beyond the as-of boundary, so telemetry cannot
      // have reached the peak yet. What must hold is that observed stress is
      // still climbing towards the projection without having passed it - if it
      // had, the projection would already be wrong.
      if (lineSignals.peakStress > projectedPeak + 0.5) {
        failures.push(`observed stress ${round(lineSignals.peakStress, 3)} already exceeds the projected peak ${projectedPeak} before the deferred window`);
      }
      if (lineSignals.peakStress <= 0) failures.push('observed cumulativeStressIndex never rises');
      if (lineSignals.maintenanceInDeferredRows > 0) {
        failures.push(`${lineSignals.maintenanceInDeferredRows} maintenance rows exist in a deferred window that is still in the future`);
      }
    }

    const stressPct = (lineSignals.peakStress / numericValue(stressModel.thresholdStressIndex)) * 100;
    if (stressPct > numericValue(stressModel.stressCeilingPct) + 0.000001) {
      failures.push(`peak stress pct ${round(stressPct, 2)} exceeds stressCeilingPct ${stressModel.stressCeilingPct}`);
    }
    if (lineSignals.rateUtilisationViolations.length > 0) failures.push(sample(lineSignals.rateUtilisationViolations));
    if (lineSignals.maintenanceOutsideDeferred.length > 0) failures.push(sample(lineSignals.maintenanceOutsideDeferred));
    if (failures.length > 0) throw new Error(sample(failures));
    const slice = isOutcomeSlice() ? 'outcome slice' : `default slice, tracking towards projected ${projectedPeak}`;
    return `peak ${round(lineSignals.peakStress, 3)} at ${lineSignals.peakStressAt} (${slice})`;
  });

  runCheck('Narrative invariants', 'ClimateSignalObservations separate affected and control region anomalies', () => {
    const failures: string[] = [];
    const positiveThreshold = Math.max(0.25, numericValue(scenario.externalSignal?.seaSurfaceAnomalyC) * 0.25);
    const nearZeroThreshold = Math.max(0.2, numericValue(scenario.externalSignal?.seaSurfaceAnomalyC) * 0.2);
    if (climate.rows === 0) failures.push('ClimateSignalObservations has no rows');
    if (climate.labelViolations.length > 0) failures.push(sample(climate.labelViolations));
    if (climate.affectedRows === 0 || climate.minAffectedAnomaly <= positiveThreshold) {
      failures.push(`affected anomaly minimum ${round(climate.minAffectedAnomaly, 3)} is not clearly positive (> ${round(positiveThreshold, 3)})`);
    }
    if (climate.unaffectedRows === 0 || climate.maxUnaffectedAbsAnomaly > nearZeroThreshold) {
      failures.push(`unaffected anomaly max abs ${round(climate.maxUnaffectedAbsAnomaly, 3)} is not near zero (<= ${round(nearZeroThreshold, 3)})`);
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${climate.affectedRows} affected rows, ${climate.unaffectedRows} unaffected rows`;
  });

  runCheck('Narrative invariants', 'governed actions use approver roles and receipts', () => {
    const failures: string[] = [];
    for (const action of governedActions) {
      const role = stringValue(action.role);
      const receiptId = stringValue(action.receiptId);
      if (!roleIds.has(role)) failures.push(`${action.location} approver role '${role}' is not in scenario.approverRoles`);
      if (!receiptId) failures.push(`${action.location} is missing receiptId`);
      else if (!receiptJsonIds.has(receiptId)) {
        // scenario.json describes the whole story, including actions that only
        // execute after the decision. In the default slice those receipts do not
        // exist yet, and that absence is the point rather than a defect.
        const declaredOnlyInScenario = action.location.startsWith('scenario.json');
        if (isOutcomeSlice() || !declaredOnlyInScenario) {
          failures.push(`${action.location} receiptId '${receiptId}' has no matching receipts/action-receipts.json record`);
        }
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    const slice = isOutcomeSlice() ? 'outcome slice' : 'default slice, post-decision receipts not yet issued';
    return `${governedActions.length} governed actions checked (${slice})`;
  });

  runCheck('Safety / disclosure', 'persona display names are confined to allowed files and JSONL text fields', () => {
    const failures = [...csvPersonaLeaks, ...jsonPersonaLeaks];
    if (failures.length > 0) throw new Error(sample(failures));
    return 'no persona display-name leaks found';
  });

  runCheck('Safety / disclosure', 'approval columns use role identifiers, not persona names', () => {
    if (approvalViolations.length > 0) throw new Error(sample(approvalViolations));
    return 'approval fields contain ROLE-* identifiers';
  });

  runCheck('Safety / disclosure', 'external-signal records carry provenance and clean attribution', () => {
    if (externalSignalLabelViolations.length > 0) throw new Error(sample(externalSignalLabelViolations));
    return 'external-signal records carry provenance and realistic attribution';
  });

  runCheck('Safety / disclosure', 'CSV headers do not contain obvious personal fields', () => {
    if (personalHeaderViolations.length > 0) throw new Error(sample(personalHeaderViolations));
    return 'no email/phone/ssn/patient/name/address/dob headers found';
  });

  runCheck('Evaluation consistency', 'numeric/id expectedFacts values are present', () => {
    if (expectedFacts.length === 0) throw new Error('no pure-number or known-id expectedFacts were found in evaluation/questions.json');
    const missing = expectedFacts
      .filter((fact) => !fact.found)
      .map((fact) => `'${fact.value}' from ${fact.sources.join(', ')}`);
    if (missing.length > 0) throw new Error(sample(missing));
    return `${expectedFacts.length} expectedFacts checked`;
  });

  runCheck('Evaluation consistency', 'retrieval probes target existing chunks and decision cases', () => {
    const failures: string[] = [];
    for (const probe of retrievalProbeExpectations) {
      if (!hasReference(references, 'case', probe.caseId)) failures.push(`${probe.probeId || probe.location} expectedCaseId '${probe.caseId}' is missing from decision-cases`);
      for (const chunkId of probe.chunkIds) {
        if (!retrievalChunkIds.has(chunkId)) failures.push(`${probe.probeId || probe.location} expectedChunkId '${chunkId}' is missing from retrieval-corpus`);
      }
    }
    if (failures.length > 0) throw new Error(sample(failures));
    return `${retrievalProbeExpectations.length} probes checked`;
  });

  await validateManifest();

  printResults(quiet, verbose);
  process.exitCode = results.some((result) => result.status === 'failed') ? 1 : 0;
}

function validateVarianceFromUnits(regions: Entity[], unitsByRegion: Map<string, number>, scenario: Entity): void {
  const failures: string[] = [];
  if (!scenario.clock?.varianceWindowStart || !scenario.clock?.varianceWindowEnd) throw new Error('scenario variance window is missing');
  const windowDays = eachDate(String(scenario.clock.varianceWindowStart), String(scenario.clock.varianceWindowEnd)).length;
  const horizonDays = numericValue(scenario.forecast?.horizonDays);
  for (const region of regions) {
    const regionId = stringValue(region.regionId);
    const actualUnits = unitsByRegion.get(regionId);
    if (actualUnits === undefined) {
      failures.push(`${regionId}: no hero-product units found in variance window`);
      continue;
    }
    const forecastWindowUnits = (numericValue(region.baselineForecastUnits30d) / horizonDays) * windowDays;
    const variancePct = round(((actualUnits - forecastWindowUnits) / forecastWindowUnits) * 100, 2);
    if (!approxEqual(variancePct, numericValue(region.variancePct), 0.15)) {
      failures.push(`${regionId}: expected ${region.variancePct}%, got ${variancePct}% (actual=${actualUnits}, forecastWindow=${round(forecastWindowUnits, 2)})`);
    }
  }
  if (failures.length > 0) throw new Error(sample(failures));
}

function varianceDetail(regions: Entity[], unitsByRegion: Map<string, number>, scenario: Entity): string {
  const windowDays = eachDate(String(scenario.clock?.varianceWindowStart), String(scenario.clock?.varianceWindowEnd)).length;
  const horizonDays = numericValue(scenario.forecast?.horizonDays);
  const values = regions.map((region) => {
    const actualUnits = unitsByRegion.get(stringValue(region.regionId)) ?? 0;
    const forecastWindowUnits = (numericValue(region.baselineForecastUnits30d) / horizonDays) * windowDays;
    return `${region.regionId}=${round(((actualUnits - forecastWindowUnits) / forecastWindowUnits) * 100, 2)}%`;
  });
  return values.join(', ');
}

async function validateManifest(): Promise<void> {
  const manifestPath = 'manifest.json';
  const found = await resolveLogicalFile(manifestPath);
  if (!found) {
    fail('Reproducibility signal', 'manifest.json exists and file list matches disk', 'manifest.json is missing');
    return;
  }
  let manifest: Entity;
  try {
    manifest = JSON.parse(await readFile(found.absolutePath, 'utf8')) as Entity;
  } catch (error) {
    fail('Reproducibility signal', 'manifest.json exists and file list matches disk', `manifest.json is not valid JSON: ${errorMessage(error)}`);
    return;
  }
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestPaths = new Set(manifestFiles.map((file: Entity) => stringValue(file.path)).filter(Boolean));
  const actualPaths = new Set((await listPayloadFiles()).map((relativePath) => `data/${relativePath.split('\\').join('/')}`));
  const added = sorted([...actualPaths].filter((path) => !manifestPaths.has(path)));
  const removed = sorted([...manifestPaths].filter((path) => !actualPaths.has(path)));
  if (added.length > 0 || removed.length > 0) {
    fail(
      'Reproducibility signal',
      'manifest.json exists and file list matches disk',
      `WARNING: manifest path set mismatch; added on disk: ${added.length ? sample(added, 6) : 'none'}; missing on disk: ${removed.length ? sample(removed, 6) : 'none'}`,
    );
    return;
  }
  pass('Reproducibility signal', 'manifest.json exists and file list matches disk', `${actualPaths.size} payload paths match`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    fail('Runtime', 'validator completed without unhandled exception', errorMessage(error));
    printResults(false, true);
    process.exitCode = 1;
  }
}
