import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_ROOT, asOfDate, createRng, includeOutcomeSlice, isObservable, loadScenario, logResults, openCsv, round } from './core.ts';
import type { CsvValue, CsvWriter, GenerationResult, Rng } from './core.ts';

type ScenarioRecord = Record<string, any>;
type CsvRow = Record<string, CsvValue>;

const OPEN_CASE_STATUS = 'open';

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asArray<T = ScenarioRecord>(value: unknown, path: string): T[] {
  assertCondition(Array.isArray(value), `Expected ${path} to be an array`);
  return value as T[];
}

function asRecord(value: unknown, path: string): ScenarioRecord {
  assertCondition(Boolean(value) && typeof value === 'object' && !Array.isArray(value), `Expected ${path} to be an object`);
  return value as ScenarioRecord;
}

function requiredString(value: unknown, path: string): string {
  assertCondition(typeof value === 'string' && value.length > 0, `${path} must be a non-empty string`);
  return value;
}

function requiredDateLike(value: unknown, path: string): string {
  const text = requiredString(value, path);
  assertCondition(text.length >= 10, `${path} must be a date or timestamp`);
  return text;
}

function optionalArray<T = ScenarioRecord>(value: unknown, path: string): T[] {
  if (value === null || value === undefined) return [];
  return asArray<T>(value, path);
}

async function readJsonl(relativePath: string): Promise<ScenarioRecord[]> {
  const raw = await readFile(join(DATA_ROOT, relativePath), 'utf8');
  return raw
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ScenarioRecord);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else if (char === '"') {
      quoted = true;
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function readCsv(relativePath: string): Promise<Record<string, string>[]> {
  const raw = await readFile(join(DATA_ROOT, relativePath), 'utf8');
  const lines = raw.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  assertCondition(lines.length > 0, `${relativePath} is empty`);
  const columns = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (const [index, column] of columns.entries()) row[column] = values[index] ?? '';
    return row;
  });
}

function policyVersion(policy: ScenarioRecord): string {
  const version = policy.version ?? policy.policyVersion;
  assertCondition(version !== null && version !== undefined && String(version).length > 0, `Policy version missing for ${policy.policyId}`);
  return String(version);
}

function actionRole(action: ScenarioRecord): string | null {
  const role = action.approvedByRole ?? action.approverRole;
  return role === null || role === undefined || String(role).length === 0 ? null : String(role);
}

function compactPolicyKey(policyId: CsvValue, version: CsvValue): string {
  return `${policyId}:${version}`;
}

function mainCaseRecord(scenario: ScenarioRecord): ScenarioRecord {
  return asRecord(scenario.decisionCase, 'decisionCase');
}

function mainCaseId(scenario: ScenarioRecord): string {
  return requiredString(mainCaseRecord(scenario).caseId, 'decisionCase.caseId');
}

function isMainCase(record: ScenarioRecord, scenario: ScenarioRecord): boolean {
  return String(record.caseId) === mainCaseId(scenario);
}

function mainCaseStates(scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  const states = asArray<ScenarioRecord>(mainCaseRecord(scenario).states, 'decisionCase.states');
  if (emitOutcomeSlice) return states;
  return states.filter((state, index) => isObservable(scenario, requiredDateLike(state.at, `decisionCase.states[${index}].at`)));
}

function mainCaseCorrections(scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  const corrections = asArray<ScenarioRecord>(mainCaseRecord(scenario).corrections, 'decisionCase.corrections');
  if (emitOutcomeSlice) return corrections;
  return corrections.filter((correction, index) =>
    isObservable(scenario, requiredDateLike(correction.proposedAt, `decisionCase.corrections[${index}].proposedAt`)),
  );
}

function mainCaseOutcomes(scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  return emitOutcomeSlice ? asArray<ScenarioRecord>(mainCaseRecord(scenario).outcomes, 'decisionCase.outcomes') : [];
}

function mainCaseActions(scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  return emitOutcomeSlice ? asArray<ScenarioRecord>(scenario.actions, 'actions') : [];
}

function mainCaseStatus(scenario: ScenarioRecord, emitOutcomeSlice: boolean): string {
  return emitOutcomeSlice ? requiredString(mainCaseRecord(scenario).status, 'decisionCase.status') : OPEN_CASE_STATUS;
}

