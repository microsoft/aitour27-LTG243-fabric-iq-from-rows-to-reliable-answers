// CSV projections of the external-signal evidence documents.
//
// A Fabric data agent grounds on TABULAR sources, and `fabio lakehouse
// load-table` accepts only Csv and Parquet. The advisories, briefings, evidence
// trace and provider record are authored as JSONL/JSON for retrieval and Cosmos,
// so without these projections the agent can quote weather numbers but cannot
// cite the advisory, state the ENSO persistence probability, walk the Act 1
// evidence chain, or attribute the feed to its provider.
//
// The JSONL remains the document form. These CSVs are a flattened view of the
// same records and must stay consistent with them.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_ROOT, includeOutcomeSlice, isObservable, loadScenario, openCsv, round } from './core.ts';
import type { GenerationResult } from './core.ts';

type Entity = Record<string, any>;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readJsonl(relativePath: string): Promise<Entity[]> {
  const text = await readFile(join(DATA_ROOT, relativePath), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entity);
}

async function readJson(relativePath: string): Promise<Entity> {
  return JSON.parse(await readFile(join(DATA_ROOT, relativePath), 'utf8')) as Entity;
}

const list = (value: unknown): string =>
  Array.isArray(value) ? value.join('; ') : value === undefined || value === null ? '' : String(value);

function weatherProvider(scenario: Entity): Entity {
  const provider = scenario.weather?.provider;
  assertCondition(Boolean(provider) && typeof provider === 'object' && !Array.isArray(provider), 'scenario.weather.provider is missing');
  return provider as Entity;
}

function scenarioExternalSignal(scenario: Entity): Entity {
  const signal = scenario.externalSignal;
  assertCondition(Boolean(signal) && typeof signal === 'object' && !Array.isArray(signal), 'scenario.externalSignal is missing');
  return signal as Entity;
}