function mainCaseResolvedAt(scenario: ScenarioRecord, emitOutcomeSlice: boolean): string | null {
  return emitOutcomeSlice ? requiredString(mainCaseRecord(scenario).resolvedAt, 'decisionCase.resolvedAt') : null;
}

function mainCaseCommitmentId(scenario: ScenarioRecord, emitOutcomeSlice: boolean): string | null {
  return emitOutcomeSlice ? requiredString(asRecord(scenario.commitment, 'commitment').commitmentId, 'commitment.commitmentId') : null;
}

function correctionsForCase(record: ScenarioRecord, scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return mainCaseCorrections(scenario, emitOutcomeSlice);
  return optionalArray(record.corrections ?? record.correction, `${record.caseId}.corrections`);
}

function outcomesForCase(record: ScenarioRecord, scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return mainCaseOutcomes(scenario, emitOutcomeSlice);
  return optionalArray(record.outcomes, `${record.caseId}.outcomes`);
}

function statesForCase(record: ScenarioRecord, scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return mainCaseStates(scenario, emitOutcomeSlice);
  return asArray(record.stateHistory, `${record.caseId}.stateHistory`);
}

function triggersForCase(record: ScenarioRecord, scenario: ScenarioRecord): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return asArray(scenario.decisionCase?.triggers, 'decisionCase.triggers');
  return asArray(record.triggers, `${record.caseId}.triggers`);
}

function policiesForCase(record: ScenarioRecord, scenario: ScenarioRecord): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return asArray(scenario.decisionCase?.appliedPolicies, 'decisionCase.appliedPolicies');
  return asArray(record.appliedPolicies, `${record.caseId}.appliedPolicies`);
}

function governedActionsForCase(record: ScenarioRecord, scenario: ScenarioRecord, emitOutcomeSlice: boolean): ScenarioRecord[] {
  if (isMainCase(record, scenario)) return mainCaseActions(scenario, emitOutcomeSlice);
  return optionalArray(record.governedActions, `${record.caseId}.governedActions`);
}

function comparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(round(value, 6));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function assertSameRows(
  label: string,
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  fields: string[],
): void {
  assertCondition(actualRows.length === expectedRows.length, `${label} count mismatch: expected ${expectedRows.length}, got ${actualRows.length}`);
  for (const [index, expected] of expectedRows.entries()) {
    const actual = actualRows[index];
    for (const field of fields) {
      assertCondition(
        comparable(actual[field]) === comparable(expected[field]),
        `${label}[${index}].${field} mismatch: expected ${comparable(expected[field])}, got ${comparable(actual[field])}`,
      );
    }
  }
}

function assertMainDocumentMatchesScenario(mainDocument: ScenarioRecord, scenario: ScenarioRecord): void {
  const decisionCase = asRecord(scenario.decisionCase, 'decisionCase');
  assertSameRows(
    'main decision document case',
    [
      {
        caseId: decisionCase.caseId,
        title: decisionCase.title,
        scopeKey: decisionCase.scopeKey,
        openedAt: decisionCase.openedAt,
        concernsProductId: decisionCase.concernsProductId,
      },
    ],
    [
      {
        caseId: mainDocument.caseId,
        title: mainDocument.title,
        scopeKey: mainDocument.scopeKey,
        openedAt: mainDocument.openedAt,
        concernsProductId: mainDocument.concernsProduct?.productId ?? mainDocument.productId,
      },
    ],
    ['caseId', 'title', 'scopeKey', 'openedAt', 'concernsProductId'],
  );
  assertSameRows(
    'main decision document triggers',
    asArray(decisionCase.triggers, 'decisionCase.triggers').map((trigger) => ({ triggerType: trigger.type, triggerId: trigger.id })),
    asArray(mainDocument.triggers, 'mainDocument.triggers').map((trigger) => ({ triggerType: trigger.type, triggerId: trigger.id })),
    ['triggerType', 'triggerId'],
  );
  assertSameRows(
    'main decision document policies',
    asArray(decisionCase.appliedPolicies, 'decisionCase.appliedPolicies').map((policy) => ({
      policyId: policy.policyId,
      policyVersion: policy.version,
    })),
    asArray(mainDocument.appliedPolicies, 'mainDocument.appliedPolicies').map((policy) => ({
      policyId: policy.policyId,
      policyVersion: policyVersion(policy),
    })),
    ['policyId', 'policyVersion'],
  );
}

function assertRoleColumn(row: CsvRow, column: string, roleIds: Set<string>, personaNames: string[], fileName: string): void {
  const value = row[column];
  if (value === null || value === undefined || value === '') return;
  const role = String(value);
  assertCondition(role.startsWith('ROLE-'), `${fileName}.${column} must contain a ROLE-* identifier`);
  assertCondition(roleIds.has(role), `${fileName}.${column} contains unknown role id: ${role}`);
  const lower = role.toLowerCase();
  for (const personaName of personaNames) {
    assertCondition(!lower.includes(personaName), `${fileName}.${column} contains a persona name`);
  }
}

async function writeCheckedRow(
  writer: CsvWriter,
  fileName: string,
  row: CsvRow,
  roleIds: Set<string>,
  personaNames: string[],
): Promise<void> {
  for (const column of ['actorRole', 'proposedByRole', 'approvedByRole']) {
    assertRoleColumn(row, column, roleIds, personaNames, fileName);
  }
  await writer.writeRow(row);
}

async function writeTable(
  results: GenerationResult[],
  fileName: string,
  columns: string[],
  rows: CsvRow[],
  roleIds: Set<string>,
  personaNames: string[],
): Promise<void> {
  const writer = await openCsv(`fabric-sql/${fileName}`, columns);
  for (const row of rows) await writeCheckedRow(writer, fileName, row, roleIds, personaNames);
  results.push({ file: `fabric-sql/${fileName}`, rows: await writer.close() });
}

function buildTimelineActorMap(timelineEvents: ScenarioRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of timelineEvents) {
    if (event.lifecycleEvent !== 'state_changed') continue;
    out.set(`${event.caseId}|${event.entityId}|${event.timestamp}`, String(event.actorRole));
  }
  return out;
}

function stateActorRole(
  record: ScenarioRecord,
  state: ScenarioRecord,
  scenario: ScenarioRecord,
  emitOutcomeSlice: boolean,
  timelineActors: Map<string, string>,
  rng: Rng,
): string {
  const actor = timelineActors.get(`${record.caseId}|${record.caseId}|${state.at}`);
  if (actor) return actor;
  if (state.state === 'evidence_gathered') return 'ROLE-DEMAND-PLANNER';
  if (state.state === 'approved') {
    const firstAction = governedActionsForCase(record, scenario, emitOutcomeSlice)[0];
    const role = firstAction ? actionRole(firstAction) : null;
    if (role) return role;
  }
  if (['opened', 'options_proposed', 'executing', 'resolved'].includes(String(state.state))) {
    return 'ROLE-KNOWLEDGE-STEWARD';
  }
  return rng.pick(['ROLE-KNOWLEDGE-STEWARD', 'ROLE-DEMAND-PLANNER']);
}

function deriveOriginSignalId(record: ScenarioRecord, scenario: ScenarioRecord, externalSignalIds: Set<string>): string | null {
  if (isMainCase(record, scenario)) return String(scenario.externalSignal?.signalId ?? scenario.commitment?.originSignalId ?? '');
  const trigger = optionalArray(record.triggers, `${record.caseId}.triggers`).find((item) => item.type === 'externalSignal');
  const triggerId = trigger?.id === undefined ? null : String(trigger.id);
  return triggerId && externalSignalIds.has(triggerId) ? triggerId : null;
}

function deriveLineId(record: ScenarioRecord, scenario: ScenarioRecord): string | null {
  if (isMainCase(record, scenario)) return String(scenario.capacityModel?.lineId ?? '');
  return record.lineId === null || record.lineId === undefined ? null : String(record.lineId);
}

function deriveCommitmentId(record: ScenarioRecord, scenario: ScenarioRecord, emitOutcomeSlice: boolean): string | null {
  if (isMainCase(record, scenario)) return mainCaseCommitmentId(scenario, emitOutcomeSlice);
  return record.commitmentId === null || record.commitmentId === undefined ? null : String(record.commitmentId);
}

function metricNumber(value: unknown, path: string): number {
  const numberValue = Number(value);
  assertCondition(Number.isFinite(numberValue), `${path} must be numeric`);
  return round(numberValue, 2);
}

function assertMember(value: CsvValue, values: Set<string>, label: string): void {
  if (value === null || value === undefined || value === '') return;
  assertCondition(values.has(String(value)), `Missing parent for ${label}: ${value}`);
}