function titleCase(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

function advisoryName(advisory: Entity, scenario: Entity): string {
  const signal = scenarioExternalSignal(scenario);
  if (advisory.signalId === signal.signalId) return String(signal.name);
  return `${titleCase(String(advisory.signalType ?? 'climate'))} advisory`;
}

function confidenceText(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${round(numeric * 100, 1)}%` : 'not specified';
}

function signed(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `${numeric >= 0 ? '+' : ''}${round(numeric, 2)}`;
}

function advisoryNarrative(advisory: Entity, scenario: Entity): string {
  const periodStart = advisory.observationPeriod?.start ?? '';
  const periodEnd = advisory.observationPeriod?.end ?? '';
  const affectedRegions = list(advisory.affectedRegionNames ?? advisory.affectedRegionIds) || 'not specified';
  const persistence = advisory.persistenceThrough
    ? ` with ${confidenceText(advisory.persistenceProbability)} persistence probability through ${advisory.persistenceThrough}`
    : '';
  const observationPeriod = periodStart && periodEnd ? ` observed from ${periodStart} to ${periodEnd}` : '';
  return `${advisoryName(advisory, scenario)} reports ${String(advisory.signalType ?? 'climate')} conditions${observationPeriod}${persistence}. Affected regions: ${affectedRegions}. Confidence ${confidenceText(advisory.confidence)}.`;
}

function advisoryTags(advisory: Entity, scenario: Entity): string {
  const provider = weatherProvider(scenario);
  return list([advisory.provenance ?? scenarioExternalSignal(scenario).provenance, advisory.signalType, provider.shortName, 'advisory']);
}

function summaryValue(summary: Entity, names: string[]): unknown {
  for (const name of names) {
    const value = summary[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function briefingNarrative(briefing: Entity, scenario: Entity): string {
  const provider = weatherProvider(scenario);
  const summaries = ((briefing.regionSummaries ?? []) as Entity[]).filter((summary) =>
    Boolean(summary.signalAffected ?? summary.signalAffectedFlag),
  );
  const affectedText = summaries
    .map((summary) => {
      const uv = summaryValue(summary, ['meanUvIndexAnomalyP50', 'uvIndexAnomalyP50']);
      const temperature = summaryValue(summary, [
        'meanTemperatureAnomalyCP50',
        'meanTemperatureMeanAnomalyCP50',
        'temperatureMeanAnomalyCP50',
      ]);
      return `${summary.regionName ?? summary.regionId} (p50 UV anomaly ${signed(uv)}, mean temperature anomaly ${signed(temperature)} C)`;
    })
    .join('; ');
  const confidenceValues = ((briefing.regionSummaries ?? []) as Entity[])
    .map((summary) => Number(summaryValue(summary, ['confidence', 'meanConfidence'])))
    .filter((value) => Number.isFinite(value));
  const confidence =
    confidenceValues.length > 0
      ? `${round(Math.min(...confidenceValues), 2)} to ${round(Math.max(...confidenceValues), 2)}`
      : 'not specified';
  return `${provider.shortName ?? provider.name} forecast briefing ${briefing.issueDate}: ${briefing.horizonDays}-day horizon through ${briefing.horizonEndDate}. Affected-region signal remains above normal in ${affectedText || 'no affected regions'}; regional mean confidence ranges from ${confidence}.`;
}

function supportingValues(value: unknown, scenario: Entity): string {
  if (typeof value !== 'object' || value === null) return String(value ?? '');
  const signal = scenarioExternalSignal(scenario);
  return JSON.stringify({ ...(value as Entity), sourceLabel: signal.sourceLabel });
}

function assertProviderDrift(providerDocument: Entity, scenario: Entity): void {
  const provider = weatherProvider(scenario);
  for (const key of ['providerId', 'name', 'shortName', 'provenance', 'sourceLabel', 'licence', 'refreshCadence', 'issueTimeUtc']) {
    if (providerDocument[key] !== undefined && String(providerDocument[key]) !== String(provider[key])) {
      throw new Error(`weather-provider.json ${key} does not match scenario.weather.provider`);
    }
  }
}

async function readCsvRows(relativePath: string): Promise<Entity[]> {
  const { readFile: read } = await import('node:fs/promises');
  const text = await read(join(DATA_ROOT, relativePath), 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: Entity = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = values[i] ?? '';
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else inQuotes = false;
      } else value += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      values.push(value);
      value = '';
    } else value += char;
  }
  values.push(value);
  return values;
}

export async function generateEvidenceTables(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const provider = weatherProvider(scenario);
  const externalSignal = scenarioExternalSignal(scenario);
  const results: GenerationResult[] = [];

  // --- climate advisories -------------------------------------------------
  const advisories = await readJsonl('lakehouse/external-signals/climate-advisories.jsonl');
  const advisoryWriter = await openCsv('lakehouse/evidence/climate_advisories.csv', [
    'signalId',
    'name',
    'signalType',
    'provenance',
    'sourceLabel',
    'observationPeriodStart',
    'observationPeriodEnd',
    'persistenceThrough',
    'persistenceProbability',
    'confidence',
    'seaSurfaceAnomalyC',
    'affectedRegionIds',
    'affectedRegionNames',
    'unaffectedRegionIds',
    'narrative',
    'tags',
  ]);
  for (const a of advisories) {
    await advisoryWriter.writeRow({
      signalId: a.signalId,
      name: advisoryName(a, scenario),
      signalType: a.signalType,
      provenance: a.provenance ?? externalSignal.provenance ?? provider.provenance,
      sourceLabel: externalSignal.sourceLabel,
      observationPeriodStart: a.observationPeriod?.start ?? '',
      observationPeriodEnd: a.observationPeriod?.end ?? '',
      persistenceThrough: a.persistenceThrough ?? '',
      persistenceProbability: a.persistenceProbability ?? '',
      confidence: a.confidence ?? '',
      seaSurfaceAnomalyC: a.seaSurfaceAnomalyC ?? '',
      affectedRegionIds: list(a.affectedRegionIds),
      affectedRegionNames: list(a.affectedRegionNames),
      unaffectedRegionIds: list(a.unaffectedRegionIds),
      narrative: advisoryNarrative(a, scenario),
      tags: advisoryTags(a, scenario),
    });
  }
  results.push({ file: 'lakehouse/evidence/climate_advisories.csv', rows: await advisoryWriter.close() });

  // --- forecast briefings -------------------------------------------------
  const briefings = await readJsonl('lakehouse/external-signals/forecast-briefings.jsonl');
  const projectedBriefings = briefings.filter((briefing) => includeOutcomeSlice() || isObservable(scenario, String(briefing.issueDate)));
  const briefingWriter = await openCsv('lakehouse/evidence/forecast_briefings.csv', [
    'briefingId',
    'issueDate',
    'horizonDays',
    'forecastTargetStartDate',
    'horizonEndDate',
    'regionIds',
    'narrative',
    'provenance',
    'sourceLabel',
    'isDecisionDay',
  ]);
  const decisionDay = String(scenario.weather.forecast.decisionDayIssue);
  for (const b of projectedBriefings) {
    await briefingWriter.writeRow({
      briefingId: b.briefingId,
      issueDate: b.issueDate,
      horizonDays: b.horizonDays ?? '',
      forecastTargetStartDate: b.forecastTargetStartDate ?? '',
      horizonEndDate: b.horizonEndDate ?? '',
      regionIds: list(b.regionIds),
      narrative: briefingNarrative(b, scenario),
      provenance: b.provenance ?? provider.provenance,
      sourceLabel: provider.sourceLabel,
      isDecisionDay: b.issueDate === decisionDay,
    });
  }
  results.push({ file: 'lakehouse/evidence/forecast_briefings.csv', rows: await briefingWriter.close() });

  // --- per-region briefing detail ----------------------------------------
  const summaryWriter = await openCsv('lakehouse/evidence/forecast_briefing_regions.csv', [
    'briefingId',
    'issueDate',
    'regionId',
    'regionName',
    'meanUvIndexAnomalyP50',
    'meanTemperatureAnomalyCP50',
    'confidence',
    'signalAffected',
  ]);
  for (const b of projectedBriefings) {
    for (const s of (b.regionSummaries ?? []) as Entity[]) {
      await summaryWriter.writeRow({
        briefingId: b.briefingId,
        issueDate: b.issueDate,
        regionId: s.regionId ?? '',
        regionName: s.regionName ?? '',
        meanUvIndexAnomalyP50: summaryValue(s, ['meanUvIndexAnomalyP50', 'uvIndexAnomalyP50']),
        meanTemperatureAnomalyCP50: summaryValue(s, [
          'meanTemperatureAnomalyCP50',
          'meanTemperatureMeanAnomalyCP50',
          'temperatureMeanAnomalyCP50',
        ]),
        confidence: summaryValue(s, ['confidence', 'meanConfidence']),
        signalAffected: summaryValue(s, ['signalAffected', 'signalAffectedFlag']),
      });
    }
  }
  results.push({
    file: 'lakehouse/evidence/forecast_briefing_regions.csv',
    rows: await summaryWriter.close(),
  });

  // --- signal evidence trace ---------------------------------------------
  const trace = await readJsonl('lakehouse/external-signals/signal-evidence-trace.jsonl');
  const traceWriter = await openCsv('lakehouse/evidence/signal_evidence_trace.csv', [
    'hop',
    'relation',
    'fromEntityId',
    'fromLabel',
    'toEntityIds',
    'toLabels',
    'caseId',
    'scopeKey',
    'supportingValues',
  ]);
  for (const t of trace) {
    await traceWriter.writeRow({
      hop: t.hop,
      relation: t.relation,
      fromEntityId: t.fromEntityId,
      fromLabel: t.fromLabel,
      toEntityIds: list(t.toEntityIds),
      toLabels: list(t.toLabels),
      caseId: t.caseId ?? '',
      scopeKey: t.scopeKey ?? '',
      supportingValues: supportingValues(t.supportingValues, scenario),
    });
  }
  results.push({ file: 'lakehouse/evidence/signal_evidence_trace.csv', rows: await traceWriter.close() });

  // --- provider -----------------------------------------------------------
  const providerDocument = await readJson('lakehouse/external-signals/weather-provider.json');
  assertProviderDrift(providerDocument, scenario);
  const providerWriter = await openCsv('lakehouse/evidence/weather_provider.csv', [
    'providerId',
    'name',
    'shortName',
    'provenance',
    'sourceLabel',
    'licence',
    'refreshCadence',
    'issueTimeUtc',
  ]);
  await providerWriter.writeRow({
    providerId: provider.providerId,
    name: provider.name,
    shortName: provider.shortName,
    provenance: provider.provenance,
    sourceLabel: provider.sourceLabel,
    licence: provider.licence ?? '',
    refreshCadence: provider.refreshCadence ?? '',
    issueTimeUtc: provider.issueTimeUtc ?? '',
  });
  results.push({ file: 'lakehouse/evidence/weather_provider.csv', rows: await providerWriter.close() });

  // --- Act 1 demand explanation ------------------------------------------
  //
  // The Act 1 question - "what is driving the increase, and is it likely to
  // continue?" - is really two questions whose evidence is spread across the
  // semantic model, the KQL database and several Lakehouse tables. Answering it
  // by fanning out across all three sources takes over 100 seconds, which is
  // past the data agent's server-side ceiling, so the query is killed and
  // returns HTTP 500.
  //
  // This table performs that join once, at generation time, so the whole
  // question is answerable from six rows in a single query. Every value here is
  // derived from the same sources the agent would otherwise have to visit, and
  // the validator asserts they stay consistent.
  const anomalyRows = await readCsvRows('lakehouse/dashboard/weather-anomaly-by-region.csv');
  const anomalyByRegion = new Map(anomalyRows.map((row) => [String(row.region_id), row]));
  const clock = scenario.clock as Entity;
  const weatherForecast = (scenario.weather as Entity).forecast as Entity;
  const seasonalOutlook = (scenario.weather as Entity).seasonalOutlook as Entity;
  const heroProduct = (scenario.products as Entity[]).find((p) => p.productId === scenario.heroProductId);
  assertCondition(heroProduct, 'hero product missing from scenario.products');

  const explanationWriter = await openCsv('lakehouse/evidence/demand_signal_explanation.csv', [
    'regionId',
    'region',
    'productId',
    'product',
    'signalAffected',
    'forecastUnits30d',
    'actualUnits30d',
    'forecastVariancePct',
    'modelledWeatherUpliftPct',
    'meanUvIndexAnomaly',
    'meanTemperatureAnomalyC',
    'incrementalUnits',
    'incrementalRevenueUsd',
    'signalId',
    'signalName',
    'providerName',
    'provenance',
    'sourceLabel',
    'persistenceProbability',
    'persistenceThrough',
    'observedThrough',
    'forecastHorizonEndsOn',
    'campaignStartsOn',
    'campaignEndsOn',
    'horizonCoversCampaign',
    'explanation',
  ]);

  const unitPrice = Number(scenario.unitPriceUsd);
  const horizonEnd = String(weatherForecast.decisionDayHorizonEnd);
  const campaignEnd = String(clock.campaignEnd);
  const persistence = Number(seasonalOutlook.persistenceProbability);
  const persistenceThrough = String(seasonalOutlook.persistenceThrough);

  for (const region of scenario.regions as Entity[]) {
    const anomaly = anomalyByRegion.get(String(region.regionId));
    assertCondition(anomaly, `weather-anomaly-by-region.csv has no row for ${region.regionId}`);
    const variancePct = Number(region.variancePct);
    const forecastUnits = Number(region.baselineForecastUnits30d);
    const actualUnits = Math.round(forecastUnits * (1 + variancePct / 100));
    const affected = region.signalAffected === true;
    const incrementalUnits = Number(region.incrementalUnits ?? 0);

    // The uplift is modelled from the region's own weather anomalies, so it must
    // reconcile with the observed sales variance. If it ever stops matching, the
    // Act 1 explanation is no longer true and generation should fail loudly.
    const modelledUplift = Number(anomaly.modelled_uplift_pct);
    assertCondition(
      Math.abs(modelledUplift - variancePct) < 0.05,
      `${region.regionId} modelled uplift ${modelledUplift} does not reconcile with variance ${variancePct}`,
    );

    const explanation = affected
      ? `${region.name} runs ${variancePct}% above forecast for ${heroProduct.name}. The modelled weather uplift of ${modelledUplift}% reconciles with that variance and is driven by a UV anomaly of ${signed(anomaly.mean_uv_index_anomaly)} and a temperature anomaly of ${signed(anomaly.mean_temperature_mean_anomaly_c)} C, attributed to ${externalSignal.name} from ${provider.name}. The advisory carries a ${persistence} probability of persisting through ${persistenceThrough}. The 30-day forecast issued on ${clock.asOf} only reaches ${horizonEnd}, so the remainder of the campaign to ${campaignEnd} rests on that seasonal outlook rather than the daily forecast.`
      : `${region.name} is a control region that the advisory does not affect. Its variance of ${variancePct}% and modelled uplift of ${modelledUplift}% are both near zero, which is what separates the signal from ordinary noise.`;

    await explanationWriter.writeRow({
      regionId: region.regionId,
      region: region.name,
      productId: heroProduct.productId,
      product: heroProduct.name,
      signalAffected: affected,
      forecastUnits30d: forecastUnits,
      actualUnits30d: actualUnits,
      forecastVariancePct: variancePct,
      modelledWeatherUpliftPct: modelledUplift,
      meanUvIndexAnomaly: round(Number(anomaly.mean_uv_index_anomaly), 4),
      meanTemperatureAnomalyC: round(Number(anomaly.mean_temperature_mean_anomaly_c), 4),
      incrementalUnits,
      incrementalRevenueUsd: round(incrementalUnits * unitPrice, 2),
      signalId: affected ? externalSignal.signalId : '',
      signalName: affected ? externalSignal.name : '',
      providerName: provider.name,
      provenance: externalSignal.provenance ?? provider.provenance,
      sourceLabel: externalSignal.sourceLabel,
      persistenceProbability: affected ? persistence : '',
      persistenceThrough: affected ? persistenceThrough : '',
      observedThrough: String(clock.asOf),
      forecastHorizonEndsOn: horizonEnd,
      campaignStartsOn: String(clock.campaignStart),
      campaignEndsOn: campaignEnd,
      horizonCoversCampaign: horizonEnd >= campaignEnd,
      explanation,
    });
  }
  results.push({
    file: 'lakehouse/evidence/demand_signal_explanation.csv',
    rows: await explanationWriter.close(),
  });

  // --- Act 2 and Act 3 single-query summaries ------------------------------
  //
  // Same reasoning as the Act 1 table above. "Has anything been approved?" and
  // "what is the capacity conflict?" each span four or five tables, and fanning
  // out across them exceeds the agent's server-side time limit. Pre-joining them
  // here turns each demo question into one query.
  const scenarios = scenario.scenarios as Entity[];
  const commitmentApproved = includeOutcomeSlice();
  const approvedScenarioId = String(scenario.approvedScenarioId);

  const decisionWriter = await openCsv('lakehouse/evidence/campaign_decision_status.csv', [
    'scenarioId',
    'scenarioName',
    'recommended',
    'approved',
    'incrementalBudgetUsd',
    'incrementalUnits',
    'incrementalRevenueUsd',
    'confidence',
    'supplyFeasible',
    'blockedByPolicyId',
    'blockedByPolicyVersion',
    'commitmentExists',
    'governedActionsExecuted',
    'receiptsIssued',
    'decisionState',
    'asOfDate',
    'rationale',
  ]);
  for (const s of scenarios) {
    const isApproved = commitmentApproved && String(s.scenarioId) === approvedScenarioId;
    await decisionWriter.writeRow({
      scenarioId: s.scenarioId,
      scenarioName: s.name,
      recommended: s.recommended === true,
      approved: isApproved,
      incrementalBudgetUsd: s.incrementalBudgetUsd,
      incrementalUnits: s.incrementalUnits,
      incrementalRevenueUsd: s.incrementalRevenueUsd,
      confidence: s.confidence,
      supplyFeasible: s.supplyFeasible,
      blockedByPolicyId: s.blockedByPolicyId ?? '',
      blockedByPolicyVersion: s.blockedByPolicyVersion ?? '',
      commitmentExists: isApproved,
      governedActionsExecuted: commitmentApproved ? (scenario.actions as Entity[]).length : 0,
      receiptsIssued: commitmentApproved ? (scenario.actions as Entity[]).length : 0,
      decisionState: isApproved
        ? 'approved and committed'
        : s.recommended === true
          ? 'recommended, not approved, not committed'
          : 'not recommended',
      asOfDate: String(clock.asOf),
      rationale: s.rationale,
    });
  }
  results.push({
    file: 'lakehouse/evidence/campaign_decision_status.csv',
    rows: await decisionWriter.close(),
  });

  const capacity = scenario.capacityModel as Entity;
  const expected = capacity.expected as Entity;
  const maintenance = scenario.maintenance as Entity;
  const stress = scenario.stressModel as Entity;
  const options = scenario.options as Entity[];
  const recommendedOptionId = String(scenario.recommendedOptionId);

  const capacityWriter = await openCsv('lakehouse/evidence/capacity_conflict_summary.csv', [
    'optionId',
    'optionName',
    'lineId',
    'recommended',
    'requiredRateFactor',
    'requiredUtilisation',
    'expectedOutputUnits',
    'incrementalUnitsDelivered',
    'shortfallUnits',
    'meetsCommitment',
    'policyCompliant',
    'rejectionReason',
    'riskLevel',
    'requiredApproverRole',
    'capacityWithoutMaintenanceUnits',
    'capacityWithMaintenanceUnits',
    'headroomWithMaintenanceUnits',
    'requiredIncrementalUnits',
    'campaignShortfallUnits',
    'maintenanceWindowId',
    'maintenanceOriginalStart',
    'maintenanceOriginalEnd',
    'maintenanceDeferredStart',
    'maintenanceDeferredEnd',
    'deferralDays',
    'projectedStressPctOfThreshold',
    'stressCeilingPct',
    'withinStressCeiling',
    'conflictCause',
  ]);

  const thresholdStress = Number(stress.thresholdStressIndex);
  const projectedStress = Number(stress.projectedStressAtDeferredMaintenance);
  const stressPct = round((projectedStress / thresholdStress) * 100, 2);
  const ceilingPct = Number(stress.stressCeilingPct);

  for (const option of options) {
    await capacityWriter.writeRow({
      optionId: option.optionId,
      optionName: option.name,
      lineId: maintenance.lineId,
      recommended: String(option.optionId) === recommendedOptionId,
      requiredRateFactor: option.requiredRateFactor ?? '',
      requiredUtilisation: option.requiredUtilisation ?? '',
      expectedOutputUnits: option.expectedOutputUnits ?? '',
      incrementalUnitsDelivered: option.incrementalUnitsDelivered ?? '',
      shortfallUnits: option.shortfallUnits ?? '',
      meetsCommitment: option.meetsCommitment ?? '',
      policyCompliant: option.policyCompliant ?? '',
      rejectionReason: option.rejectionReason ?? '',
      riskLevel: option.riskLevel ?? '',
      requiredApproverRole: option.requiredApproverRole ?? '',
      capacityWithoutMaintenanceUnits: expected.capacityWithoutMaintenanceUnits,
      capacityWithMaintenanceUnits: expected.capacityWithMaintenanceUnits,
      headroomWithMaintenanceUnits: expected.headroomWithMaintenanceUnits,
      requiredIncrementalUnits: expected.requiredIncrementalUnits,
      campaignShortfallUnits: expected.shortfallUnits,
      maintenanceWindowId: maintenance.maintenanceWindowId,
      maintenanceOriginalStart: maintenance.originalStart,
      maintenanceOriginalEnd: maintenance.originalEnd,
      maintenanceDeferredStart: maintenance.deferredStart,
      maintenanceDeferredEnd: maintenance.deferredEnd,
      deferralDays: maintenance.deferralDays,
      projectedStressPctOfThreshold: stressPct,
      stressCeilingPct: ceilingPct,
      withinStressCeiling: stressPct <= ceilingPct,
      conflictCause: expected.conflictCause,
    });
  }
  results.push({
    file: 'lakehouse/evidence/capacity_conflict_summary.csv',
    rows: await capacityWriter.close(),
  });

  // --- assertions: the projections must not drift from the documents ------
  const advisoryRows = results.find((r) => r.file.endsWith('climate_advisories.csv'))!.rows;
  if (advisoryRows !== advisories.length) {
    throw new Error(`climate_advisories.csv has ${advisoryRows} rows, expected ${advisories.length}`);
  }
  const hero = advisories.find((a) => a.signalId === scenario.externalSignal.signalId);
  if (!hero) throw new Error(`advisory ${scenario.externalSignal.signalId} missing from the projection`);
  if (Number(hero.persistenceProbability) !== Number(scenario.externalSignal.persistenceProbability)) {
    throw new Error('advisory persistence probability does not match the scenario contract');
  }
  if (!projectedBriefings.some((b) => b.issueDate === decisionDay)) {
    throw new Error(`no forecast briefing issued on the decision day ${decisionDay}`);
  }
  const traceRows = results.find((r) => r.file.endsWith('signal_evidence_trace.csv'))!.rows;
  if (traceRows !== scenario.evidenceChain.hops.length) {
    throw new Error(
      `signal_evidence_trace.csv has ${traceRows} hops, expected ${scenario.evidenceChain.hops.length}`,
    );
  }
  for (const r of results) {
    if (r.rows === 0) throw new Error(`${r.file} is empty`);
  }

  return results;
}