function assertChildCases(caseRows: CsvRow[], childTables: { fileName: string; rows: CsvRow[] }[]): void {
  const caseIds = new Set(caseRows.map((row) => String(row.caseId)));
  for (const table of childTables) {
    for (const row of table.rows) assertMember(row.caseId, caseIds, `${table.fileName}.caseId`);
  }
}

function buildMainCaseCampaignRows(scenario: ScenarioRecord, campaignRows: Record<string, string>[]): CsvRow[] {
  const decisionCase = asRecord(scenario.decisionCase, 'decisionCase');
  const affectedRegionIds = asArray<string>(scenario.externalSignal?.affectedRegionIds, 'externalSignal.affectedRegionIds');
  const scenarioCampaigns = asArray<ScenarioRecord>(scenario.campaigns, 'campaigns');
  const campaignsById = new Map(campaignRows.map((row) => [row.campaignId, row]));
  const rows: CsvRow[] = [];

  for (const regionId of affectedRegionIds) {
    const matchingCampaigns = scenarioCampaigns.filter((campaign) => campaign.regionId === regionId);
    assertCondition(matchingCampaigns.length === 1, `Expected exactly one scenario campaign for affected region ${regionId}`);
    const campaignId = String(matchingCampaigns[0].campaignId);
    const generatedCampaign = campaignsById.get(campaignId);
    assertCondition(Boolean(generatedCampaign), `Affected-region campaign missing from campaigns.csv: ${campaignId}`);
    assertCondition(generatedCampaign?.regionId === regionId, `Campaign ${campaignId} region mismatch: expected ${regionId}, got ${generatedCampaign?.regionId}`);
    assertCondition(
      generatedCampaign?.productId === decisionCase.concernsProductId,
      `Campaign ${campaignId} product mismatch: expected ${decisionCase.concernsProductId}, got ${generatedCampaign?.productId}`,
    );
    rows.push({
      caseId: decisionCase.caseId,
      campaignId,
      regionId,
      relationshipType: 'signal_affected',
    });
  }

  return rows;
}

function buildHistoricalCaseCampaignRows(record: ScenarioRecord, campaignRows: Record<string, string>[]): CsvRow[] {
  if (!record.campaignId) return [];
  const campaignId = String(record.campaignId);
  const campaign = campaignRows.find((row) => row.campaignId === campaignId);
  assertCondition(Boolean(campaign), `Historical decision case ${record.caseId} references missing campaign ${campaignId}`);
  return [
    {
      caseId: record.caseId,
      campaignId,
      regionId: campaign?.regionId,
      relationshipType: 'historical_context',
    },
  ];
}

function assertExistingActionLinks(rows: CsvRow[], governedActions: Record<string, string>[], receipts: Record<string, string>[]): void {
  const actionIds = new Set(governedActions.map((row) => row.actionId));
  const receiptById = new Map(receipts.map((row) => [row.receiptId, row]));
  for (const row of rows) {
    assertMember(row.actionId, actionIds, 'decision_case_actions.actionId');
    assertMember(row.receiptId, new Set(receiptById.keys()), 'decision_case_actions.receiptId');
    assertCondition(receiptById.get(String(row.receiptId))?.actionId === row.actionId, `Receipt ${row.receiptId} does not belong to action ${row.actionId}`);
  }
}

function assertMainCsvMatchesScenario(rowsByFile: Map<string, CsvRow[]>, scenario: ScenarioRecord, emitOutcomeSlice: boolean): void {
  const decisionCase = asRecord(scenario.decisionCase, 'decisionCase');
  const caseId = mainCaseId(scenario);
  assertSameRows(
    'decision_cases.csv main case',
    [
      {
        caseId: decisionCase.caseId,
        title: decisionCase.title,
        scopeKey: decisionCase.scopeKey,
        status: mainCaseStatus(scenario, emitOutcomeSlice),
        concernsProductId: decisionCase.concernsProductId,
        openedAt: decisionCase.openedAt,
        resolvedAt: mainCaseResolvedAt(scenario, emitOutcomeSlice),
        commitmentId: mainCaseCommitmentId(scenario, emitOutcomeSlice),
      },
    ],
    (rowsByFile.get('decision_cases.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'title', 'scopeKey', 'status', 'concernsProductId', 'openedAt', 'resolvedAt', 'commitmentId'],
  );
  assertSameRows(
    'decision_case_states.csv main case',
    mainCaseStates(scenario, emitOutcomeSlice).map((state, index) => ({
      caseId,
      sequence: index + 1,
      state: state.state,
      changedAt: state.at,
    })),
    (rowsByFile.get('decision_case_states.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'sequence', 'state', 'changedAt'],
  );
  assertSameRows(
    'decision_case_triggers.csv main case',
    asArray(decisionCase.triggers, 'decisionCase.triggers').map((trigger) => ({
      caseId,
      triggerType: trigger.type,
      triggerId: trigger.id,
    })),
    (rowsByFile.get('decision_case_triggers.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'triggerType', 'triggerId'],
  );
  assertSameRows(
    'decision_case_policies.csv main case',
    asArray(decisionCase.appliedPolicies, 'decisionCase.appliedPolicies').map((policy) => ({
      caseId,
      policyId: policy.policyId,
      policyVersion: policy.version,
    })),
    (rowsByFile.get('decision_case_policies.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'policyId', 'policyVersion'],
  );
  assertSameRows(
    'decision_corrections.csv main case',
    mainCaseCorrections(scenario, emitOutcomeSlice).map((correction) => ({
      caseId,
      correctionId: correction.correctionId,
      statement: correction.statement,
      scopeKey: correction.scopeKey,
      proposedByRole: correction.proposedByRole,
      proposedAt: correction.proposedAt,
      approvedByRole: correction.approvedByRole,
      approvedAt: correction.approvedAt,
      status: correction.status,
    })),
    (rowsByFile.get('decision_corrections.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'correctionId', 'statement', 'scopeKey', 'proposedByRole', 'proposedAt', 'approvedByRole', 'approvedAt', 'status'],
  );
  assertSameRows(
    'decision_outcomes.csv main case',
    mainCaseOutcomes(scenario, emitOutcomeSlice).map((outcome) => ({
      caseId,
      outcomeId: outcome.outcomeId,
      metricName: outcome.metricName,
      metricValue: outcome.metricValue,
      plannedValue: outcome.plannedValue,
      resultCode: outcome.resultCode,
      recordedAt: outcome.recordedAt,
    })),
    (rowsByFile.get('decision_outcomes.csv') ?? []).filter((row) => row.caseId === caseId),
    ['caseId', 'outcomeId', 'metricName', 'metricValue', 'plannedValue', 'resultCode', 'recordedAt'],
  );
}

function assertMainCampaignRows(rows: CsvRow[], scenario: ScenarioRecord): void {
  const expectedRegionIds = asArray<string>(scenario.externalSignal?.affectedRegionIds, 'externalSignal.affectedRegionIds');
  const actualRows = rows.filter((row) => row.caseId === mainCaseId(scenario));
  assertCondition(
    actualRows.length === expectedRegionIds.length,
    `decision_case_campaigns.csv main case count mismatch: expected ${expectedRegionIds.length}, got ${actualRows.length}`,
  );
  const expectedRegionSet = new Set(expectedRegionIds);
  const actualRegionSet = new Set(actualRows.map((row) => String(row.regionId)));
  for (const regionId of expectedRegionSet) {
    assertCondition(actualRegionSet.has(regionId), `decision_case_campaigns.csv missing affected region ${regionId}`);
  }
  assertCondition(actualRegionSet.size === expectedRegionSet.size, 'decision_case_campaigns.csv contains duplicate or unexpected affected regions');
  for (const row of actualRows) {
    assertCondition(row.relationshipType === 'signal_affected', `Unexpected main case campaign relationship type: ${row.relationshipType}`);
  }
}

function assertOutcomeContracts(outcomeRows: CsvRow[], scenario: ScenarioRecord, emitOutcomeSlice: boolean): void {
  const expectedOutcomes = mainCaseOutcomes(scenario, emitOutcomeSlice);
  const actualOutcomes = outcomeRows.filter((row) => row.caseId === mainCaseId(scenario));
  assertCondition(
    actualOutcomes.length === expectedOutcomes.length,
    `decision_outcomes.csv main case count mismatch: expected ${expectedOutcomes.length}, got ${actualOutcomes.length}`,
  );
}

function assertReferenceIntegrity(
  rowsByFile: Map<string, CsvRow[]>,
  references: {
    productIds: Set<string>;
    campaignIds: Set<string>;
    lineIds: Set<string>;
    commitmentIds: Set<string>;
    signalIds: Set<string>;
    policyKeys: Set<string>;
    actionRows: Record<string, string>[];
    receiptRows: Record<string, string>[];
  },
): void {
  for (const row of rowsByFile.get('decision_cases.csv') ?? []) {
    assertMember(row.concernsProductId, references.productIds, 'decision_cases.concernsProductId');
    assertMember(row.lineId, references.lineIds, 'decision_cases.lineId');
    assertMember(row.commitmentId, references.commitmentIds, 'decision_cases.commitmentId');
    assertMember(row.originSignalId, references.signalIds, 'decision_cases.originSignalId');
  }
  for (const row of rowsByFile.get('decision_case_campaigns.csv') ?? []) {
    assertMember(row.campaignId, references.campaignIds, 'decision_case_campaigns.campaignId');
  }
  for (const row of rowsByFile.get('decision_case_policies.csv') ?? []) {
    assertMember(compactPolicyKey(row.policyId, row.policyVersion), references.policyKeys, 'decision_case_policies.policyId/policyVersion');
  }
  assertExistingActionLinks(rowsByFile.get('decision_case_actions.csv') ?? [], references.actionRows, references.receiptRows);
}

function assertNoFullyEmptyColumns(
  tables: { fileName: string; columns: string[]; rows: CsvRow[]; allowEmpty?: boolean; allowEmptyColumns?: string[] }[],
): void {
  for (const table of tables) {
    if (table.rows.length === 0 && table.allowEmpty === true) continue;
    const allowEmptyColumns = new Set(table.allowEmptyColumns ?? []);
    assertCondition(table.rows.length > 0, `${table.fileName} must not be empty`);
    for (const column of table.columns) {
      const hasValue = table.rows.some((row) => row[column] !== null && row[column] !== undefined && row[column] !== '');
      if (!hasValue && allowEmptyColumns.has(column)) continue;
      assertCondition(hasValue, `${table.fileName}.${column} is empty in every row`);
    }
  }
}

export async function generateDecisionMemory(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const emitOutcomeSlice = includeOutcomeSlice();
  const snapshotAsOf = asOfDate(scenario);
  const caseDocuments = await readJsonl('lakehouse/decision-cases/decision-cases.jsonl');
  const timelineEvents = await readJsonl('lakehouse/decision-cases/decision-case-timeline.jsonl');
  const governedActionRows = await readCsv('fabric-sql/governed_actions.csv');
  const receiptRows = await readCsv('fabric-sql/action_receipts.csv');
  const policyRows = await readCsv('fabric-sql/approved_policies.csv');
  const productRows = await readCsv('fabric-sql/products.csv');
  const campaignRows = await readCsv('fabric-sql/campaigns.csv');
  const lineRows = await readCsv('fabric-sql/production_lines.csv');
  const commitmentRows = await readCsv('fabric-sql/campaign_commitments.csv');
  const signalRows = await readCsv('fabric-sql/external_signals.csv');
  const results: GenerationResult[] = [];
  const rowsByFile = new Map<string, CsvRow[]>();
  const stateActorRng = createRng('decision-memory:state-actors');

  assertCondition(caseDocuments.length === 9, `Expected 9 decision case documents, got ${caseDocuments.length}`);
  assertCondition(timelineEvents.length > 0, 'Decision case timeline must not be empty');
  const defaultMainStates = mainCaseStates(scenario, false);
  assertCondition(
    emitOutcomeSlice || defaultMainStates.length > 0,
    `Default decision case must have at least one observable state on or before ${snapshotAsOf}`,
  );
  const mainDocument = caseDocuments.find((record) => String(record.caseId) === mainCaseId(scenario));
  assertCondition(Boolean(mainDocument), `${mainCaseId(scenario)} missing from decision case documents`);
  assertMainDocumentMatchesScenario(mainDocument as ScenarioRecord, scenario);

  const caseIds = new Set<string>();
  for (const record of caseDocuments) {
    assertCondition(!caseIds.has(String(record.caseId)), `Duplicate decision case id: ${record.caseId}`);
    caseIds.add(String(record.caseId));
  }

  const roleIds = new Set(asArray<string>(scenario.approverRoles, 'approverRoles'));
  const personaNames = asArray<ScenarioRecord>(scenario.personas, 'personas').map((persona) => String(persona.displayName).toLowerCase());
  const productIds = new Set(productRows.map((row) => row.productId));
  const campaignIds = new Set(campaignRows.map((row) => row.campaignId));
  const lineIds = new Set(lineRows.map((row) => row.lineId));
  const commitmentIds = new Set(commitmentRows.map((row) => row.commitmentId));
  const signalIds = new Set(signalRows.map((row) => row.signalId));
  const policyKeys = new Set(policyRows.map((row) => compactPolicyKey(row.policyId, row.policyVersion)));
  const existingActionIds = new Set(governedActionRows.map((row) => row.actionId));
  const existingReceiptIds = new Set(receiptRows.map((row) => row.receiptId));
  const timelineActors = buildTimelineActorMap(timelineEvents);

  const decisionCases: CsvRow[] = [];
  const decisionCaseCampaigns: CsvRow[] = [];
  const decisionCaseStates: CsvRow[] = [];
  const decisionCaseTriggers: CsvRow[] = [];
  const decisionCasePolicies: CsvRow[] = [];
  const decisionCorrections: CsvRow[] = [];
  const decisionOutcomes: CsvRow[] = [];
  const decisionCaseActions: CsvRow[] = [];

  for (const record of caseDocuments) {
    const caseId = String(record.caseId);
    const decisionCase = asRecord(scenario.decisionCase, 'decisionCase');
    const concernsProductId = isMainCase(record, scenario)
      ? String(decisionCase.concernsProductId)
      : String(record.concernsProduct?.productId ?? record.productId ?? '');
    decisionCases.push({
      caseId,
      title: isMainCase(record, scenario) ? decisionCase.title : record.title,
      scopeKey: isMainCase(record, scenario) ? decisionCase.scopeKey : record.scopeKey,
      status: isMainCase(record, scenario) ? mainCaseStatus(scenario, emitOutcomeSlice) : record.status,
      concernsProductId,
      openedAt: isMainCase(record, scenario) ? decisionCase.openedAt : record.openedAt,
      resolvedAt: isMainCase(record, scenario) ? mainCaseResolvedAt(scenario, emitOutcomeSlice) : record.resolvedAt ?? null,
      originSignalId: deriveOriginSignalId(record, scenario, signalIds),
      lineId: deriveLineId(record, scenario),
      commitmentId: deriveCommitmentId(record, scenario, emitOutcomeSlice),
    });

    decisionCaseCampaigns.push(
      ...(isMainCase(record, scenario) ? buildMainCaseCampaignRows(scenario, campaignRows) : buildHistoricalCaseCampaignRows(record, campaignRows)),
    );

    for (const [index, state] of statesForCase(record, scenario, emitOutcomeSlice).entries()) {
      decisionCaseStates.push({
        caseId,
        sequence: index + 1,
        state: state.state,
        changedAt: state.at,
        actorRole: stateActorRole(record, state, scenario, emitOutcomeSlice, timelineActors, stateActorRng),
      });
    }

    for (const trigger of triggersForCase(record, scenario)) {
      decisionCaseTriggers.push({
        caseId,
        triggerType: trigger.type,
        triggerId: trigger.id,
      });
    }

    for (const policy of policiesForCase(record, scenario)) {
      decisionCasePolicies.push({
        caseId,
        policyId: policy.policyId,
        policyVersion: policyVersion(policy),
      });
    }

    for (const correction of correctionsForCase(record, scenario, emitOutcomeSlice)) {
      decisionCorrections.push({
        correctionId: correction.correctionId,
        caseId,
        statement: correction.statement,
        scopeKey: correction.scopeKey,
        proposedByRole: correction.proposedByRole,
        proposedAt: correction.proposedAt,
        approvedByRole: correction.approvedByRole,
        approvedAt: correction.approvedAt,
        status: correction.status,
      });
    }

    for (const outcome of outcomesForCase(record, scenario, emitOutcomeSlice)) {
      decisionOutcomes.push({
        outcomeId: outcome.outcomeId,
        caseId,
        metricName: outcome.metricName,
        metricValue: metricNumber(outcome.metricValue, `${caseId}.${outcome.outcomeId}.metricValue`),
        plannedValue: metricNumber(outcome.plannedValue, `${caseId}.${outcome.outcomeId}.plannedValue`),
        resultCode: outcome.resultCode,
        recordedAt: outcome.recordedAt ?? record.resolvedAt,
      });
    }

    for (const action of governedActionsForCase(record, scenario, emitOutcomeSlice)) {
      const actionId = String(action.actionId);
      const receiptId = String(action.receiptId);
      if (!existingActionIds.has(actionId) || !existingReceiptIds.has(receiptId)) continue;
      decisionCaseActions.push({ caseId, actionId, receiptId });
    }
  }

  rowsByFile.set('decision_cases.csv', decisionCases);
  rowsByFile.set('decision_case_campaigns.csv', decisionCaseCampaigns);
  rowsByFile.set('decision_case_states.csv', decisionCaseStates);
  rowsByFile.set('decision_case_triggers.csv', decisionCaseTriggers);
  rowsByFile.set('decision_case_policies.csv', decisionCasePolicies);
  rowsByFile.set('decision_corrections.csv', decisionCorrections);
  rowsByFile.set('decision_outcomes.csv', decisionOutcomes);
  rowsByFile.set('decision_case_actions.csv', decisionCaseActions);

  assertChildCases(decisionCases, [
    { fileName: 'decision_case_campaigns.csv', rows: decisionCaseCampaigns },
    { fileName: 'decision_case_states.csv', rows: decisionCaseStates },
    { fileName: 'decision_case_triggers.csv', rows: decisionCaseTriggers },
    { fileName: 'decision_case_policies.csv', rows: decisionCasePolicies },
    { fileName: 'decision_corrections.csv', rows: decisionCorrections },
    { fileName: 'decision_outcomes.csv', rows: decisionOutcomes },
    { fileName: 'decision_case_actions.csv', rows: decisionCaseActions },
  ]);
  assertReferenceIntegrity(rowsByFile, {
    productIds,
    campaignIds,
    lineIds,
    commitmentIds,
    signalIds,
    policyKeys,
    actionRows: governedActionRows,
    receiptRows,
  });
  assertMainCsvMatchesScenario(rowsByFile, scenario, emitOutcomeSlice);
  assertMainCampaignRows(decisionCaseCampaigns, scenario);
  assertOutcomeContracts(decisionOutcomes, scenario, emitOutcomeSlice);
  assertSameRows(
    'decision_case_actions.csv main case',
    mainCaseActions(scenario, emitOutcomeSlice).map((action) => ({
      caseId: mainCaseId(scenario),
      actionId: action.actionId,
      receiptId: action.receiptId,
    })),
    decisionCaseActions.filter((row) => row.caseId === mainCaseId(scenario)),
    ['caseId', 'actionId', 'receiptId'],
  );

  const tables = [
    {
      fileName: 'decision_cases.csv',
      columns: ['caseId', 'title', 'scopeKey', 'status', 'concernsProductId', 'openedAt', 'resolvedAt', 'originSignalId', 'lineId', 'commitmentId'],
      rows: decisionCases,
      allowEmptyColumns: emitOutcomeSlice ? [] : ['commitmentId'],
    },
    {
      fileName: 'decision_case_campaigns.csv',
      columns: ['caseId', 'campaignId', 'regionId', 'relationshipType'],
      rows: decisionCaseCampaigns,
    },
    {
      fileName: 'decision_case_states.csv',
      columns: ['caseId', 'sequence', 'state', 'changedAt', 'actorRole'],
      rows: decisionCaseStates,
    },
    {
      fileName: 'decision_case_triggers.csv',
      columns: ['caseId', 'triggerType', 'triggerId'],
      rows: decisionCaseTriggers,
    },
    {
      fileName: 'decision_case_policies.csv',
      columns: ['caseId', 'policyId', 'policyVersion'],
      rows: decisionCasePolicies,
    },
    {
      fileName: 'decision_corrections.csv',
      columns: ['correctionId', 'caseId', 'statement', 'scopeKey', 'proposedByRole', 'proposedAt', 'approvedByRole', 'approvedAt', 'status'],
      rows: decisionCorrections,
      allowEmpty: true,
    },
    {
      fileName: 'decision_outcomes.csv',
      columns: ['outcomeId', 'caseId', 'metricName', 'metricValue', 'plannedValue', 'resultCode', 'recordedAt'],
      rows: decisionOutcomes,
    },
    {
      fileName: 'decision_case_actions.csv',
      columns: ['caseId', 'actionId', 'receiptId'],
      rows: decisionCaseActions,
      allowEmpty: true,
    },
  ];
  assertNoFullyEmptyColumns(tables);

  for (const table of tables) {
    await writeTable(results, table.fileName, table.columns, table.rows, roleIds, personaNames);
  }

  logResults('Decision memory', results);
  return results;
}
