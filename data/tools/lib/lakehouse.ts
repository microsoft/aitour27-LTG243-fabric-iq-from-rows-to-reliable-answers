// Lakehouse, retrieval, evaluation and receipt artifacts for the Caldova
// dataset. Runs directly on Node.js 24+ via native type
// stripping, so this file intentionally avoids TS features that require emit.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DATA_ROOT,
  addDays,
  addMinutes,
  allocateIntegers,
  asOfDate,
  createRng,
  daysBetween,
  eachDate,
  includeOutcomeSlice,
  isObservable,
  loadScenario,
  openCsv,
  openJsonl,
  parseDate,
  round,
  toDateString,
  toIsoSeconds,
  writeJson,
} from './core.ts';
import type { GenerationResult, Scenario } from './core.ts';

type Entity = Record<string, any>;
type EntityMap = Map<string, Entity>;

type Lookups = {
  scenario: Scenario;
  heroProduct: Entity;
  products: Entity[];
  productById: EntityMap;
  regions: Entity[];
  regionById: EntityMap;
  campaigns: Entity[];
  campaignById: EntityMap;
  lines: Entity[];
  lineById: EntityMap;
  policies: Entity[];
  policyByKey: EntityMap;
  actions: Entity[];
  actionById: EntityMap;
  assumptions: Entity[];
  assumptionById: EntityMap;
  scenarios: Entity[];
  scenarioById: EntityMap;
  options: Entity[];
  optionById: EntityMap;
  roleIds: Set<string>;
  personaIds: Set<string>;
};

type RetrievalChunk = {
  chunkId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  text: string;
  scopeKey: string | null;
  tags: string[];
  caseId: string | null;
};

type AdvisoryRecord = Entity;
type DecisionCaseRecord = Entity;
type TimelineRecord = Entity;
type ForecastVarianceRow = Record<string, string | number | boolean>;
type HeroTrendRow = Record<string, string | number | boolean>;
type CampaignPerformanceRow = Record<string, string | number | boolean>;
type ForecastAssumptionRow = Record<string, string | number | boolean>;
type WeatherObservation = {
  date: string;
  regionId: string;
  temperatureMeanC: number;
  uvIndex: number;
  uvAlertLevel: string;
  temperatureMeanAnomalyC: number;
  uvIndexAnomaly: number;
};
type WeatherForecast = {
  issueDate: string;
  targetDate: string;
  leadDays: number;
  regionId: string;
  uvIndexP10: number;
  uvIndexP50: number;
  uvIndexP90: number;
  temperatureMeanAnomalyCP50: number;
  uvIndexAnomalyP50: number;
  confidence: number;
};
type WeatherEvent = {
  eventId: string;
  eventType: string;
  regionId: string;
  severity: string;
  startDate: string;
  endDate: string;
  peakValue: number;
  peakMetric: string;
  signalId: string | null;
  relevantToHeroProduct: boolean;
  headline: string;
};
type WeatherInputs = {
  observations: WeatherObservation[];
  forecasts: WeatherForecast[];
  events: WeatherEvent[];
};
type WeatherAnomalyRow = Record<string, string | number | boolean>;
type WeatherForecastOutlookRow = Record<string, string | number | boolean>;
type WeatherDemandReconciliationRow = Record<string, string | number | boolean>;
type ForecastBriefingRecord = Entity;
type WeatherContext = {
  provider: Entity;
  events: Entity[];
  briefings: ForecastBriefingRecord[];
  anomalyRows: WeatherAnomalyRow[];
  forecastOutlookRows: WeatherForecastOutlookRow[];
  reconciliationRows: WeatherDemandReconciliationRow[];
  decisionBriefing: ForecastBriefingRecord;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`lakehouse generator: ${message}`);
}

function arrayOf(value: unknown, name: string): Entity[] {
  assert(Array.isArray(value), `${name} must be an array in scenario.json`);
  return value as Entity[];
}

function strings(value: unknown, name: string): string[] {
  assert(Array.isArray(value), `${name} must be an array in scenario.json`);
  for (const item of value) assert(typeof item === 'string', `${name} contains a non-string value`);
  return value as string[];
}

function includePostDecisionFacts(): boolean {
  return includeOutcomeSlice();
}

function dateFromAsOf(lookups: Lookups, offsetDays: number): string {
  return toDateString(addDays(parseDate(asOfDate(lookups.scenario)), offsetDays));
}

function timestampFromAsOf(lookups: Lookups, offsetDays: number, timeUtc: string): string {
  return `${dateFromAsOf(lookups, offsetDays)}T${timeUtc}`;
}

function isVisibleObservedFact(lookups: Lookups, value: string): boolean {
  return includePostDecisionFacts() || isObservable(lookups.scenario, value);
}

function advisoryWindowFromAsOf(
  lookups: Lookups,
  startOffsetDays: number,
  endOffsetDays: number,
  persistenceOffsetDays: number,
): { start: string; end: string; persistenceThrough: string } {
  const start = dateFromAsOf(lookups, startOffsetDays);
  const end = dateFromAsOf(lookups, endOffsetDays);
  const persistenceThrough = dateFromAsOf(lookups, persistenceOffsetDays);
  assert(start <= end, `advisory window ${start} to ${end} is invalid`);
  assert(end <= persistenceThrough, `advisory persistence ${persistenceThrough} is before ${end}`);
  return { start, end, persistenceThrough };
}

function signalIdFromDate(prefix: string, date: string): string {
  return `${prefix}-${date.slice(0, 7)}`;
}

function mapBy(items: Entity[], key: string, label: string): EntityMap {
  const out = new Map<string, Entity>();
  for (const item of items) {
    const id = item[key];
    assert(typeof id === 'string' && id.length > 0, `${label} entry is missing ${key}`);
    assert(!out.has(id), `${label} contains duplicate ${key} ${id}`);
    out.set(id, item);
  }
  return out;
}

function policyKey(policyId: string, version: string): string {
  return `${policyId}:${version}`;
}

function policyKeyFromBasis(value: string): string {
  const index = value.lastIndexOf(':');
  assert(index > 0 && index < value.length - 1, `invalid policy basis ${value}`);
  return policyKey(value.slice(0, index), value.slice(index + 1));
}

function requireEntity(map: EntityMap, id: string, label: string, context: string): Entity {
  const entity = map.get(id);
  assert(entity, `${context} references missing ${label} id ${id}`);
  return entity;
}

function requirePolicy(lookups: Lookups, policyId: string, version: string, context: string): Entity {
  const policy = lookups.policyByKey.get(policyKey(policyId, version));
  assert(policy, `${context} references missing policy ${policyId} v${version}`);
  return policy;
}

function requireRole(lookups: Lookups, roleId: string, context: string): void {
  assert(lookups.roleIds.has(roleId), `${context} references missing approver role ${roleId}`);
}

function requirePersona(lookups: Lookups, personaId: string, context: string): void {
  assert(lookups.personaIds.has(personaId), `${context} references missing persona ${personaId}`);
}

function requireAssumption(lookups: Lookups, assumptionId: string, context: string): Entity {
  return requireEntity(lookups.assumptionById, assumptionId, 'forecast assumption', context);
}

function requireOption(lookups: Lookups, optionId: string, context: string): Entity {
  return requireEntity(lookups.optionById, optionId, 'production option', context);
}

function requireScenarioOption(lookups: Lookups, scenarioId: string, context: string): Entity {
  return requireEntity(lookups.scenarioById, scenarioId, 'commercial scenario', context);
}

function buildLookups(scenario: Scenario): Lookups {
  const products = arrayOf(scenario.products, 'products');
  const regions = arrayOf(scenario.regions, 'regions');
  const campaigns = arrayOf(scenario.campaigns, 'campaigns');
  const lines = arrayOf(scenario.productionLines, 'productionLines');
  const policies = arrayOf(scenario.policies, 'policies');
  const actions = arrayOf(scenario.actions, 'actions');
  const assumptions = arrayOf(scenario.forecast?.assumptions, 'forecast.assumptions');
  const scenarios = arrayOf(scenario.scenarios, 'scenarios');
  const options = arrayOf(scenario.options, 'options');
  const personas = arrayOf(scenario.personas, 'personas');

  const productById = mapBy(products, 'productId', 'products');
  const heroProduct = requireEntity(productById, scenario.heroProductId, 'product', 'heroProductId');
  const policyByKey = new Map<string, Entity>();
  for (const policy of policies) {
    const id = policy.policyId;
    const version = policy.version;
    assert(typeof id === 'string' && typeof version === 'string', 'policy is missing policyId or version');
    const key = policyKey(id, version);
    assert(!policyByKey.has(key), `policies contains duplicate ${key}`);
    policyByKey.set(key, policy);
  }

  return {
    scenario,
    heroProduct,
    products,
    productById,
    regions,
    regionById: mapBy(regions, 'regionId', 'regions'),
    campaigns,
    campaignById: mapBy(campaigns, 'campaignId', 'campaigns'),
    lines,
    lineById: mapBy(lines, 'lineId', 'productionLines'),
    policies,
    policyByKey,
    actions,
    actionById: mapBy(actions, 'actionId', 'actions'),
    assumptions,
    assumptionById: mapBy(assumptions, 'assumptionId', 'forecast.assumptions'),
    scenarios,
    scenarioById: mapBy(scenarios, 'scenarioId', 'scenarios'),
    options,
    optionById: mapBy(options, 'optionId', 'options'),
    roleIds: new Set(strings(scenario.approverRoles, 'approverRoles')),
    personaIds: new Set(personas.map((p) => String(p.personaId))),
  };
}

function validateScenario(lookups: Lookups): void {
  const { scenario } = lookups;
  assert(scenario.containsPersonLevelBusinessData === false, 'scenario must not contain person-level business data');
  assert(scenario.externalSignal?.provenance === 'external', 'externalSignal.provenance must be external');
  assert(typeof scenario.externalSignal?.sourceLabel === 'string', 'externalSignal.sourceLabel is required');
  assert(typeof scenario.retrieval?.futureSignalId === 'string', 'retrieval.futureSignalId is required');
  assert(typeof scenario.retrieval?.futureQuery === 'string', 'retrieval.futureQuery is required');
  validateWeatherScenario(lookups);

  for (const region of lookups.regions) {
    assert(typeof region.regionId === 'string', 'region missing regionId');
    assert(typeof region.name === 'string', `region ${region.regionId} missing name`);
  }
  for (const campaign of lookups.campaigns) {
    requireEntity(lookups.regionById, campaign.regionId, 'region', `campaign ${campaign.campaignId}`);
  }
  for (const signalRegionId of strings(scenario.externalSignal.affectedRegionIds, 'externalSignal.affectedRegionIds')) {
    requireEntity(lookups.regionById, signalRegionId, 'region', `external signal ${scenario.externalSignal.signalId}`);
  }
  for (const signalRegionId of strings(scenario.externalSignal.unaffectedRegionIds, 'externalSignal.unaffectedRegionIds')) {
    requireEntity(lookups.regionById, signalRegionId, 'region', `external signal ${scenario.externalSignal.signalId}`);
  }

  const affectedIncrementalUnits = scenario.externalSignal.affectedRegionIds
    .map((id: string) => requireEntity(lookups.regionById, id, 'region', 'externalSignal.affectedRegionIds'))
    .reduce((sum: number, region: Entity) => sum + Number(region.incrementalUnits), 0);
  assert(
    affectedIncrementalUnits === scenario.opportunity.incrementalUnits,
    `affected region incremental units ${affectedIncrementalUnits} do not match opportunity.incrementalUnits`,
  );
  assert(
    round(affectedIncrementalUnits * Number(scenario.unitPriceUsd), 2) === Number(scenario.opportunity.incrementalRevenueUsd),
    'opportunity revenue must equal affected incremental units times unit price',
  );

  for (const assumption of lookups.assumptions) {
    if (assumption.invalidatedBySignalId !== null) {
      assert(
        assumption.invalidatedBySignalId === scenario.externalSignal.signalId,
        `assumption ${assumption.assumptionId} references unknown signal ${assumption.invalidatedBySignalId}`,
      );
    }
  }
  for (const hop of arrayOf(scenario.evidenceChain?.hops, 'evidenceChain.hops')) {
    validateEvidenceHop(lookups, hop);
  }
  for (const commercialScenario of lookups.scenarios) {
    if (commercialScenario.blockedByPolicyId) {
      requirePolicy(
        lookups,
        commercialScenario.blockedByPolicyId,
        commercialScenario.blockedByPolicyVersion,
        `scenario ${commercialScenario.scenarioId}`,
      );
    }
  }
  requireScenarioOption(lookups, scenario.approvedScenarioId, 'approvedScenarioId');
  requireOption(lookups, scenario.recommendedOptionId, 'recommendedOptionId');

  const commitment = scenario.commitment;
  requireScenarioOption(lookups, commitment.scenarioId, `commitment ${commitment.commitmentId}`);
  requireEntity(lookups.productById, commitment.productId, 'product', `commitment ${commitment.commitmentId}`);
  assert(commitment.launchPlanId === scenario.launchPlan.launchPlanId, `commitment ${commitment.commitmentId} references missing launch plan`);
  assert(commitment.originSignalId === scenario.externalSignal.signalId, `commitment ${commitment.commitmentId} references missing signal`);
  assert(commitment.originCaseId === scenario.decisionCase.caseId, `commitment ${commitment.commitmentId} references missing case`);
  requireRole(lookups, commitment.approvedByRole, `commitment ${commitment.commitmentId}`);
  requirePersona(lookups, commitment.approvedByPersonaId, `commitment ${commitment.commitmentId}`);

  for (const line of lookups.lines) {
    assert(
      arrayOf(scenario.plants, 'plants').some((plant) => plant.plantId === line.plantId),
      `line ${line.lineId} references missing plant ${line.plantId}`,
    );
  }
  requireEntity(lookups.lineById, scenario.capacityModel.lineId, 'production line', 'capacityModel');
  requireEntity(lookups.lineById, scenario.maintenance.lineId, 'production line', 'maintenance');

  for (const option of lookups.options) {
    requireRole(lookups, option.requiredApproverRole, `option ${option.optionId}`);
    if (option.secondaryApproverRole) requireRole(lookups, option.secondaryApproverRole, `option ${option.optionId}`);
    if (option.alternateLineId) requireEntity(lookups.lineById, option.alternateLineId, 'production line', `option ${option.optionId}`);
    for (const basis of option.policyBasis ?? []) {
      assert(lookups.policyByKey.has(policyKeyFromBasis(basis)), `option ${option.optionId} references missing policy basis ${basis}`);
    }
  }

  const decisionCase = scenario.decisionCase;
  requireEntity(lookups.productById, decisionCase.concernsProductId, 'product', `decision case ${decisionCase.caseId}`);
  for (const applied of decisionCase.appliedPolicies) {
    requirePolicy(lookups, applied.policyId, applied.version, `decision case ${decisionCase.caseId}`);
  }
  for (const correction of decisionCase.corrections) {
    requireRole(lookups, correction.proposedByRole, `correction ${correction.correctionId}`);
    requireRole(lookups, correction.approvedByRole, `correction ${correction.correctionId}`);
  }
  for (const action of lookups.actions) {
    requireRole(lookups, action.approvedByRole, `action ${action.actionId}`);
    if (action.approvedByPersonaId) requirePersona(lookups, action.approvedByPersonaId, `action ${action.actionId}`);
    if (action.details?.lineId) requireEntity(lookups.lineById, action.details.lineId, 'production line', `action ${action.actionId}`);
    if (action.details?.optionId) requireOption(lookups, action.details.optionId, `action ${action.actionId}`);
    if (action.details?.scenarioId) requireScenarioOption(lookups, action.details.scenarioId, `action ${action.actionId}`);
    if (action.details?.policyId) requirePolicy(lookups, action.details.policyId, action.details.policyVersion, `action ${action.actionId}`);
  }
  assert(
    scenario.retrieval.mustRetrieveCaseId === decisionCase.caseId,
    'retrieval.mustRetrieveCaseId must point to the decisionCase.caseId',
  );
}

function validateWeatherScenario(lookups: Lookups): void {
  const { scenario } = lookups;
  const weather = requireWeather(lookups);
  const provider = weatherProviderConfig(lookups);
  assert(typeof provider.providerId === 'string' && provider.providerId.length > 0, 'weather.provider.providerId is required');
  assert(typeof provider.name === 'string' && provider.name.length > 0, 'weather.provider.name is required');
  assert(typeof provider.shortName === 'string' && provider.shortName.length > 0, 'weather.provider.shortName is required');
  assert(provider.provenance === 'external', 'weather.provider.provenance must be external');
  assert(typeof provider.sourceLabel === 'string' && provider.sourceLabel.length > 0, 'weather.provider.sourceLabel is required');
  assert(typeof provider.licence === 'string' && provider.licence.length > 0, 'weather.provider.licence is required');
  assert(typeof provider.refreshCadence === 'string' && provider.refreshCadence.length > 0, 'weather.provider.refreshCadence is required');
  assert(typeof provider.issueTimeUtc === 'string' && provider.issueTimeUtc.length > 0, 'weather.provider.issueTimeUtc is required');
  strings(weather.variables, 'weather.variables');
  strings(weather.anomalyVariables, 'weather.anomalyVariables');

  const climatology = weather.climatology;
  assert(climatology && typeof climatology === 'object', 'weather.climatology is required');
  for (const field of ['baselinePeriodStart', 'baselinePeriodEnd', 'baselineLabel', 'grain']) {
    assert(typeof climatology[field] === 'string' && climatology[field].length > 0, `weather.climatology.${field} is required`);
  }

  const forecast = weather.forecast;
  assert(forecast && typeof forecast === 'object', 'weather.forecast is required');
  assert(Number.isInteger(Number(forecast.horizonDays)) && Number(forecast.horizonDays) > 0, 'weather.forecast.horizonDays must be positive');
  assert(forecast.decisionDayIssue === scenario.clock.decisionDay, 'weather.forecast.decisionDayIssue must match clock.decisionDay');
  assert(typeof forecast.decisionDayHorizonEnd === 'string' && forecast.decisionDayHorizonEnd.length > 0, 'weather.forecast.decisionDayHorizonEnd is required');
  assert(
    toDateString(parseDate(forecast.decisionDayHorizonEnd)) === forecast.decisionDayHorizonEnd,
    'weather.forecast.decisionDayHorizonEnd must be a valid YYYY-MM-DD date',
  );
  assert(
    forecast.decisionDayHorizonEnd >= forecast.decisionDayIssue,
    'weather.forecast.decisionDayHorizonEnd must be on or after weather.forecast.decisionDayIssue',
  );
  assert(Array.isArray(forecast.quantiles) && forecast.quantiles.length > 0, 'weather.forecast.quantiles is required');

  const outlook = weatherSeasonalOutlook(lookups);
  assert(outlook.signalId === scenario.externalSignal.signalId, 'weather.seasonalOutlook.signalId must match externalSignal.signalId');
  assert(
    outlook.persistenceThrough === scenario.externalSignal.persistenceThrough,
    'weather.seasonalOutlook.persistenceThrough must match externalSignal.persistenceThrough',
  );
  assert(
    Number(outlook.persistenceProbability) === Number(scenario.externalSignal.persistenceProbability),
    'weather.seasonalOutlook.persistenceProbability must match externalSignal.persistenceProbability',
  );

  const demandResponse = weatherDemandResponse(lookups);
  assert(typeof demandResponse.modelId === 'string' && demandResponse.modelId.length > 0, 'weather.demandResponse.modelId is required');
  assert(Number.isFinite(Number(demandResponse.betaUv)), 'weather.demandResponse.betaUv must be numeric');
  assert(Number.isFinite(Number(demandResponse.betaTempC)), 'weather.demandResponse.betaTempC must be numeric');
  assert(Number.isFinite(Number(demandResponse.tolerancePct)), 'weather.demandResponse.tolerancePct must be numeric');

  const climateRows = arrayOf(weather.regionClimate, 'weather.regionClimate');
  assert(climateRows.length === lookups.regions.length, 'weather.regionClimate must cover every region');
  const climateRegionIds = new Set<string>();
  for (const climate of climateRows) {
    requireEntity(lookups.regionById, climate.regionId, 'region', `weather.regionClimate ${climate.stationId ?? ''}`);
    assert(!climateRegionIds.has(climate.regionId), `weather.regionClimate duplicates ${climate.regionId}`);
    climateRegionIds.add(climate.regionId);
    assert(typeof climate.stationId === 'string' && climate.stationId.length > 0, `weather.regionClimate ${climate.regionId} missing stationId`);
    assert(typeof climate.stationName === 'string' && climate.stationName.length > 0, `weather.regionClimate ${climate.regionId} missing stationName`);
  }

  const intensityRows = arrayOf(weather.regionIntensity, 'weather.regionIntensity');
  assert(intensityRows.length === lookups.regions.length, 'weather.regionIntensity must cover every region');
  const intensityRegionIds = new Set<string>();
  for (const intensity of intensityRows) {
    const region = requireEntity(lookups.regionById, intensity.regionId, 'region', 'weather.regionIntensity');
    assert(!intensityRegionIds.has(intensity.regionId), `weather.regionIntensity duplicates ${intensity.regionId}`);
    intensityRegionIds.add(intensity.regionId);
    assert(Number.isFinite(Number(intensity.uvIndexAnomaly)), `weather.regionIntensity ${intensity.regionId} missing uvIndexAnomaly`);
    assert(Number.isFinite(Number(intensity.temperatureMeanAnomalyC)), `weather.regionIntensity ${intensity.regionId} missing temperatureMeanAnomalyC`);
    assert(
      Math.abs(Number(intensity.targetUpliftPct) - Number(region.variancePct)) <= Number(demandResponse.tolerancePct),
      `weather.regionIntensity ${intensity.regionId} target uplift does not match region variance`,
    );
  }

  const eventTypes = new Set<string>();
  for (const eventType of arrayOf(weather.eventCatalogue, 'weather.eventCatalogue')) {
    assert(typeof eventType.eventType === 'string' && eventType.eventType.length > 0, 'weather.eventCatalogue entry missing eventType');
    assert(!eventTypes.has(eventType.eventType), `weather.eventCatalogue duplicates ${eventType.eventType}`);
    eventTypes.add(eventType.eventType);
    assert(typeof eventType.name === 'string' && eventType.name.length > 0, `weather.eventCatalogue ${eventType.eventType} missing name`);
    assert(typeof eventType.severityScale === 'string' && eventType.severityScale.length > 0, `weather.eventCatalogue ${eventType.eventType} missing severityScale`);
    assert(typeof eventType.relevantToHeroProduct === 'boolean', `weather.eventCatalogue ${eventType.eventType} missing relevantToHeroProduct`);
  }
}

function validateEvidenceHop(lookups: Lookups, hop: Entity): void {
  const relation = hop.relation;
  const toIds = Array.isArray(hop.to) ? hop.to : [hop.to];
  if (relation === 'signal_affects_region') {
    assert(hop.from === lookups.scenario.externalSignal.signalId, `evidence hop ${hop.step} references missing signal ${hop.from}`);
    for (const id of toIds) requireEntity(lookups.regionById, id, 'region', `evidence hop ${hop.step}`);
  } else if (relation === 'region_sells_product') {
    assert(hop.from === 'regions', `evidence hop ${hop.step} must start from regions`);
    for (const id of toIds) requireEntity(lookups.productById, id, 'product', `evidence hop ${hop.step}`);
  } else if (relation === 'product_promoted_by_active_campaign') {
    requireEntity(lookups.productById, hop.from, 'product', `evidence hop ${hop.step}`);
    for (const id of toIds) requireEntity(lookups.campaignById, id, 'campaign', `evidence hop ${hop.step}`);
  } else if (relation === 'campaign_built_on_forecast_version') {
    assert(hop.from === 'campaigns', `evidence hop ${hop.step} must start from campaigns`);
    assert(typeof hop.to === 'string' && hop.to.length > 0, `evidence hop ${hop.step} missing forecast id`);
  } else if (relation === 'forecast_assumption_invalidated') {
    assert(typeof hop.from === 'string' && hop.from.length > 0, `evidence hop ${hop.step} missing forecast id`);
    for (const id of toIds) requireAssumption(lookups, id, `evidence hop ${hop.step}`);
  } else {
    throw new Error(`lakehouse generator: unrecognized evidence relation ${relation}`);
  }
}

function affectedRegions(lookups: Lookups): Entity[] {
  return lookups.scenario.externalSignal.affectedRegionIds.map((id: string) =>
    requireEntity(lookups.regionById, id, 'region', 'externalSignal.affectedRegionIds'),
  );
}

function unaffectedRegions(lookups: Lookups): Entity[] {
  return lookups.scenario.externalSignal.unaffectedRegionIds.map((id: string) =>
    requireEntity(lookups.regionById, id, 'region', 'externalSignal.unaffectedRegionIds'),
  );
}

function actualUnitsForVariance(region: Entity): number {
  return Math.round(Number(region.baselineForecastUnits30d) * (1 + Number(region.variancePct) / 100));
}

function formatPct(value: number): string {
  return `${round(value, 2)}%`;
}

function formatUsd(value: number): string {
  return `${round(value, 2)} USD`;
}

function buildWeatherProvider(lookups: Lookups): Entity {
  const weather = requireWeather(lookups);
  const provider = weatherProviderConfig(lookups);
  const stations = arrayOf(weather.regionClimate, 'weather.regionClimate')
    .slice()
    .sort((a, b) => byRegionOrder(lookups, a.regionId, b.regionId))
    .map((station) => {
      const region = requireEntity(lookups.regionById, station.regionId, 'region', `weather provider station ${station.stationId}`);
      return {
        regionId: region.regionId,
        regionName: region.name,
        stationId: station.stationId,
        stationName: station.stationName,
      };
    });

  return {
    providerId: provider.providerId,
    name: provider.name,
    shortName: provider.shortName,
    provenance: provider.provenance,
    sourceLabel: provider.sourceLabel,
    licence: provider.licence,
    refreshCadence: provider.refreshCadence,
    issueTimeUtc: provider.issueTimeUtc,
    variablesPublished: strings(weather.variables, 'weather.variables'),
    anomalyVariablesPublished: strings(weather.anomalyVariables, 'weather.anomalyVariables'),
    climatology: weather.climatology,
    observationWindow: weather.observationWindow,
    forecastPublication: weather.forecast,
    stationCoverage: {
      stationCount: stations.length,
      regionsCovered: stations.map((station) => station.regionId),
      stations,
    },
  };
}

function knownSignalIds(advisories: AdvisoryRecord[]): Set<string> {
  return new Set(advisories.map((advisory) => String(advisory.signalId)));
}

function buildWeatherEventDocuments(lookups: Lookups, events: WeatherEvent[], advisories: AdvisoryRecord[]): Entity[] {
  const signalIds = knownSignalIds(advisories);
  const catalogueByType = weatherEventCatalogueByType(lookups);
  const provider = weatherProviderConfig(lookups);

  return events
    .slice()
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        byRegionOrder(lookups, a.regionId, b.regionId) ||
        a.eventId.localeCompare(b.eventId),
    )
    .map((event) => {
      const region = requireEntity(lookups.regionById, event.regionId, 'region', `weather event ${event.eventId}`);
      const catalogue = requireEntity(catalogueByType, event.eventType, 'weather event type', `weather event ${event.eventId}`);
      const severityValues = String(catalogue.severityScale).split('|');
      assert(severityValues.includes(event.severity), `weather event ${event.eventId} has invalid severity ${event.severity}`);
      if (event.signalId) assert(signalIds.has(event.signalId), `weather event ${event.eventId} references unknown signal ${event.signalId}`);
      assert(
        event.relevantToHeroProduct === Boolean(catalogue.relevantToHeroProduct),
        `weather event ${event.eventId} relevance contradicts weather.eventCatalogue`,
      );
      assert(parseDate(event.endDate).getTime() >= parseDate(event.startDate).getTime(), `weather event ${event.eventId} ends before it starts`);
      const durationDays = daysBetween(event.startDate, event.endDate);
      const relevancePhrase = event.relevantToHeroProduct ? `relevant to ${lookups.heroProduct.name}` : `not relevant to ${lookups.heroProduct.name}`;
      return {
        eventId: event.eventId,
        eventType: event.eventType,
        eventName: catalogue.name,
        regionId: region.regionId,
        regionName: region.name,
        severity: event.severity,
        startDate: event.startDate,
        endDate: event.endDate,
        durationDays,
        peakValue: event.peakValue,
        peakMetric: event.peakMetric,
        signalId: event.signalId,
        relevantToHeroProduct: event.relevantToHeroProduct,
        headline: event.headline,
        narrative: `${provider.shortName} reports ${event.headline}. The ${catalogue.name} event ${event.eventId} affected ${region.name} from ${event.startDate} to ${event.endDate} (${durationDays} days), peaked at ${event.peakValue} ${event.peakMetric}, carried ${event.severity} severity, and is ${relevancePhrase}.`,
        tags: [
          'external',
          'weather',
          event.eventType,
          event.severity,
          String(region.marketCode).toLowerCase(),
          event.relevantToHeroProduct ? 'hero-product-relevant' : 'distractor',
          event.signalId ? 'signal-linked' : 'unlinked',
        ],
        provenance: provider.provenance,
        sourceLabel: provider.sourceLabel,
      };
    });
}

function buildWeatherAnomalyRows(lookups: Lookups, observations: WeatherObservation[]): WeatherAnomalyRow[] {
  const provider = weatherProviderConfig(lookups);
  const demandResponse = weatherDemandResponse(lookups);
  const start = lookups.scenario.clock.varianceWindowStart;
  const end = lookups.scenario.clock.varianceWindowEnd;
  const expectedDays = daysBetween(start, end);
  const betaUv = Number(demandResponse.betaUv);
  const betaTempC = Number(demandResponse.betaTempC);
  const tolerancePct = Number(demandResponse.tolerancePct);
  const seen = new Set<string>();

  for (const observation of observations) {
    if (observation.date < start || observation.date > end) continue;
    const key = `${observation.regionId}:${observation.date}`;
    assert(!seen.has(key), `WeatherObservationsDaily.csv duplicates ${key}`);
    seen.add(key);
  }

  return lookups.regions.map((region) => {
    const rows = observations.filter((observation) => observation.regionId === region.regionId && observation.date >= start && observation.date <= end);
    assert(rows.length === expectedDays, `WeatherObservationsDaily.csv expected ${expectedDays} variance-window rows for ${region.regionId}, got ${rows.length}`);
    const meanUvIndexAnomaly = mean(rows.map((row) => row.uvIndexAnomaly), `weather anomaly ${region.regionId}`);
    const meanTemperatureMeanAnomalyC = mean(rows.map((row) => row.temperatureMeanAnomalyC), `weather anomaly ${region.regionId}`);
    const modelledUpliftPct = round(betaUv * meanUvIndexAnomaly + betaTempC * meanTemperatureMeanAnomalyC, 2);
    assert(
      Math.abs(modelledUpliftPct - Number(region.variancePct)) <= tolerancePct,
      `weather modelled uplift ${modelledUpliftPct} for ${region.regionId} does not match variance ${region.variancePct}`,
    );
    return {
      region_id: region.regionId,
      region: region.name,
      variance_window_start: start,
      variance_window_end: end,
      mean_uv_index_anomaly: round(meanUvIndexAnomaly, 4),
      mean_temperature_mean_anomaly_c: round(meanTemperatureMeanAnomalyC, 4),
      signal_affected_flag: Boolean(region.signalAffected),
      model_id: demandResponse.modelId,
      modelled_uplift_pct: modelledUpliftPct,
      provenance: provider.provenance,
      source_label: provider.sourceLabel,
    };
  });
}

function forecastIssueHorizonEnd(lookups: Lookups, issueDate: string): string {
  const weather = requireWeather(lookups);
  if (issueDate === weather.forecast.decisionDayIssue) return weather.forecast.decisionDayHorizonEnd;
  return toDateString(addDays(parseDate(issueDate), Number(weather.forecast.horizonDays)));
}

function forecastTargetStart(issueDate: string): string {
  return toDateString(addDays(parseDate(issueDate), 1));
}

function forecastTargetDaysForIssue(lookups: Lookups, issueDate: string): number {
  const targetStart = forecastTargetStart(issueDate);
  const horizonEnd = forecastIssueHorizonEnd(lookups, issueDate);
  assert(horizonEnd >= targetStart, `forecast issue ${issueDate} horizon ends before its first target date`);
  return daysBetween(targetStart, horizonEnd);
}

function forecastRowsForIssue(lookups: Lookups, forecasts: WeatherForecast[], issueDate: string, context: string): WeatherForecast[] {
  const expectedTargetDays = forecastTargetDaysForIssue(lookups, issueDate);
  const horizonEnd = forecastIssueHorizonEnd(lookups, issueDate);
  const targetStart = forecastTargetStart(issueDate);
  const rows = forecasts.filter((row) => row.issueDate === issueDate && row.targetDate >= targetStart && row.targetDate <= horizonEnd);
  assert(
    rows.length === lookups.regions.length * expectedTargetDays,
    `${context} expected ${lookups.regions.length * expectedTargetDays} forecast rows for issue ${issueDate}, got ${rows.length}`,
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.regionId}:${row.targetDate}`;
    assert(!seen.has(key), `${context} duplicates ${key}`);
    seen.add(key);
  }
  return rows
    .slice()
    .sort(
      (a, b) =>
        byRegionOrder(lookups, a.regionId, b.regionId) ||
        a.leadDays - b.leadDays ||
        a.targetDate.localeCompare(b.targetDate),
    );
}

function buildWeatherForecastOutlookRows(lookups: Lookups, forecasts: WeatherForecast[]): WeatherForecastOutlookRow[] {
  const provider = weatherProviderConfig(lookups);
  const issueDate = requireWeather(lookups).forecast.decisionDayIssue;
  const horizonEnd = requireWeather(lookups).forecast.decisionDayHorizonEnd;
  const rows = forecastRowsForIssue(lookups, forecasts, issueDate, 'decision-day forecast outlook');
  assert(rows.at(-1)?.targetDate === horizonEnd, `decision-day forecast outlook must end on ${horizonEnd}`);
  return rows.map((row) => {
    const region = requireEntity(lookups.regionById, row.regionId, 'region', `decision-day forecast ${row.regionId}`);
    return {
      issue_date: row.issueDate,
      target_date: row.targetDate,
      lead_days: row.leadDays,
      region_id: region.regionId,
      region: region.name,
      uvIndex_p10: row.uvIndexP10,
      uvIndex_p50: row.uvIndexP50,
      uvIndex_p90: row.uvIndexP90,
      temperatureMeanAnomalyC_p50: row.temperatureMeanAnomalyCP50,
      uvIndexAnomaly_p50: row.uvIndexAnomalyP50,
      confidence: row.confidence,
      provenance: provider.provenance,
      source_label: provider.sourceLabel,
    };
  });
}

function forecastRegionSummaries(lookups: Lookups, forecasts: WeatherForecast[], issueDate: string): Entity[] {
  const rows = forecastRowsForIssue(lookups, forecasts, issueDate, `forecast briefing ${issueDate}`);
  return lookups.regions.map((region) => {
    const regionRows = rows.filter((row) => row.regionId === region.regionId);
    assert(regionRows.length > 0, `forecast briefing ${issueDate} missing ${region.regionId}`);
    const minUvIndexAnomalyP50 = Math.min(...regionRows.map((row) => row.uvIndexAnomalyP50));
    const minTemperatureMeanAnomalyCP50 = Math.min(...regionRows.map((row) => row.temperatureMeanAnomalyCP50));
    const maxUvIndexAnomalyP50 = Math.max(...regionRows.map((row) => row.uvIndexAnomalyP50));
    const maxTemperatureMeanAnomalyCP50 = Math.max(...regionRows.map((row) => row.temperatureMeanAnomalyCP50));
    return {
      regionId: region.regionId,
      regionName: region.name,
      signalAffectedFlag: Boolean(region.signalAffected),
      meanUvIndexP50: round(mean(regionRows.map((row) => row.uvIndexP50), `forecast uvIndex ${issueDate} ${region.regionId}`), 2),
      meanUvIndexAnomalyP50: round(mean(regionRows.map((row) => row.uvIndexAnomalyP50), `forecast uv anomaly ${issueDate} ${region.regionId}`), 2),
      meanTemperatureMeanAnomalyCP50: round(
        mean(regionRows.map((row) => row.temperatureMeanAnomalyCP50), `forecast temperature anomaly ${issueDate} ${region.regionId}`),
        2,
      ),
      minUvIndexAnomalyP50: round(minUvIndexAnomalyP50, 2),
      maxUvIndexAnomalyP50: round(maxUvIndexAnomalyP50, 2),
      minTemperatureMeanAnomalyCP50: round(minTemperatureMeanAnomalyCP50, 2),
      maxTemperatureMeanAnomalyCP50: round(maxTemperatureMeanAnomalyCP50, 2),
      meanConfidence: round(mean(regionRows.map((row) => row.confidence), `forecast confidence ${issueDate} ${region.regionId}`), 2),
      aboveNormalAllLeadDays: minUvIndexAnomalyP50 > 0 && minTemperatureMeanAnomalyCP50 > 0,
    };
  });
}

function buildForecastNarrative(lookups: Lookups, issueDate: string, horizonEnd: string, summaries: Entity[]): string {
  const weather = requireWeather(lookups);
  const provider = weatherProviderConfig(lookups);
  const outlook = weatherSeasonalOutlook(lookups);
  const horizonDays = Number(weather.forecast.horizonDays);
  const affectedSummaries = strings(lookups.scenario.externalSignal.affectedRegionIds, 'externalSignal.affectedRegionIds').map((regionId) => {
    const summary = summaries.find((item) => item.regionId === regionId);
    assert(summary, `forecast briefing ${issueDate} missing affected region ${regionId}`);
    return summary;
  });
  const controlSummaries = strings(lookups.scenario.externalSignal.unaffectedRegionIds, 'externalSignal.unaffectedRegionIds').map((regionId) => {
    const summary = summaries.find((item) => item.regionId === regionId);
    assert(summary, `forecast briefing ${issueDate} missing control region ${regionId}`);
    return summary;
  });
  const regionPhrase = affectedSummaries
    .map(
      (summary) =>
        `${summary.regionName} (p50 UV anomaly ${signed(summary.minUvIndexAnomalyP50)} to ${signed(
          summary.maxUvIndexAnomalyP50,
        )}; mean temperature anomaly ${signed(summary.meanTemperatureMeanAnomalyCP50)} C)`,
    )
    .join('; ');
  const controlPhrase = controlSummaries
    .map(
      (summary) =>
        `${summary.regionName} control p50 UV anomaly ${signed(summary.minUvIndexAnomalyP50)} to ${signed(summary.maxUvIndexAnomalyP50)}`,
    )
    .join('; ');

  if (issueDate === weather.forecast.decisionDayIssue) {
    assert(
      affectedSummaries.every((summary) => summary.aboveNormalAllLeadDays),
      `decision-day forecast ${issueDate} must show persistent above-normal UV and temperature in every affected region`,
    );
    const meanAffectedConfidence = round(mean(affectedSummaries.map((summary) => Number(summary.meanConfidence)), `decision confidence ${issueDate}`), 2);
    return `${provider.shortName} issue ${issueDate} forecasts above-normal UV and temperature to persist for the ${horizonDays}-day horizon through ${horizonEnd} in the ${affectedRegionPhrase(lookups)} affected by ENSO: ${regionPhrase}. The contrast is explicit: ${controlPhrase}, so the two control regions sit near zero rather than sharing the uplift pattern. Mean p50 confidence across affected-region summaries is ${meanAffectedConfidence}. The ENSO seasonal outlook for ${outlook.signalId} carries approximately ${formatPct(Number(outlook.persistenceProbability) * 100)} persistence probability through ${outlook.persistenceThrough}, covering the remaining campaign window to ${lookups.scenario.clock.campaignEnd}.`;
  }

  const confidenceLow = round(Math.min(...summaries.map((summary) => Number(summary.meanConfidence))), 2);
  const confidenceHigh = round(Math.max(...summaries.map((summary) => Number(summary.meanConfidence))), 2);
  return `${provider.shortName} weather briefing, issue ${issueDate}: over the ${horizonDays}-day horizon through ${horizonEnd}, the affected-region p50 signal remains above normal in ${regionPhrase}. Regional mean confidence ranges from ${confidenceLow} to ${confidenceHigh}.`;
}

function buildForecastBriefings(lookups: Lookups, forecasts: WeatherForecast[]): ForecastBriefingRecord[] {
  const weather = requireWeather(lookups);
  const provider = weatherProviderConfig(lookups);
  const issueDates = [...new Set(forecasts.map((forecast) => forecast.issueDate))]
    .filter(
      (issueDate) =>
        issueDate >= weather.forecast.issueStart &&
        issueDate <= weather.forecast.issueEnd &&
        (includePostDecisionFacts() || isObservable(lookups.scenario, issueDate)),
    )
    .sort();
  const issueDateSet = new Set(issueDates);
  const selected = new Set<string>();
  for (const issueDate of issueDates) {
    const day = parseDate(issueDate).getUTCDay();
    if (day === 1) selected.add(issueDate);
  }
  const requiredIssueDates = [weather.forecast.issueStart, weather.forecast.decisionDayIssue];
  if (includePostDecisionFacts()) requiredIssueDates.push(weather.forecast.issueEnd);
  for (const issueDate of requiredIssueDates) {
    assert(issueDateSet.has(issueDate), `WeatherForecastDaily.csv is missing required forecast issue ${issueDate}`);
    selected.add(issueDate);
  }

  return [...selected].sort().map((issueDate) => {
    const horizonDays = Number(weather.forecast.horizonDays);
    const horizonEndDate = forecastIssueHorizonEnd(lookups, issueDate);
    const regionSummaries = forecastRegionSummaries(lookups, forecasts, issueDate);
    return {
      briefingId: forecastBriefingId(issueDate),
      issueDate,
      horizonDays,
      forecastTargetDays: forecastTargetDaysForIssue(lookups, issueDate),
      forecastTargetStartDate: forecastTargetStart(issueDate),
      horizonEndDate,
      regionIds: lookups.regions.map((region) => region.regionId),
      regionSummaries,
      narrative: buildForecastNarrative(lookups, issueDate, horizonEndDate, regionSummaries),
      tags: ['external', 'weather', 'forecast-briefing', issueDate === weather.forecast.decisionDayIssue ? 'decision-day' : 'weekly'],
      provenance: provider.provenance,
      sourceLabel: provider.sourceLabel,
    };
  });
}

function buildWeatherDemandReconciliationRows(
  lookups: Lookups,
  anomalyRows: WeatherAnomalyRow[],
): WeatherDemandReconciliationRow[] {
  const provider = weatherProviderConfig(lookups);
  const demandResponse = weatherDemandResponse(lookups);
  const tolerancePct = Number(demandResponse.tolerancePct);
  const anomalyByRegion = new Map(anomalyRows.map((row) => [String(row.region_id), row]));
  return lookups.regions.map((region) => {
    const anomaly = anomalyByRegion.get(region.regionId);
    assert(anomaly, `weather demand reconciliation missing anomaly row for ${region.regionId}`);
    const modelledWeatherUpliftPct = Number(anomaly.modelled_uplift_pct);
    const actualSalesVariancePct = Number(region.variancePct);
    const differencePct = round(modelledWeatherUpliftPct - actualSalesVariancePct, 2);
    assert(
      Math.abs(differencePct) <= tolerancePct,
      `weather demand reconciliation ${region.regionId} difference ${differencePct} exceeds tolerance ${tolerancePct}`,
    );
    return {
      region_id: region.regionId,
      region: region.name,
      model_id: demandResponse.modelId,
      modelled_weather_uplift_pct: modelledWeatherUpliftPct,
      actual_sales_variance_pct: actualSalesVariancePct,
      difference_pct: differencePct,
      signal_affected_flag: Boolean(region.signalAffected),
      provenance: provider.provenance,
      source_label: provider.sourceLabel,
    };
  });
}

function buildWeatherContext(lookups: Lookups, inputs: WeatherInputs, advisories: AdvisoryRecord[]): WeatherContext {
  const provider = buildWeatherProvider(lookups);
  const events = buildWeatherEventDocuments(lookups, inputs.events, advisories);
  const anomalyRows = buildWeatherAnomalyRows(lookups, inputs.observations);
  const forecastOutlookRows = buildWeatherForecastOutlookRows(lookups, inputs.forecasts);
  const reconciliationRows = buildWeatherDemandReconciliationRows(lookups, anomalyRows);
  const briefings = buildForecastBriefings(lookups, inputs.forecasts);
  const decisionBriefing = briefings.find((briefing) => briefing.issueDate === requireWeather(lookups).forecast.decisionDayIssue);
  assert(decisionBriefing, `forecast briefings missing decision day ${requireWeather(lookups).forecast.decisionDayIssue}`);
  return {
    provider,
    events,
    briefings,
    anomalyRows,
    forecastOutlookRows,
    reconciliationRows,
    decisionBriefing,
  };
}

function roleFromPolicyOrFallback(policy: Entity, fallbackRole: string): string {
  return policy.rule?.requiredApproverRole ?? fallbackRole;
}

function actionApprovedByRole(action: Entity): string {
  const role = action.approvedByRole ?? action.approverRole;
  assert(typeof role === 'string' && role.length > 0, `action ${action.actionId} missing approved role`);
  return role;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function labelForEntity(lookups: Lookups, id: string): string {
  if (id === 'regions') return 'Signal-affected Caldova regions';
  if (id === 'campaigns') return 'Active regional campaigns';
  if (id === lookups.scenario.externalSignal.signalId) return lookups.scenario.externalSignal.name;
  if (id === lookups.scenario.decisionCase.caseId) return lookups.scenario.decisionCase.title;
  const region = lookups.regionById.get(id);
  if (region) return region.name;
  const product = lookups.productById.get(id);
  if (product) return product.name;
  const campaign = lookups.campaignById.get(id);
  if (campaign) return campaign.name;
  const assumption = lookups.assumptionById.get(id);
  if (assumption) return assumption.statement;
  const option = lookups.optionById.get(id);
  if (option) return option.name;
  const action = lookups.actionById.get(id);
  if (action) return action.type;
  if (id === forecastEvidenceId(lookups)) return `Forecast ${lookups.scenario.forecast.baselineVersion}`;
  return id;
}

function appliedPolicyEntities(lookups: Lookups, context: string): Entity[] {
  return lookups.scenario.decisionCase.appliedPolicies.map((applied: Entity) =>
    requirePolicy(lookups, applied.policyId, applied.version, context),
  );
}

function appliedPolicyMatching(lookups: Lookups, context: string, predicate: (policy: Entity) => boolean): Entity {
  const policy = appliedPolicyEntities(lookups, context).find(predicate);
  assert(policy, `${context} could not find a required applied policy`);
  return policy;
}

function maintenancePolicyFromScenario(lookups: Lookups, context: string): Entity {
  return appliedPolicyMatching(lookups, context, (policy) => Array.isArray(policy.rule?.deferralTable));
}

function commercialPolicyFromScenario(lookups: Lookups, context: string): Entity {
  return appliedPolicyMatching(lookups, context, (policy) => policy.rule?.maxIncrementalBudgetUsdWithoutBoardApproval !== undefined);
}

function invalidatedAssumptions(lookups: Lookups): Entity[] {
  return lookups.assumptions.filter((assumption) => assumption.invalidatedBySignalId === lookups.scenario.externalSignal.signalId);
}

function firstCorrection(lookups: Lookups, context: string): Entity {
  const correction = lookups.scenario.decisionCase.corrections[0];
  assert(correction, `${context} requires at least one decision-case correction`);
  return correction;
}

function demandOutcomeFromScenario(lookups: Lookups, context: string): Entity {
  const outcome = lookups.scenario.decisionCase.outcomes.find(
    (candidate: Entity) =>
      Number(candidate.plannedValue) === Number(lookups.scenario.opportunity.incrementalUnits) &&
      Number(candidate.metricValue) >= Number(candidate.plannedValue),
  );
  assert(outcome, `${context} requires an outcome for planned incremental units`);
  return outcome;
}

function revenueOutcomeFromScenario(lookups: Lookups, context: string): Entity {
  const outcome = lookups.scenario.decisionCase.outcomes.find(
    (candidate: Entity) => Number(candidate.plannedValue) === Number(lookups.scenario.opportunity.incrementalRevenueUsd),
  );
  assert(outcome, `${context} requires an outcome for planned incremental revenue`);
  return outcome;
}

function forecastVarianceMetricId(lookups: Lookups): string {
  const metrics = arrayOf(lookups.scenario.metrics, 'metrics');
  const metric = metrics.find(
    (candidate) =>
      typeof candidate.expression === 'string' &&
      candidate.expression.includes('actual_units') &&
      candidate.expression.includes('forecast_units'),
  );
  assert(metric, 'metrics must include a forecast variance metric');
  return metric.metricId;
}

function numberWord(value: number): string {
  const words = new Map<number, string>([
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [3, 'three'],
    [4, 'four'],
    [5, 'five'],
    [6, 'six'],
    [7, 'seven'],
    [8, 'eight'],
    [9, 'nine'],
    [10, 'ten'],
  ]);
  return words.get(value) ?? String(value);
}

function affectedRegionPhrase(lookups: Lookups): string {
  return `${numberWord(Number(lookups.scenario.opportunity.affectedRegionCount))} regions`;
}

function maintenanceWindowPhrase(lookups: Lookups): string {
  return `${numberWord(Number(lookups.scenario.maintenance.durationDays))}-day maintenance window`;
}

function deferralDaysPhrase(lookups: Lookups): string {
  return `${lookups.scenario.maintenance.deferralDays} days`;
}

function personaIdForAct(lookups: Lookups, act: number, context: string): string {
  const persona = arrayOf(lookups.scenario.personas, 'personas').find((candidate) => Number(candidate.act) === act);
  assert(persona, `${context} requires a persona for act ${act}`);
  requirePersona(lookups, persona.personaId, context);
  return persona.personaId;
}

function casePolicyChunkId(caseId: string, policy: Entity): string {
  return `${slug(caseId)}-policy-${slug(policy.policyId)}-v-${slug(policy.version)}`;
}

function policyChunkId(policy: Entity): string {
  return `policy-${slug(policy.policyId)}-v-${slug(policy.version)}`;
}

function policyDeferralChunkId(policy: Entity, rateFactor: number): string {
  return `${policyChunkId(policy)}-deferral-${slug(String(rateFactor))}`;
}

function caseOptionChunkId(caseId: string, optionId: string): string {
  return `${slug(caseId)}-option-${slug(optionId)}`;
}

function caseCorrectionChunkId(caseId: string, correctionId: string): string {
  return `${slug(caseId)}-correction-${slug(correctionId)}`;
}

function caseOutcomeChunkId(caseId: string, outcomeId: string): string {
  return `${slug(caseId)}-outcome-${slug(outcomeId)}`;
}

function forecastEvidenceId(lookups: Lookups): string {
  const hops = arrayOf(lookups.scenario.evidenceChain.hops, 'evidenceChain.hops');
  const forecastHop = hops.find((hop) => hop.relation === 'campaign_built_on_forecast_version');
  assert(forecastHop && typeof forecastHop.to === 'string', 'evidence chain must identify the forecast version entity');
  return forecastHop.to;
}

function writeRecords(relativePath: string, records: Entity[]): Promise<GenerationResult> {
  return writeJsonlRecords(relativePath, records);
}

async function writeJsonlRecords(relativePath: string, records: Entity[]): Promise<GenerationResult> {
  const writer = await openJsonl(relativePath);
  for (const record of records) await writer.writeRecord(record);
  const rows = await writer.close();
  return { file: relativePath, rows };
}

async function writeCsvRows(
  relativePath: string,
  columns: string[],
  rowsToWrite: Record<string, string | number | boolean | null | undefined>[],
): Promise<GenerationResult> {
  const writer = await openCsv(relativePath, columns);
  await writer.writeRows(rowsToWrite);
  const rows = await writer.close();
  return { file: relativePath, rows };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  assert(!inQuotes, 'unterminated quoted field while reading upstream CSV');
  values.push(current);
  return values;
}

async function readCsvRecords(relativePath: string): Promise<Record<string, string>[]> {
  const fullPath = join(DATA_ROOT, relativePath);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') {
      throw new Error(
        `lakehouse generator: required upstream weather file ${relativePath} is missing; run the weather/eventhouse generators before lakehouse`,
      );
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  assert(lines.length > 0, `${relativePath} must contain a header row`);
  const headers = parseCsvLine(lines[0]);
  assert(headers.length > 0, `${relativePath} has no CSV headers`);
  assert(new Set(headers).size === headers.length, `${relativePath} contains duplicate CSV headers`);

  const records: Record<string, string>[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '') continue;
    const values = parseCsvLine(line);
    assert(values.length === headers.length, `${relativePath} line ${lineIndex + 1} has ${values.length} values for ${headers.length} headers`);
    records.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  }
  return records;
}

function csvField(row: Record<string, string>, column: string, context: string): string {
  const value = row[column];
  assert(value !== undefined && value !== '', `${context} is missing required column ${column}`);
  return value;
}

function optionalCsvField(row: Record<string, string>, column: string): string | null {
  const value = row[column];
  return value === undefined || value === '' ? null : value;
}

function csvNumber(row: Record<string, string>, column: string, context: string): number {
  const value = Number(csvField(row, column, context));
  assert(Number.isFinite(value), `${context} column ${column} must be numeric`);
  return value;
}

function csvBoolean(row: Record<string, string>, column: string, context: string): boolean {
  const value = csvField(row, column, context).toLowerCase();
  assert(value === 'true' || value === 'false', `${context} column ${column} must be true or false`);
  return value === 'true';
}

function csvDate(row: Record<string, string>, column: string, context: string): string {
  const value = csvField(row, column, context).slice(0, 10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${context} column ${column} must start with YYYY-MM-DD`);
  assert(toDateString(parseDate(value)) === value, `${context} column ${column} has invalid date ${value}`);
  return value;
}

function requireWeather(lookups: Lookups): Entity {
  const weather = lookups.scenario.weather;
  assert(weather && typeof weather === 'object', 'scenario.weather is required');
  return weather;
}

function weatherProviderConfig(lookups: Lookups): Entity {
  const provider = requireWeather(lookups).provider;
  assert(provider && typeof provider === 'object', 'scenario.weather.provider is required');
  return provider;
}

function weatherDemandResponse(lookups: Lookups): Entity {
  const demandResponse = requireWeather(lookups).demandResponse;
  assert(demandResponse && typeof demandResponse === 'object', 'scenario.weather.demandResponse is required');
  return demandResponse;
}

function weatherSeasonalOutlook(lookups: Lookups): Entity {
  const outlook = requireWeather(lookups).seasonalOutlook;
  assert(outlook && typeof outlook === 'object', 'scenario.weather.seasonalOutlook is required');
  return outlook;
}

function weatherEventCatalogueByType(lookups: Lookups): EntityMap {
  return mapBy(arrayOf(requireWeather(lookups).eventCatalogue, 'weather.eventCatalogue'), 'eventType', 'weather.eventCatalogue');
}

function validateWeatherCsvSource(row: Record<string, string>, lookups: Lookups, context: string): void {
  const provider = weatherProviderConfig(lookups);
  const providerId = optionalCsvField(row, 'providerId');
  if (providerId) assert(providerId === provider.providerId, `${context} references unknown provider ${providerId}`);
  const provenance = optionalCsvField(row, 'provenance');
  if (provenance) assert(provenance === provider.provenance, `${context} provenance must be ${provider.provenance}`);
}

function regionSortIndexes(lookups: Lookups): Map<string, number> {
  return new Map(lookups.regions.map((region, index) => [region.regionId, index]));
}

function byRegionOrder(lookups: Lookups, leftRegionId: string, rightRegionId: string): number {
  const indexes = regionSortIndexes(lookups);
  return (indexes.get(leftRegionId) ?? 9999) - (indexes.get(rightRegionId) ?? 9999);
}

function mean(values: number[], context: string): number {
  assert(values.length > 0, `${context} requires at least one numeric value`);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function signed(value: number, decimals = 2): string {
  const rounded = round(value, decimals);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function forecastBriefingId(issueDate: string): string {
  return `WX-BRIEF-${issueDate.replaceAll('-', '')}`;
}

function forecastBriefingChunkId(issueDate: string): string {
  return `weather-forecast-briefing-${slug(issueDate)}`;
}

function weatherProviderChunkId(providerId: string): string {
  return `weather-provider-${slug(providerId)}`;
}

function weatherEventChunkId(eventId: string): string {
  return `weather-event-${slug(eventId)}`;
}

function weatherDemandModelChunkId(modelId: string): string {
  return `weather-demand-elasticity-${slug(modelId)}`;
}

function weatherSeasonalOutlookChunkId(signalId: string): string {
  return `weather-seasonal-outlook-${slug(signalId)}`;
}

function parseWeatherObservation(row: Record<string, string>, lookups: Lookups, context: string): WeatherObservation {
  validateWeatherCsvSource(row, lookups, context);
  const regionId = csvField(row, 'regionId', context);
  requireEntity(lookups.regionById, regionId, 'region', context);
  const uvAlertLevel = csvField(row, 'uvAlertLevel', context);
  const validAlertLevels = new Set(arrayOf(requireWeather(lookups).uvAlertLevels, 'weather.uvAlertLevels').map((level) => level.level));
  assert(validAlertLevels.has(uvAlertLevel), `${context} references unknown UV alert level ${uvAlertLevel}`);
  return {
    date: csvDate(row, 'timestamp', context),
    regionId,
    temperatureMeanC: csvNumber(row, 'temperatureMeanC', context),
    uvIndex: csvNumber(row, 'uvIndex', context),
    uvAlertLevel,
    temperatureMeanAnomalyC: csvNumber(row, 'temperatureMeanAnomalyC', context),
    uvIndexAnomaly: csvNumber(row, 'uvIndexAnomaly', context),
  };
}

function parseWeatherForecast(row: Record<string, string>, lookups: Lookups, context: string): WeatherForecast {
  validateWeatherCsvSource(row, lookups, context);
  const regionId = csvField(row, 'regionId', context);
  requireEntity(lookups.regionById, regionId, 'region', context);
  const uvIndexP10 = csvNumber(row, 'uvIndex_p10', context);
  const uvIndexP50 = csvNumber(row, 'uvIndex_p50', context);
  const uvIndexP90 = csvNumber(row, 'uvIndex_p90', context);
  assert(uvIndexP10 <= uvIndexP50 && uvIndexP50 <= uvIndexP90, `${context} must satisfy uvIndex_p10 <= uvIndex_p50 <= uvIndex_p90`);
  return {
    issueDate: csvDate(row, 'issueDate', context),
    targetDate: csvDate(row, 'targetDate', context),
    leadDays: csvNumber(row, 'leadDays', context),
    regionId,
    uvIndexP10,
    uvIndexP50,
    uvIndexP90,
    temperatureMeanAnomalyCP50: csvNumber(row, 'temperatureMeanAnomalyC_p50', context),
    uvIndexAnomalyP50: csvNumber(row, 'uvIndexAnomaly_p50', context),
    confidence: csvNumber(row, 'confidence', context),
  };
}

function parseWeatherEvent(row: Record<string, string>, lookups: Lookups, context: string): WeatherEvent {
  validateWeatherCsvSource(row, lookups, context);
  const eventId = csvField(row, 'eventId', context);
  const eventType = csvField(row, 'eventType', context);
  requireEntity(weatherEventCatalogueByType(lookups), eventType, 'weather event type', context);
  const regionId = csvField(row, 'regionId', context);
  requireEntity(lookups.regionById, regionId, 'region', context);
  const signalId = optionalCsvField(row, 'signalId');
  return {
    eventId,
    eventType,
    regionId,
    severity: csvField(row, 'severity', context),
    startDate: csvDate(row, 'startDate', context),
    endDate: csvDate(row, 'endDate', context),
    peakValue: csvNumber(row, 'peakValue', context),
    peakMetric: csvField(row, 'peakMetric', context),
    signalId,
    relevantToHeroProduct: csvBoolean(row, 'relevantToHeroProduct', context),
    headline: csvField(row, 'headline', context),
  };
}

async function loadWeatherInputs(lookups: Lookups): Promise<WeatherInputs> {
  const [observationRows, forecastRows, eventRows] = await Promise.all([
    readCsvRecords('eventhouse/WeatherObservationsDaily.csv'),
    readCsvRecords('eventhouse/WeatherForecastDaily.csv'),
    readCsvRecords('eventhouse/WeatherEvents.csv'),
  ]);
  const observations = observationRows
    .map((row, index) => parseWeatherObservation(row, lookups, `WeatherObservationsDaily.csv line ${index + 2}`))
    .filter((observation) => isVisibleObservedFact(lookups, observation.date));
  const forecasts = forecastRows
    .map((row, index) => parseWeatherForecast(row, lookups, `WeatherForecastDaily.csv line ${index + 2}`))
    .filter((forecast) => includePostDecisionFacts() || isObservable(lookups.scenario, forecast.issueDate));
  const events = eventRows
    .map((row, index) => parseWeatherEvent(row, lookups, `WeatherEvents.csv line ${index + 2}`))
    // Filter on startDate, not endDate. An advisory that began before today is
    // visible today even though it runs on past the boundary - the El Nino phase
    // event is exactly that, and filtering by endDate silently removed the very
    // signal Act 1 is about.
    .filter((event) => isVisibleObservedFact(lookups, event.startDate));
  assert(observations.length > 0, 'WeatherObservationsDaily.csv must contain weather rows');
  assert(forecasts.length > 0, 'WeatherForecastDaily.csv must contain forecast rows');
  assert(events.length > 0, 'WeatherEvents.csv must contain event rows');
  assert(new Set(events.map((event) => event.eventId)).size === events.length, 'WeatherEvents.csv contains duplicate eventId values');
  validateWeatherForecastCoverage(lookups, forecasts);
  return { observations, forecasts, events };
}

function validateWeatherForecastCoverage(lookups: Lookups, forecasts: WeatherForecast[]): void {
  const weather = requireWeather(lookups);
  const decisionIssue = weather.forecast.decisionDayIssue;
  const decisionRows = forecasts.filter((forecast) => forecast.issueDate === decisionIssue);
  assert(decisionRows.length > 0, `WeatherForecastDaily.csv is missing decision-day issue ${decisionIssue}`);
  const targetDates = decisionRows.map((forecast) => forecast.targetDate).sort();
  const leadDays = decisionRows.map((forecast) => forecast.leadDays).sort((a, b) => a - b);
  const actualMaxTargetDate = targetDates.at(-1);
  assert(
    actualMaxTargetDate === weather.forecast.decisionDayHorizonEnd,
    `WeatherForecastDaily.csv max targetDate ${actualMaxTargetDate} for issue ${decisionIssue} must match weather.forecast.decisionDayHorizonEnd ${weather.forecast.decisionDayHorizonEnd}`,
  );
  assert(leadDays[0] === 1, `WeatherForecastDaily.csv decision-day leadDays must start at 1`);
  assert(leadDays.at(-1) === Number(weather.forecast.horizonDays), `WeatherForecastDaily.csv decision-day leadDays must end at weather.forecast.horizonDays`);
}

function buildAdvisories(lookups: Lookups): AdvisoryRecord[] {
  const { scenario } = lookups;
  const external = scenario.externalSignal;
  const provider = weatherProviderConfig(lookups);
  const sourceLabel = String(external.sourceLabel ?? provider.sourceLabel);
  const affected = affectedRegions(lookups);
  const futureAffected = affected.slice(0, Math.max(1, Math.min(2, affected.length)));
  const commonTags = ['external', 'climate', 'advisory'];
  const main = {
    signalId: external.signalId,
    name: external.name,
    signalType: external.signalType,
    provenance: external.provenance,
    sourceLabel,
    observationPeriod: {
      start: external.observationPeriodStart,
      end: external.observationPeriodEnd,
    },
    persistenceThrough: external.persistenceThrough,
    persistenceProbability: external.persistenceProbability,
    confidence: external.confidence,
    seaSurfaceAnomalyC: external.seaSurfaceAnomalyC,
    affectedRegionIds: external.affectedRegionIds,
    affectedRegionNames: affected.map((r) => r.name),
    unaffectedRegionIds: external.unaffectedRegionIds,
    narrative: `${sourceLabel} reports a persistent external pattern with ${formatPct(
      external.persistenceProbability * 100,
    )} persistence probability through ${external.persistenceThrough}. Caldova maps the advisory to ${affected.length} affected regions for ${lookups.heroProduct.name}.`,
    tags: [...commonTags, 'el-nino', 'hydration-sunscreen', 'act-1'],
  };

  const futureWindow = advisoryWindowFromAsOf(lookups, 268, 328, 451);
  const future = {
    signalId: scenario.retrieval.futureSignalId,
    name: `${futureWindow.start.slice(0, 4)} coastal climate advisory for decision-memory rehearsal`,
    signalType: external.signalType,
    provenance: external.provenance,
    sourceLabel,
    observationPeriod: {
      start: futureWindow.start,
      end: futureWindow.end,
    },
    persistenceThrough: futureWindow.persistenceThrough,
    persistenceProbability: 0.72,
    confidence: 0.7,
    seaSurfaceAnomalyC: 1.1,
    affectedRegionIds: futureAffected.map((r) => r.regionId),
    affectedRegionNames: futureAffected.map((r) => r.name),
    unaffectedRegionIds: unaffectedRegions(lookups).map((r) => r.regionId),
    narrative: `${lookups.heroProduct.name} demand is again above forecast in coastal regions while a climate advisory is active. Similarity search should retrieve ${scenario.decisionCase.caseId} and compare the ${scenario.recommendedOptionId} operating response before a new commitment is approved.`,
    tags: [...commonTags, 'future-probe', 'decision-memory', 'coastal-regions'],
  };

  const unrelated = [
    {
      prefix: 'SIG-POLLEN',
      name: 'High-pollen advisory',
      signalType: 'environmental',
      window: advisoryWindowFromAsOf(lookups, -67, -50, -33),
      persistenceProbability: 0.46,
      confidence: 0.61,
      seaSurfaceAnomalyC: null,
      affectedRegionIds: [lookups.regions[4]?.regionId ?? lookups.regions[0].regionId],
      narrative: 'Pollen conditions are elevated in a control region; this comparison signal helps separate allergy demand patterns from sunscreen demand.',
      tags: ['external', 'environmental', 'advisory', 'pollen', 'control-region'],
    },
    {
      prefix: 'SIG-RAIN',
      name: 'Late-summer rainfall advisory',
      signalType: 'climate',
      window: advisoryWindowFromAsOf(lookups, -310, -290, -265),
      persistenceProbability: 0.64,
      confidence: 0.66,
      seaSurfaceAnomalyC: -0.3,
      affectedRegionIds: [lookups.regions[5]?.regionId ?? lookups.regions[0].regionId],
      narrative: `Rainfall pressure is tracked for campaign planning, but this signal does not affect the ${lookups.heroProduct.name} variance case.`,
      tags: [...commonTags, 'rainfall', 'distractor'],
    },
    {
      prefix: 'SIG-PORT',
      name: 'Regional port congestion bulletin',
      signalType: 'logistics',
      window: advisoryWindowFromAsOf(lookups, -19, -12, -1),
      persistenceProbability: 0.52,
      confidence: 0.58,
      seaSurfaceAnomalyC: null,
      affectedRegionIds: [affected[0].regionId],
      narrative: 'Regional logistics pressure is monitored as a comparison signal, but it does not explain the demand uplift.',
      tags: [...commonTags, 'logistics', 'port'],
    },
    {
      prefix: 'SIG-UV',
      name: 'Short-lived UV-index advisory',
      signalType: 'climate',
      window: advisoryWindowFromAsOf(lookups, -756, -748, -743),
      persistenceProbability: 0.33,
      confidence: 0.54,
      seaSurfaceAnomalyC: 0.2,
      affectedRegionIds: [affected[1]?.regionId ?? affected[0].regionId],
      narrative: 'Short-lived UV pressure faded too quickly for a campaign commitment; persistence is the differentiating factor.',
      tags: [...commonTags, 'uv-index', 'short-lived'],
    },
  ].map((record) => ({
    signalId: signalIdFromDate(record.prefix, record.window.start),
    name: record.name,
    signalType: record.signalType,
    observationPeriod: { start: record.window.start, end: record.window.end },
    persistenceThrough: record.window.persistenceThrough,
    persistenceProbability: record.persistenceProbability,
    confidence: record.confidence,
    seaSurfaceAnomalyC: record.seaSurfaceAnomalyC,
    affectedRegionIds: record.affectedRegionIds,
    narrative: record.narrative,
    tags: record.tags,
    provenance: external.provenance,
    sourceLabel,
    affectedRegionNames: record.affectedRegionIds.map((id: string) =>
      requireEntity(lookups.regionById, id, 'region', `unrelated advisory ${record.prefix}`).name,
    ),
    unaffectedRegionIds: lookups.regions.filter((r) => !record.affectedRegionIds.includes(r.regionId)).map((r) => r.regionId),
  }));

  return [main, ...unrelated, future];
}

function buildEvidenceTrace(lookups: Lookups): Entity[] {
  const { scenario } = lookups;
  const baselineForecastEntityId = forecastEvidenceId(lookups);
  return arrayOf(scenario.evidenceChain.hops, 'evidenceChain.hops').map((hop) => {
    const toIds = Array.isArray(hop.to) ? hop.to : [hop.to];
    const base = {
      hop: hop.step,
      relation: hop.relation,
      fromEntityId: hop.from,
      fromLabel: labelForEntity(lookups, hop.from),
      toEntityIds: toIds,
      toLabels: toIds.map((id: string) => labelForEntity(lookups, id)),
      caseId: scenario.decisionCase.caseId,
      scopeKey: scenario.decisionCase.scopeKey,
    };
    if (hop.relation === 'signal_affects_region') {
      const regions = toIds.map((id: string) => requireEntity(lookups.regionById, id, 'region', `evidence hop ${hop.step}`));
      return {
        ...base,
        supportingValues: {
          observationPeriodStart: scenario.externalSignal.observationPeriodStart,
          observationPeriodEnd: scenario.externalSignal.observationPeriodEnd,
          persistenceThrough: scenario.externalSignal.persistenceThrough,
          persistenceProbability: scenario.externalSignal.persistenceProbability,
          confidence: scenario.externalSignal.confidence,
          seaSurfaceAnomalyC: scenario.externalSignal.seaSurfaceAnomalyC,
          affectedRegionVariancePct: Object.fromEntries(regions.map((r) => [r.regionId, r.variancePct])),
          sourceLabel: scenario.externalSignal.sourceLabel,
        },
      };
    }
    if (hop.relation === 'region_sells_product') {
      return {
        ...base,
        supportingValues: {
          productId: scenario.heroProductId,
          productName: lookups.heroProduct.name,
          signalAffectedRegionIds: scenario.externalSignal.affectedRegionIds,
          signalAffectedRegionCount: scenario.opportunity.affectedRegionCount,
          regionVariancePct: Object.fromEntries(affectedRegions(lookups).map((r) => [r.regionId, r.variancePct])),
          incrementalUnitsByRegion: Object.fromEntries(affectedRegions(lookups).map((r) => [r.regionId, r.incrementalUnits])),
        },
      };
    }
    if (hop.relation === 'product_promoted_by_active_campaign') {
      return {
        ...base,
        supportingValues: {
          launchPlanId: scenario.launchPlan.launchPlanId,
          launchPlanStatus: scenario.launchPlan.status,
          campaignIds: toIds,
          incrementalBudgetUsd: Object.fromEntries(
            toIds.map((id: string) => {
              const campaign = requireEntity(lookups.campaignById, id, 'campaign', `evidence hop ${hop.step}`);
              return [id, campaign.incrementalBudgetUsd];
            }),
          ),
          affectedRegionIds: toIds.map((id: string) => requireEntity(lookups.campaignById, id, 'campaign', `evidence hop ${hop.step}`).regionId),
        },
      };
    }
    if (hop.relation === 'campaign_built_on_forecast_version') {
      return {
        ...base,
        supportingValues: {
          forecastEntityId: baselineForecastEntityId,
          baselineVersion: scenario.forecast.baselineVersion,
          baselineForecastDate: scenario.forecast.baselineForecastDate,
          revisedVersion: scenario.forecast.revisedVersion,
          revisedForecastDate: scenario.forecast.revisedForecastDate,
          horizonDays: scenario.forecast.horizonDays,
          campaignCalendarDays: scenario.clock.campaignCalendarDays,
          campaignOperatingDays: scenario.clock.campaignOperatingDays,
        },
      };
    }
    return {
      ...base,
      supportingValues: {
        forecastEntityId: hop.from,
        invalidatedAssumptions: toIds.map((id: string) => {
          const assumption = requireAssumption(lookups, id, `evidence hop ${hop.step}`);
          return {
            assumptionId: id,
            statement: assumption.statement,
            heldAfterSignal: assumption.heldAfterSignal,
            invalidatedBySignalId: assumption.invalidatedBySignalId,
          };
        }),
      },
    };
  });
}

function mainDecisionCase(lookups: Lookups): DecisionCaseRecord {
  const { scenario } = lookups;
  const decisionCase = scenario.decisionCase;
  const signal = scenario.externalSignal;
  const resolvedAt = isVisibleObservedFact(lookups, decisionCase.resolvedAt) ? decisionCase.resolvedAt : null;
  const stateHistory = decisionCase.states.filter((state: Entity) => isVisibleObservedFact(lookups, state.at));
  const corrections = decisionCase.corrections.filter((correction: Entity) => isVisibleObservedFact(lookups, correction.approvedAt));
  const governedActions = lookups.actions.filter((action) => isVisibleObservedFact(lookups, action.executedAt));
  const outcomes = decisionCase.outcomes.filter((outcome: Entity) => isVisibleObservedFact(lookups, outcome.recordedAt));
  const policies = decisionCase.appliedPolicies.map((applied: Entity) => {
    const policy = requirePolicy(lookups, applied.policyId, applied.version, `decision case ${decisionCase.caseId}`);
    return {
      policyId: policy.policyId,
      version: policy.version,
      name: policy.name,
      status: policy.status,
      effectiveFrom: policy.effectiveFrom,
      rule: policy.rule,
    };
  });
  return {
    caseId: decisionCase.caseId,
    title: decisionCase.title,
    scopeKey: decisionCase.scopeKey,
    status: resolvedAt ? decisionCase.status : 'open',
    openedAt: decisionCase.openedAt,
    resolvedAt,
    concernsProduct: {
      productId: lookups.heroProduct.productId,
      name: lookups.heroProduct.name,
      category: lookups.heroProduct.category,
    },
    stateHistory,
    triggers: decisionCase.triggers.map((trigger: Entity) => ({
      ...trigger,
      label: trigger.id === signal.signalId ? signal.name : trigger.id,
    })),
    externalSignalEvidence: {
      signalId: signal.signalId,
      name: signal.name,
      provenance: signal.provenance,
      sourceLabel: signal.sourceLabel,
      observationPeriodStart: signal.observationPeriodStart,
      observationPeriodEnd: signal.observationPeriodEnd,
      persistenceThrough: signal.persistenceThrough,
      persistenceProbability: signal.persistenceProbability,
      confidence: signal.confidence,
      seaSurfaceAnomalyC: signal.seaSurfaceAnomalyC,
      affectedRegionIds: signal.affectedRegionIds,
      affectedRegionNames: affectedRegions(lookups).map((r) => r.name),
      narrative: `${signal.name} explains why ${lookups.heroProduct.name} is above forecast only after it is grounded to Caldova regions, campaigns and forecast assumptions.`,
    },
    forecastVarianceEvidence: {
      metricId: forecastVarianceMetricId(lookups),
      baselineVersion: scenario.forecast.baselineVersion,
      revisedVersion: scenario.forecast.revisedVersion,
      varianceWindowStart: scenario.clock.varianceWindowStart,
      varianceWindowEnd: scenario.clock.varianceWindowEnd,
      affectedRegions: affectedRegions(lookups).map((region) => ({
        regionId: region.regionId,
        name: region.name,
        forecastUnits: region.baselineForecastUnits30d,
        actualUnits: actualUnitsForVariance(region),
        variancePct: region.variancePct,
        incrementalUnits: region.incrementalUnits,
      })),
      unaffectedControlRegions: unaffectedRegions(lookups).map((region) => ({
        regionId: region.regionId,
        name: region.name,
        forecastUnits: region.baselineForecastUnits30d,
        actualUnits: actualUnitsForVariance(region),
        variancePct: region.variancePct,
      })),
      invalidatedAssumptionIds: invalidatedAssumptions(lookups).map((a) => a.assumptionId),
    },
    commercialScenariosConsidered: lookups.scenarios.map((scenarioOption) => ({
      ...scenarioOption,
      approved: includePostDecisionFacts() && scenarioOption.scenarioId === scenario.approvedScenarioId,
    })),
    productionOptionsConsidered: lookups.options.map((option) => ({
      ...option,
      recommended: option.optionId === scenario.recommendedOptionId,
    })),
    appliedPolicies: policies,
    correction: corrections.map((correction: Entity) => ({
      correctionId: correction.correctionId,
      statement: correction.statement,
      scopeKey: correction.scopeKey,
      proposedByRole: correction.proposedByRole,
      proposedAt: correction.proposedAt,
      approvedByRole: correction.approvedByRole,
      approvedAt: correction.approvedAt,
      status: correction.status,
    })),
    governedActions: governedActions.map((action) => ({
      actionId: action.actionId,
      type: action.type,
      api: action.api,
      requestedAt: action.requestedAt,
      approvedAt: action.approvedAt,
      executedAt: action.executedAt,
      approverRole: action.approvedByRole,
      receiptId: action.receiptId,
      status: action.status,
      result: action.result,
      details: action.details,
    })),
    outcomes,
    memorySummary: {
      status: resolvedAt ? decisionCase.status : 'open',
      ...(includePostDecisionFacts() ? { approvedScenarioId: scenario.approvedScenarioId } : {}),
      recommendedOptionId: scenario.recommendedOptionId,
      ...(includePostDecisionFacts() ? { expectedReuse: scenario.retrieval.expectedReuse } : {}),
      futureSignalId: scenario.retrieval.futureSignalId,
    },
  };
}

function buildHistoricalCases(lookups: Lookups): DecisionCaseRecord[] {
  const fallbackRole = lookups.scenario.approverRoles[0];
  const products = lookups.products.filter((p) => p.productId !== lookups.heroProduct.productId);
  assert(products.length >= 5, 'historical cases require at least five non-hero products');
  const regions = lookups.regions;
  const lines = lookups.lines;
  const policies = lookups.policies;
  assert(regions.length >= 6 && lines.length >= 6 && policies.length >= 4, 'historical cases require scenario regions, lines and policies');

  const templates = [
    {
      code: 'PKG',
      openedOffsetDays: -854,
      approvedOffsetDays: -850,
      resolvedOffsetDays: -846,
      type: 'packaging_changeover',
      product: products[0],
      region: regions[0],
      line: lines[2],
      policy: policies[2],
      issue: 'changeover kit availability for a kids sun-care pack size',
      decision: 'approved a staged packaging changeover after materials arrived',
      result: 'service level protected with no campaign budget change',
      factor: 0.18,
      tags: ['packaging', 'changeover', 'sun-care'],
    },
    {
      code: 'SUP',
      openedOffsetDays: -825,
      approvedOffsetDays: -821,
      resolvedOffsetDays: -817,
      type: 'supplier_delay',
      product: products[1],
      region: regions[1],
      line: lines[1],
      policy: policies[0],
      issue: 'supplier delay on carton stock for after-sun products',
      decision: 'reallocated destination supply and held campaign spend flat',
      result: 'backlog cleared inside the coverage guardrail',
      factor: 0.12,
      tags: ['supplier', 'cartons', 'coverage'],
    },
    {
      code: 'LBL',
      openedOffsetDays: -428,
      approvedOffsetDays: -424,
      resolvedOffsetDays: -420,
      type: 'label_revision',
      product: products[3],
      region: regions[2],
      line: lines[3],
      policy: policies[1],
      issue: 'label text revision required before a supplement batch could ship',
      decision: 'paused affected batches and retained existing order priority',
      result: 'no unapproved label stock shipped',
      factor: 0.09,
      tags: ['label', 'quality', 'supplements'],
    },
    {
      code: 'CAP',
      openedOffsetDays: -397,
      approvedOffsetDays: -393,
      resolvedOffsetDays: -389,
      type: 'capacity_rebalance',
      product: products[2],
      region: regions[3],
      line: lines[5],
      policy: policies[2],
      issue: 'daily moisturiser orders exceeded one regional fulfilment lane',
      decision: 'shifted low-risk volume to an alternate line within utilisation policy',
      result: 'regional orders shipped without rate escalation',
      factor: 0.15,
      tags: ['capacity', 'skin-health', 'rebalance'],
    },
    {
      code: 'QAL',
      openedOffsetDays: -369,
      approvedOffsetDays: -365,
      resolvedOffsetDays: -361,
      type: 'quality_hold_release',
      product: products[1],
      region: regions[4],
      line: lines[0],
      policy: policies[0],
      issue: 'quality hold delayed after-sun inventory before a regional promotion',
      decision: 'released only lots with confirmed coverage and kept the rest blocked',
      result: 'promotion demand was partially served with no policy exception',
      factor: 0.11,
      tags: ['quality', 'hold', 'promotion'],
    },
    {
      code: 'MNT',
      openedOffsetDays: -488,
      approvedOffsetDays: -484,
      resolvedOffsetDays: -480,
      type: 'maintenance_schedule',
      product: products[0],
      region: regions[5],
      line: lines[4],
      policy: policies[1],
      issue: 'maintenance window overlapped a short regional reorder cycle',
      decision: 'did not defer maintenance because the rate table allowed no safe extension',
      result: 'orders were reprioritized instead of moving the maintenance date',
      factor: 0.1,
      tags: ['maintenance', 'policy', 'no-deferral'],
    },
    {
      code: 'BUD',
      openedOffsetDays: -94,
      approvedOffsetDays: -90,
      resolvedOffsetDays: -86,
      type: 'budget_guardrail',
      product: products[4],
      region: regions[4],
      line: lines[3],
      policy: policies[3],
      issue: 'supplement campaign spend exceeded a commercial approval threshold',
      decision: 'kept the campaign inside delegated budget authority',
      result: 'board approval was not required',
      factor: 0.08,
      tags: ['budget', 'commercial', 'guardrail'],
    },
    {
      code: 'DSP',
      openedOffsetDays: -62,
      approvedOffsetDays: -58,
      resolvedOffsetDays: -54,
      type: 'distribution_shift',
      product: products[2],
      region: regions[2],
      line: lines[5],
      policy: policies[0],
      issue: 'distribution mix changed for daily moisturiser in a delta market',
      decision: 'rebalanced allocation without changing approved forecast assumptions',
      result: 'coverage stayed above the minimum supply guardrail',
      factor: 0.13,
      tags: ['distribution', 'allocation', 'coverage'],
    },
  ];

  return templates.map((template, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    const openedAt = timestampFromAsOf(lookups, template.openedOffsetDays, '09:00:00Z');
    const resolvedAt = timestampFromAsOf(lookups, template.resolvedOffsetDays, '15:30:00Z');
    const approvedAt = timestampFromAsOf(lookups, template.approvedOffsetDays, '13:15:00Z');
    const caseYear = openedAt.slice(0, 4);
    const suffix = `${template.code}-${caseYear}-${sequence}`;
    assert(isObservable(lookups.scenario, resolvedAt), `historical case ${suffix} must resolve on or before ${asOfDate(lookups.scenario)}`);
    requireEntity(lookups.productById, template.product.productId, 'product', `historical case ${suffix}`);
    requireEntity(lookups.regionById, template.region.regionId, 'region', `historical case ${suffix}`);
    requireEntity(lookups.lineById, template.line.lineId, 'production line', `historical case ${suffix}`);
    requirePolicy(lookups, template.policy.policyId, template.policy.version, `historical case ${suffix}`);
    const roleId = roleFromPolicyOrFallback(template.policy, fallbackRole);
    requireRole(lookups, roleId, `historical case ${suffix}`);
    const plannedUnits = Math.round(Number(template.region.baselineForecastUnits30d) * template.factor);
    const deliveredUnits = plannedUnits + (index % 3 === 0 ? 0 : Math.round(plannedUnits * 0.04));
    const requestedAt = timelineAt(approvedAt, -35);
    const executedAt = timelineAt(approvedAt, 1);
    const actionId = `ACT-HIST-${sequence}`;
    const receiptId = `RCPT-HIST-${approvedAt.slice(0, 4)}-${sequence}`;
    return {
      caseId: `CASE-${suffix}`,
      title: `${template.type.replaceAll('_', ' ')} for ${template.product.name} in ${template.region.name}`,
      scopeKey: `historical/${caseYear}/${template.product.productId}/${template.region.regionId}`,
      status: 'resolved',
      openedAt,
      resolvedAt,
      caseType: template.type,
      productId: template.product.productId,
      regionId: template.region.regionId,
      lineId: template.line.lineId,
      stateHistory: [
        { state: 'opened', at: openedAt },
        { state: 'evidence_gathered', at: timestampFromAsOf(lookups, template.openedOffsetDays + 1, '11:30:00Z') },
        { state: 'approved', at: approvedAt },
        { state: 'resolved', at: resolvedAt },
      ],
      triggers: [{ type: template.type, id: `TRG-${suffix}` }],
      issue: template.issue,
      decision: template.decision,
      appliedPolicies: [
        {
          policyId: template.policy.policyId,
          version: template.policy.version,
          name: template.policy.name,
        },
      ],
      governedActions: [
        {
          actionId,
          type: template.type,
          api: 'decision-history-api',
          requestedAt,
          approvedAt,
          executedAt,
          approverRole: roleId,
          receiptId,
          result: 'success',
          details: {
            productId: template.product.productId,
            regionId: template.region.regionId,
            lineId: template.line.lineId,
            policyId: template.policy.policyId,
            policyVersion: template.policy.version,
            plannedUnits,
            deliveredUnits,
            issue: template.issue,
            decision: template.decision,
          },
        },
      ],
      outcomes: [
        {
          outcomeId: `OUT-HIST-${String(index + 1).padStart(3, '0')}`,
          metricName: 'deliveredUnits',
          metricValue: deliveredUnits,
          plannedValue: plannedUnits,
          resultCode: template.result,
        },
      ],
      tags: template.tags,
    };
  });
}

function timelineAt(baseIso: string, offsetMinutes: number): string {
  return toIsoSeconds(addMinutes(parseDate(baseIso), offsetMinutes));
}

function buildTimeline(lookups: Lookups): TimelineRecord[] {
  const { scenario } = lookups;
  const decisionCase = scenario.decisionCase;
  const correction = firstCorrection(lookups, 'decision-case timeline');
  const demandPlannerRole = correction.proposedByRole;
  const knowledgeStewardRole = correction.approvedByRole;
  const events: TimelineRecord[] = [];

  for (const state of decisionCase.states) {
    if (!isVisibleObservedFact(lookups, state.at)) continue;
    events.push({
      eventId: `${decisionCase.caseId}-STATE-${state.state}`,
      caseId: decisionCase.caseId,
      timestamp: state.at,
      lifecycleEvent: 'state_changed',
      actorRole: knowledgeStewardRole,
      entityType: 'decision-case',
      entityId: decisionCase.caseId,
      description: `Decision case state changed to ${state.state}.`,
    });
  }

  events.push(
    {
      eventId: `${decisionCase.caseId}-EVIDENCE-SIGNAL`,
      caseId: decisionCase.caseId,
      timestamp: timelineAt(decisionCase.openedAt, 33),
      lifecycleEvent: 'evidence_added',
      actorRole: demandPlannerRole,
      entityType: 'advisory',
      entityId: scenario.externalSignal.signalId,
      description: `${scenario.externalSignal.name} attached as external evidence for ${lookups.heroProduct.name}.`,
    },
    {
      eventId: `${decisionCase.caseId}-EVIDENCE-VARIANCE`,
      caseId: decisionCase.caseId,
      timestamp: timelineAt(decisionCase.openedAt, 68),
      lifecycleEvent: 'evidence_added',
      actorRole: demandPlannerRole,
      entityType: 'forecast-variance',
      entityId: decisionCase.triggers.find((trigger: Entity) => trigger.type === 'forecastVariance')?.id ?? decisionCase.caseId,
      description: `Forecast variance evidence added for ${scenario.opportunity.affectedRegionCount} signal-affected regions.`,
    },
    {
      eventId: `${decisionCase.caseId}-EVIDENCE-ASSUMPTIONS`,
      caseId: decisionCase.caseId,
      timestamp: timelineAt(decisionCase.openedAt, 83),
      lifecycleEvent: 'evidence_added',
      actorRole: demandPlannerRole,
      entityType: 'assumption',
      entityId: scenario.externalSignal.signalId,
      description: `Forecast assumptions invalidated by ${scenario.externalSignal.signalId}: ${lookups.assumptions
        .filter((a) => a.invalidatedBySignalId === scenario.externalSignal.signalId)
        .map((a) => a.assumptionId)
        .join(', ')}.`,
    },
  );

  const optionsProposedAt = decisionCase.states.find((s: Entity) => s.state === 'options_proposed')?.at ?? decisionCase.openedAt;
  if (isVisibleObservedFact(lookups, optionsProposedAt)) {
    for (const [index, commercialScenario] of lookups.scenarios.entries()) {
      events.push({
        eventId: `${decisionCase.caseId}-SCENARIO-${commercialScenario.scenarioId}`,
        caseId: decisionCase.caseId,
        timestamp: timelineAt(optionsProposedAt, index + 1),
        lifecycleEvent: 'option_proposed',
        actorRole: demandPlannerRole,
        entityType: 'commercial-scenario',
        entityId: commercialScenario.scenarioId,
        description: `${commercialScenario.name} proposed; approved=${
          includePostDecisionFacts() && commercialScenario.scenarioId === scenario.approvedScenarioId
        }.`,
      });
    }
  }

  if (isVisibleObservedFact(lookups, scenario.commitment.approvedAt)) {
    events.push({
      eventId: `${decisionCase.caseId}-APPROVAL-COMMERCIAL`,
      caseId: decisionCase.caseId,
      timestamp: scenario.commitment.approvedAt,
      lifecycleEvent: 'approval_recorded',
      actorRole: scenario.commitment.approvedByRole,
      entityType: 'commitment',
      entityId: scenario.commitment.commitmentId,
      description: `Commercial commitment approved for ${scenario.commitment.committedUnits} units and ${formatUsd(
        scenario.commitment.committedRevenueUsd,
      )}.`,
    });
  }

  for (const correction of decisionCase.corrections) {
    if (!isVisibleObservedFact(lookups, correction.approvedAt)) continue;
    events.push({
      eventId: `${decisionCase.caseId}-CORRECTION-${correction.correctionId}`,
      caseId: decisionCase.caseId,
      timestamp: correction.approvedAt,
      lifecycleEvent: 'correction_approved',
      actorRole: correction.approvedByRole,
      entityType: 'correction',
      entityId: correction.correctionId,
      description: correction.statement,
    });
  }

  if (isVisibleObservedFact(lookups, scenario.clock.productionApprovedAt)) {
    for (const [index, option] of lookups.options.entries()) {
      events.push({
        eventId: `${decisionCase.caseId}-PROD-OPTION-${option.optionId}`,
        caseId: decisionCase.caseId,
        timestamp: timelineAt(scenario.clock.productionApprovedAt, -30 + index),
        lifecycleEvent: 'option_proposed',
        actorRole: option.requiredApproverRole,
        entityType: 'production-option',
        entityId: option.optionId,
        description: `${option.name} evaluated; recommended=${option.optionId === scenario.recommendedOptionId}.`,
      });
    }
  }

  for (const action of lookups.actions) {
    if (!isVisibleObservedFact(lookups, action.executedAt)) continue;
    events.push({
      eventId: `${decisionCase.caseId}-ACTION-${action.actionId}`,
      caseId: decisionCase.caseId,
      timestamp: action.executedAt,
      lifecycleEvent: 'action_executed',
      actorRole: action.approvedByRole,
      entityType: 'governed-action',
      entityId: action.actionId,
      receiptId: action.receiptId,
      description: `${action.type} executed through ${action.api}; receipt ${action.receiptId}.`,
    });
  }

  for (const outcome of decisionCase.outcomes) {
    if (!isVisibleObservedFact(lookups, outcome.recordedAt)) continue;
    events.push({
      eventId: `${decisionCase.caseId}-OUTCOME-${outcome.outcomeId}`,
      caseId: decisionCase.caseId,
      timestamp: outcome.recordedAt,
      lifecycleEvent: 'outcome_recorded',
      actorRole: knowledgeStewardRole,
      entityType: 'outcome',
      entityId: outcome.outcomeId,
      description: `${outcome.metricName} recorded as ${outcome.metricValue} against planned ${outcome.plannedValue}.`,
    });
  }

  return events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.eventId).localeCompare(String(b.eventId)));
}

function buildForecastVarianceRows(lookups: Lookups): ForecastVarianceRow[] {
  return lookups.regions.map((region) => ({
    region_id: region.regionId,
    region: region.name,
    product_id: lookups.heroProduct.productId,
    product: lookups.heroProduct.name,
    forecast_units: region.baselineForecastUnits30d,
    actual_units: actualUnitsForVariance(region),
    variance_pct: region.variancePct,
    signal_affected_flag: Boolean(region.signalAffected),
  }));
}

function varianceWindowAllocations(lookups: Lookups): Map<string, { dates: string[]; forecast: number[]; actual: number[] }> {
  const out = new Map<string, { dates: string[]; forecast: number[]; actual: number[] }>();
  const dates = eachDate(lookups.scenario.clock.varianceWindowStart, lookups.scenario.clock.varianceWindowEnd);
  const dateStrings = dates.map(toDateString);
  for (const [regionIndex, region] of lookups.regions.entries()) {
    const weights = dates.map((date, dayIndex) => {
      const day = date.getUTCDay();
      const weekdayBoost = day >= 1 && day <= 5 ? 1.05 : 0.88;
      const shape = 1 + 0.05 * Math.sin((dayIndex + 1 + regionIndex) / 5);
      return weekdayBoost * shape;
    });
    out.set(region.regionId, {
      dates: dateStrings,
      forecast: allocateIntegers(Number(region.baselineForecastUnits30d), weights),
      actual: allocateIntegers(actualUnitsForVariance(region), weights.map((w, index) => w * (1 + index / (dates.length * 20)))),
    });
  }
  return out;
}

function buildHeroTrendRows(lookups: Lookups): HeroTrendRow[] {
  const rng = createRng(`${lookups.scenario.generatorSeed}:lakehouse:hero-demand-trend`);
  const varianceAllocations = varianceWindowAllocations(lookups);
  const rows: HeroTrendRow[] = [];
  const dates = eachDate(lookups.scenario.clock.salesHistoryStart, lookups.scenario.clock.varianceWindowEnd);
  const varianceStart = parseDate(lookups.scenario.clock.varianceWindowStart).getTime();
  const varianceEnd = parseDate(lookups.scenario.clock.varianceWindowEnd).getTime();

  for (const [regionIndex, region] of lookups.regions.entries()) {
    const allocation = varianceAllocations.get(region.regionId);
    assert(allocation, `missing variance allocation for ${region.regionId}`);
    for (const [dateIndex, date] of dates.entries()) {
      const dateString = toDateString(date);
      const inVarianceWindow = date.getTime() >= varianceStart && date.getTime() <= varianceEnd;
      let forecastUnits: number;
      let actualUnits: number;
      if (inVarianceWindow) {
        const allocationIndex = allocation.dates.indexOf(dateString);
        forecastUnits = allocation.forecast[allocationIndex];
        actualUnits = allocation.actual[allocationIndex];
      } else {
        const seasonal = 0.82 + 0.18 * (dateIndex / Math.max(1, dates.length - 1));
        const dayBoost = date.getUTCDay() === 0 ? 0.74 : 1.0;
        forecastUnits = Math.max(0, Math.round((Number(region.baselineForecastUnits30d) / lookups.scenario.forecast.horizonDays) * seasonal * dayBoost));
        const noise = rng.normal(0, region.signalAffected ? 0.025 : 0.018);
        const earlySignal = region.signalAffected && dateString >= lookups.scenario.externalSignal.observationPeriodStart ? 0.03 + regionIndex * 0.003 : 0;
        actualUnits = Math.max(0, Math.round(forecastUnits * (1 + noise + earlySignal)));
      }
      rows.push({
        date: dateString,
        region_id: region.regionId,
        region: region.name,
        product_id: lookups.heroProduct.productId,
        product: lookups.heroProduct.name,
        forecast_units: forecastUnits,
        actual_units: actualUnits,
        signal_affected_flag: Boolean(region.signalAffected),
      });
    }
  }
  return rows;
}

function buildCampaignPerformanceRows(lookups: Lookups): CampaignPerformanceRow[] {
  return lookups.campaigns.map((campaign) => {
    const region = requireEntity(lookups.regionById, campaign.regionId, 'region', `campaign ${campaign.campaignId}`);
    const spendUsd = round(Number(campaign.baseBudgetUsd) + Number(campaign.incrementalBudgetUsd), 2);
    const attributedUnits = Math.round(
      Number(region.baselineForecastUnits30d) * (lookups.scenario.clock.campaignOperatingDays / lookups.scenario.forecast.horizonDays) +
        Number(region.incrementalUnits),
    );
    const revenueUsd = round(attributedUnits * Number(lookups.heroProduct.unitPriceUsd), 2);
    const variableCostUsd = round(revenueUsd * 0.42, 2);
    const contributionMarginPct = round(((revenueUsd - variableCostUsd - spendUsd) / revenueUsd) * 100, 2);
    return {
      campaign_id: campaign.campaignId,
      campaign: campaign.name,
      region_id: region.regionId,
      region: region.name,
      product_id: lookups.heroProduct.productId,
      product: lookups.heroProduct.name,
      channel: campaign.channel,
      spend_usd: spendUsd,
      attributed_units: attributedUnits,
      revenue_usd: revenueUsd,
      contribution_margin_pct: contributionMarginPct,
      signal_affected_flag: Boolean(region.signalAffected),
    };
  });
}

function buildForecastAssumptionRows(lookups: Lookups): ForecastAssumptionRow[] {
  return lookups.assumptions.map((assumption) => ({
    assumption_id: assumption.assumptionId,
    forecast_version: lookups.scenario.forecast.baselineVersion,
    statement: assumption.statement,
    status: assumption.heldAfterSignal ? 'held' : 'invalidated',
    held_after_signal: Boolean(assumption.heldAfterSignal),
    invalidated_by_signal_id: assumption.invalidatedBySignalId ?? '',
  }));
}

function addChunk(chunks: RetrievalChunk[], chunk: RetrievalChunk): void {
  assert(!chunks.some((existing) => existing.chunkId === chunk.chunkId), `duplicate retrieval chunk id ${chunk.chunkId}`);
  chunks.push(chunk);
}

function buildRetrievalCorpus(
  lookups: Lookups,
  advisories: AdvisoryRecord[],
  decisionCases: DecisionCaseRecord[],
  trendRows: HeroTrendRow[],
  weatherContext: WeatherContext,
): RetrievalChunk[] {
  const { scenario } = lookups;
  const chunks: RetrievalChunk[] = [];
  const mainCaseId = scenario.decisionCase.caseId;
  const mainSlug = slug(mainCaseId);
  const signalName = scenario.externalSignal.name;
  const recommendedOption = requireOption(lookups, scenario.recommendedOptionId, 'retrieval corpus');
  const priorityScenario = requireScenarioOption(lookups, scenario.approvedScenarioId, 'retrieval corpus');
  const maintenancePolicy = maintenancePolicyFromScenario(lookups, 'retrieval corpus');
  const visibleCorrections = scenario.decisionCase.corrections.filter((correction: Entity) => isVisibleObservedFact(lookups, correction.approvedAt));
  const visibleActions = lookups.actions.filter((action) => isVisibleObservedFact(lookups, action.executedAt));
  const visibleOutcomes = scenario.decisionCase.outcomes.filter((outcome: Entity) => isVisibleObservedFact(lookups, outcome.recordedAt));

  addChunk(chunks, {
    chunkId: `${mainSlug}-overview`,
    sourceType: 'decision-case',
    sourceId: mainCaseId,
    title: scenario.decisionCase.title,
    text: `${mainCaseId} records that ${lookups.heroProduct.name} demand is running above forecast in coastal regions and other signal-affected markets while ${signalName} is active. Caldova has grounded the pattern to ${scenario.opportunity.affectedRegionCount} regions and is evaluating ${priorityScenario.name} for ${scenario.opportunity.incrementalUnits} incremental units and ${formatUsd(scenario.opportunity.incrementalRevenueUsd)}.`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['hydration-sunscreen', 'above-forecast', 'coastal-regions', 'climate-advisory', 'decision-memory'],
    caseId: mainCaseId,
  });

  addChunk(chunks, {
    chunkId: `${mainSlug}-future-reuse`,
    sourceType: 'decision-case',
    sourceId: mainCaseId,
    title: 'Future reuse guidance for similar sunscreen advisory',
    text: `${scenario.retrieval.futureQuery} Yes: retrieve ${mainCaseId}. ${
      includePostDecisionFacts()
        ? `The reusable answer is ${scenario.retrieval.expectedReuse.join('; ')}.`
        : `The reusable context is the affected-region demand pattern, ${scenario.recommendedOptionId}, and ${maintenancePolicy.policyId} v${maintenancePolicy.version}.`
    } The record says agents propose and role approvers decide.`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['future-query', 'decision-memory', 'reuse', 'climate-advisory'],
    caseId: mainCaseId,
  });

  addChunk(chunks, {
    chunkId: `${mainSlug}-signal-evidence`,
    sourceType: 'advisory',
    sourceId: scenario.externalSignal.signalId,
    title: `${signalName} evidence for ${mainCaseId}`,
    text: `${signalName} (${scenario.externalSignal.signalId}) has persistence probability ${scenario.externalSignal.persistenceProbability}, confidence ${scenario.externalSignal.confidence}, sea-surface anomaly ${scenario.externalSignal.seaSurfaceAnomalyC} C, and affected regions ${scenario.externalSignal.affectedRegionIds.join(', ')}. It invalidated the no-anomaly forecast assumptions for ${lookups.heroProduct.name}.`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['el-nino', 'external-signal', 'forecast-assumptions'],
    caseId: mainCaseId,
  });

  for (const region of lookups.regions) {
    addChunk(chunks, {
      chunkId: `${mainSlug}-variance-${slug(region.regionId)}`,
      sourceType: 'decision-case',
      sourceId: mainCaseId,
      title: `${region.name} forecast variance`,
      text: `${region.name} reported ${lookups.heroProduct.name} forecast units ${region.baselineForecastUnits30d}, actual units ${actualUnitsForVariance(
        region,
      )}, and variance ${formatPct(region.variancePct)} during ${scenario.clock.varianceWindowStart} to ${scenario.clock.varianceWindowEnd}. Signal affected flag is ${Boolean(region.signalAffected)} and opportunity incremental units are ${region.incrementalUnits}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['forecast-variance', region.marketCode, region.signalAffected ? 'signal-affected' : 'control-region'],
      caseId: mainCaseId,
    });
  }

  for (const commercialScenario of lookups.scenarios) {
    const approvalStatus =
      includePostDecisionFacts() && commercialScenario.scenarioId === scenario.approvedScenarioId ? 'approved' : 'pending decision';
    addChunk(chunks, {
      chunkId: `${mainSlug}-scenario-${slug(commercialScenario.scenarioId)}`,
      sourceType: 'option',
      sourceId: commercialScenario.scenarioId,
      title: commercialScenario.name,
      text: `${commercialScenario.name} was a commercial scenario in ${mainCaseId}. It modeled incremental budget ${formatUsd(
        commercialScenario.incrementalBudgetUsd,
      )}, incremental units ${commercialScenario.incrementalUnits}, incremental revenue ${formatUsd(
        commercialScenario.incrementalRevenueUsd,
      )}, confidence ${commercialScenario.confidence}, and approval status ${approvalStatus}. Rationale: ${commercialScenario.rationale}`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['commercial-scenario', commercialScenario.recommended ? 'recommended' : 'not-recommended'],
      caseId: mainCaseId,
    });
  }

  for (const option of lookups.options) {
    const planStatus = includePostDecisionFacts() && option.optionId === scenario.recommendedOptionId ? 'approved operating plan' : 'candidate operating plan';
    const disposition = option.rejectionReason ?? option.policyBasis?.join(', ') ?? (includePostDecisionFacts() ? 'approved' : 'available for approval');
    addChunk(chunks, {
      chunkId: caseOptionChunkId(mainCaseId, option.optionId),
      sourceType: 'option',
      sourceId: option.optionId,
      title: option.name,
      text: `${option.optionId} ${option.name} was evaluated for ${mainCaseId}. Summary: ${option.summary} It can deliver ${option.incrementalUnitsDelivered} incremental units, meets commitment=${option.meetsCommitment}, risk=${option.riskLevel}, policy compliant=${option.policyCompliant}, and recommended=${option.optionId === scenario.recommendedOptionId}. The ${planStatus} uses rate factor ${option.requiredRateFactor} and utilisation ${option.requiredUtilisation}; rejection or basis: ${disposition}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['production-option', option.optionId, option.recommended ? 'recommended' : 'alternative'],
      caseId: mainCaseId,
    });
  }

  addChunk(chunks, {
    chunkId: casePolicyChunkId(mainCaseId, maintenancePolicy),
    sourceType: 'policy',
    sourceId: maintenancePolicy.policyId,
    title: `${maintenancePolicy.name} applied to ${mainCaseId}`,
    text: `${maintenancePolicy.policyId} v${maintenancePolicy.version} supplies the deferral table used by ${mainCaseId}. At sustained rate factor ${recommendedOption.requiredRateFactor}, the policy permits ${scenario.maintenance.deferralDays} days of deferral with stress ceiling ${scenario.stressModel.stressCeilingPct} percent; the recommended plan projects ${scenario.stressModel.projectedStressPctOfThreshold} percent of threshold, within ceiling.`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['maintenance-policy', 'deferral-table', 'stress-ceiling', 'recommended-option'],
    caseId: mainCaseId,
  });

  for (const correctionRecord of visibleCorrections) {
    addChunk(chunks, {
      chunkId: caseCorrectionChunkId(mainCaseId, correctionRecord.correctionId),
      sourceType: 'assumption',
      sourceId: correctionRecord.correctionId,
      title: `Approved correction ${correctionRecord.correctionId}`,
      text: `${correctionRecord.correctionId} was approved by ${correctionRecord.approvedByRole}: ${correctionRecord.statement}. The correction means future Sun Care forecast assumptions must include an ENSO persistence check before publication.`,
      scopeKey: correctionRecord.scopeKey,
      tags: ['correction', 'forecast-assumption', 'enso-persistence-check'],
      caseId: mainCaseId,
    });
  }

  for (const action of visibleActions) {
    addChunk(chunks, {
      chunkId: `${mainSlug}-action-${slug(action.actionId)}`,
      sourceType: 'decision-case',
      sourceId: action.actionId,
      title: `${action.type} receipt ${action.receiptId}`,
      text: `${action.actionId} executed ${action.type} through ${action.api} for ${mainCaseId}. Requested ${action.requestedAt}, approved by role ${action.approvedByRole} at ${action.approvedAt}, executed ${action.executedAt}, receipt ${action.receiptId}, result ${action.result}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['governed-action', 'receipt', action.type],
      caseId: mainCaseId,
    });
  }

  for (const outcome of visibleOutcomes) {
    addChunk(chunks, {
      chunkId: caseOutcomeChunkId(mainCaseId, outcome.outcomeId),
      sourceType: 'outcome',
      sourceId: outcome.outcomeId,
      title: `${outcome.metricName} outcome`,
      text: `${outcome.outcomeId} recorded ${outcome.metricName} ${outcome.metricValue} against planned value ${outcome.plannedValue} for ${mainCaseId}. Result code ${outcome.resultCode} was recorded at ${outcome.recordedAt}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['outcome', outcome.resultCode, outcome.outcomeId],
      caseId: mainCaseId,
    });
  }

  for (const campaign of lookups.campaigns) {
    const region = requireEntity(lookups.regionById, campaign.regionId, 'region', `retrieval campaign ${campaign.campaignId}`);
    addChunk(chunks, {
      chunkId: `${mainSlug}-campaign-${slug(campaign.campaignId)}`,
      sourceType: 'decision-case',
      sourceId: campaign.campaignId,
      title: `${campaign.name} campaign context`,
      text: `${campaign.name} was an active ${campaign.channel} campaign for ${region.name}. Base budget ${formatUsd(
        campaign.baseBudgetUsd,
      )}, incremental budget ${formatUsd(campaign.incrementalBudgetUsd)}, signal affected region=${Boolean(region.signalAffected)}, and ${lookups.heroProduct.name} variance ${formatPct(region.variancePct)} connected it to ${mainCaseId}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['campaign', campaign.channel, region.marketCode],
      caseId: mainCaseId,
    });
  }

  const varianceStart = parseDate(scenario.clock.varianceWindowStart).getTime();
  const varianceEnd = parseDate(scenario.clock.varianceWindowEnd).getTime();
  for (const row of trendRows) {
    const rowTime = parseDate(String(row.date)).getTime();
    if (rowTime < varianceStart || rowTime > varianceEnd) continue;
    addChunk(chunks, {
      chunkId: `${mainSlug}-daily-${row.date}-${slug(String(row.region_id))}`,
      sourceType: 'decision-case',
      sourceId: mainCaseId,
      title: `Daily ${lookups.heroProduct.name} demand ${row.date} ${row.region}`,
      text: `On ${row.date}, ${row.region} had ${lookups.heroProduct.name} forecast units ${row.forecast_units} and actual units ${row.actual_units}. This daily evidence belongs to ${mainCaseId}, the ${scenario.externalSignal.name} sunscreen demand case, and signal affected flag was ${row.signal_affected_flag}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: ['daily-demand', 'forecast-vs-actual', String(row.region_id)],
      caseId: mainCaseId,
    });
  }

  for (const policy of lookups.policies) {
    addChunk(chunks, {
      chunkId: policyChunkId(policy),
      sourceType: 'policy',
      sourceId: policy.policyId,
      title: `${policy.name} v${policy.version}`,
      text: `${policy.policyId} v${policy.version} is ${policy.name}. Status ${policy.status}, effective ${policy.effectiveFrom}, rule ${JSON.stringify(policy.rule)}. It is governed policy context for Caldova planning decisions.`,
      scopeKey: null,
      tags: ['policy', policy.policyId, `v${policy.version}`],
      caseId: null,
    });
    for (const row of policy.rule?.deferralTable ?? []) {
      addChunk(chunks, {
        chunkId: policyDeferralChunkId(policy, row.maxSustainedRateFactor),
        sourceType: 'policy',
        sourceId: policy.policyId,
        title: `${policy.name} deferral row ${row.maxSustainedRateFactor}`,
        text: `${policy.policyId} v${policy.version} permits max deferral days ${row.maxDeferralDays} when max sustained rate factor is ${row.maxSustainedRateFactor}. This row helps explain why full-rate deferral is blocked and reduced-rate deferral can be permitted.`,
        scopeKey: null,
        tags: ['policy', 'deferral-table', String(row.maxSustainedRateFactor)],
        caseId: null,
      });
    }
  }

  for (const assumption of lookups.assumptions) {
    addChunk(chunks, {
      chunkId: `assumption-${slug(assumption.assumptionId)}`,
      sourceType: 'assumption',
      sourceId: assumption.assumptionId,
      title: `Forecast assumption ${assumption.assumptionId}`,
      text: `${assumption.assumptionId}: ${assumption.statement} It held after signal=${assumption.heldAfterSignal}; invalidated by signal ${assumption.invalidatedBySignalId ?? 'none'} for forecast version ${scenario.forecast.baselineVersion}.`,
      scopeKey: 'forecast-assumptions/sun-care',
      tags: ['forecast-assumption', assumption.heldAfterSignal ? 'held' : 'invalidated'],
      caseId: null,
    });
  }
  addChunk(chunks, {
    chunkId: 'assumption-enso-summary',
    sourceType: 'assumption',
    sourceId: 'forecast-assumptions/sun-care',
    title: 'ENSO persistence assumption summary',
    text:
      visibleCorrections.length > 0
        ? `The approved correction ${visibleCorrections[0].correctionId} says Sun Care forecast assumptions must include an ENSO persistence check for coastal and southern regions before a forecast version is published. This came from ${mainCaseId}.`
        : `The invalidated Sun Care assumptions for ${scenario.forecast.baselineVersion} show that an ENSO persistence check is required before relying on a no-anomaly forecast.`,
    scopeKey: 'forecast-assumptions/sun-care',
    tags: ['enso', 'forecast-assumption', 'correction'],
    caseId: mainCaseId,
  });

  for (const advisory of advisories) {
    addChunk(chunks, {
      chunkId: `advisory-${slug(advisory.signalId)}`,
      sourceType: 'advisory',
      sourceId: advisory.signalId,
      title: advisory.name,
      text: `${advisory.name} (${advisory.signalId}) from ${advisory.sourceLabel}. Observation period ${advisory.observationPeriod.start} to ${advisory.observationPeriod.end}, persistence probability ${advisory.persistenceProbability}, confidence ${advisory.confidence}, affected regions ${advisory.affectedRegionIds.join(', ')}. Narrative: ${advisory.narrative}`,
      scopeKey: advisory.signalId === scenario.externalSignal.signalId ? scenario.decisionCase.scopeKey : null,
      tags: advisory.tags,
      caseId: advisory.signalId === scenario.externalSignal.signalId ? mainCaseId : null,
    });
  }

  for (const decisionCase of decisionCases.filter((record) => record.caseId !== mainCaseId)) {
    addChunk(chunks, {
      chunkId: `${slug(decisionCase.caseId)}-overview`,
      sourceType: 'decision-case',
      sourceId: decisionCase.caseId,
      title: decisionCase.title,
      text: `${decisionCase.caseId} is a historical decision case about ${decisionCase.issue}. Caldova ${decisionCase.decision}; outcome ${decisionCase.outcomes[0].resultCode}. This case is intentionally different from the ${lookups.heroProduct.name} ${scenario.externalSignal.name} case.`,
      scopeKey: decisionCase.scopeKey,
      tags: ['historical-case', decisionCase.caseType, ...(decisionCase.tags ?? [])],
      caseId: decisionCase.caseId,
    });
    addChunk(chunks, {
      chunkId: `${slug(decisionCase.caseId)}-policy`,
      sourceType: 'policy',
      sourceId: decisionCase.appliedPolicies[0].policyId,
      title: `${decisionCase.caseId} policy context`,
      text: `${decisionCase.caseId} applied ${decisionCase.appliedPolicies[0].policyId} v${decisionCase.appliedPolicies[0].version} for ${decisionCase.caseType}. It should not be retrieved as the primary precedent for a persistent ${scenario.externalSignal.name} ${lookups.heroProduct.name} demand signal.`,
      scopeKey: decisionCase.scopeKey,
      tags: ['historical-policy', decisionCase.appliedPolicies[0].policyId],
      caseId: decisionCase.caseId,
    });
    addChunk(chunks, {
      chunkId: `${slug(decisionCase.caseId)}-action`,
      sourceType: 'decision-case',
      sourceId: decisionCase.governedActions[0].actionId,
      title: `${decisionCase.caseId} governed action`,
      text: `${decisionCase.governedActions[0].actionId} for ${decisionCase.caseId} was approved by role ${actionApprovedByRole(decisionCase.governedActions[0])} with receipt ${decisionCase.governedActions[0].receiptId}.`,
      scopeKey: decisionCase.scopeKey,
      tags: ['historical-action', 'receipt'],
      caseId: decisionCase.caseId,
    });
    addChunk(chunks, {
      chunkId: `${slug(decisionCase.caseId)}-outcome`,
      sourceType: 'outcome',
      sourceId: decisionCase.outcomes[0].outcomeId,
      title: `${decisionCase.caseId} outcome`,
      text: `${decisionCase.outcomes[0].outcomeId} recorded ${decisionCase.outcomes[0].metricName} ${decisionCase.outcomes[0].metricValue} against planned ${decisionCase.outcomes[0].plannedValue}; result ${decisionCase.outcomes[0].resultCode}.`,
      scopeKey: decisionCase.scopeKey,
      tags: ['historical-outcome', decisionCase.outcomes[0].resultCode],
      caseId: decisionCase.caseId,
    });
    addChunk(chunks, {
      chunkId: `${slug(decisionCase.caseId)}-discriminator`,
      sourceType: 'decision-case',
      sourceId: decisionCase.caseId,
      title: `${decisionCase.caseId} retrieval discriminator`,
      text: `${decisionCase.caseId} mentions ${decisionCase.productId}, ${decisionCase.regionId}, and ${decisionCase.lineId}. It is a plausible historical case but lacks the terms ${scenario.externalSignal.name}, ${lookups.heroProduct.name} demand above forecast, ${affectedRegionPhrase(lookups)}, ${scenario.recommendedOptionId}, and ${scenario.retrieval.futureSignalId}.`,
      scopeKey: decisionCase.scopeKey,
      tags: ['retrieval-discriminator', decisionCase.caseType],
      caseId: decisionCase.caseId,
    });
  }

  const weatherProvider = weatherContext.provider;
  addChunk(chunks, {
    chunkId: weatherProviderChunkId(String(weatherProvider.providerId)),
    sourceType: 'weather-provider',
    sourceId: String(weatherProvider.providerId),
    title: `${weatherProvider.name} provider record`,
    text: `${weatherProvider.name} (${weatherProvider.shortName}) publishes variables ${weatherProvider.variablesPublished.join(', ')} and anomaly variables ${weatherProvider.anomalyVariablesPublished.join(', ')} at ${weatherProvider.refreshCadence} cadence with ${weatherProvider.stationCoverage.stationCount} stations covering ${weatherProvider.stationCoverage.regionsCovered.join(', ')}. Source label: ${weatherProvider.sourceLabel}`,
    scopeKey: null,
    tags: ['weather-provider', 'external', 'source-label'],
    caseId: null,
  });

  const decisionBriefing = weatherContext.decisionBriefing;
  addChunk(chunks, {
    chunkId: forecastBriefingChunkId(String(decisionBriefing.issueDate)),
    sourceType: 'forecast-briefing',
    sourceId: String(decisionBriefing.briefingId),
    title: `Decision-day weather briefing ${decisionBriefing.issueDate}`,
    text: `${decisionBriefing.narrative} Region summaries: ${decisionBriefing.regionSummaries
      .map(
        (summary: Entity) =>
          `${summary.regionName} mean UV anomaly ${signed(summary.meanUvIndexAnomalyP50)}, mean temperature anomaly ${signed(
            summary.meanTemperatureMeanAnomalyCP50,
          )} C, confidence ${summary.meanConfidence}`,
      )
      .join('; ')}.`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['weather-forecast', 'decision-day', 'continuation', 'external'],
    caseId: mainCaseId,
  });

  const affectedRegionIds = new Set(strings(scenario.externalSignal.affectedRegionIds, 'externalSignal.affectedRegionIds'));
  const keyWeatherEvents = weatherContext.events
    .filter((event) => Boolean(event.relevantToHeroProduct) && (event.signalId === scenario.externalSignal.signalId || affectedRegionIds.has(event.regionId)))
    .slice(0, 12);
  assert(keyWeatherEvents.length > 0, 'retrieval corpus requires at least one key weather event');
  for (const event of keyWeatherEvents) {
    addChunk(chunks, {
      chunkId: weatherEventChunkId(String(event.eventId)),
      sourceType: 'weather-event',
      sourceId: String(event.eventId),
      title: String(event.headline),
      text: `${event.narrative} Event ${event.eventId} is tied to region ${event.regionId} (${event.regionName}), peak ${event.peakValue} ${event.peakMetric}, relevantToHeroProduct=${event.relevantToHeroProduct}, signalId=${event.signalId ?? 'none'}, source label ${event.sourceLabel}.`,
      scopeKey: scenario.decisionCase.scopeKey,
      tags: [...event.tags, 'retrieval-key-event'],
      caseId: mainCaseId,
    });
  }

  const demandResponse = weatherDemandResponse(lookups);
  addChunk(chunks, {
    chunkId: weatherDemandModelChunkId(String(demandResponse.modelId)),
    sourceType: 'weather-demand-model',
    sourceId: String(demandResponse.modelId),
    title: `${demandResponse.modelId} weather elasticity model`,
    text: `${demandResponse.modelId} is the external-weather demand response model for ${lookups.heroProduct.name}. Formula ${demandResponse.formula}; betaUv ${demandResponse.betaUv} percent per UV anomaly point and betaTempC ${demandResponse.betaTempC} percent per degree C. Weather observations over ${scenario.clock.varianceWindowStart} to ${scenario.clock.varianceWindowEnd} reconcile to observed variance: ${weatherContext.reconciliationRows
      .map(
        (row) =>
          `${row.region} modelled ${formatPct(Number(row.modelled_weather_uplift_pct))} vs actual ${formatPct(
            Number(row.actual_sales_variance_pct),
          )} difference ${formatPct(Number(row.difference_pct))}`,
      )
      .join('; ')}. Source label: ${weatherProvider.sourceLabel}`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['weather-demand-response', 'elasticity', 'variance-reconciliation', 'external'],
    caseId: mainCaseId,
  });

  const seasonalOutlook = weatherSeasonalOutlook(lookups);
  addChunk(chunks, {
    chunkId: weatherSeasonalOutlookChunkId(String(seasonalOutlook.signalId)),
    sourceType: 'seasonal-outlook',
    sourceId: String(seasonalOutlook.signalId),
    title: `Seasonal outlook ${seasonalOutlook.signalId}`,
    text: `External seasonal outlook ${seasonalOutlook.signalId} carries approximately ${formatPct(
      Number(seasonalOutlook.persistenceProbability) * 100,
    )} persistence probability through ${seasonalOutlook.persistenceThrough}, covering the remaining campaign window to ${scenario.clock.campaignEnd}. It is consistent with ${scenario.externalSignal.signalId} and affects ${scenario.externalSignal.affectedRegionIds.join(', ')}. Source label: ${weatherProvider.sourceLabel}`,
    scopeKey: scenario.decisionCase.scopeKey,
    tags: ['seasonal-outlook', 'enso', 'persistence', 'external'],
    caseId: mainCaseId,
  });

  assert(chunks.length >= 150 && chunks.length <= 400, `retrieval corpus must contain 150-400 chunks, got ${chunks.length}`);
  return chunks;
}

function buildRetrievalProbes(lookups: Lookups, weatherContext: WeatherContext): Entity[] {
  const { scenario } = lookups;
  const mainSlug = slug(scenario.decisionCase.caseId);
  const maintenancePolicy = maintenancePolicyFromScenario(lookups, 'retrieval probes');
  const recommendedOption = requireOption(lookups, scenario.recommendedOptionId, 'retrieval probes');
  const invalidated = invalidatedAssumptions(lookups);
  const probes = [
    {
      probeId: 'PROBE-DEMO-4-FUTURE-MEMORY',
      query: scenario.retrieval.futureQuery,
      expectedCaseId: scenario.retrieval.mustRetrieveCaseId,
      expectedChunkIds: [
        `${mainSlug}-future-reuse`,
        `${mainSlug}-overview`,
        caseOptionChunkId(scenario.decisionCase.caseId, scenario.recommendedOptionId),
        casePolicyChunkId(scenario.decisionCase.caseId, maintenancePolicy),
      ],
    },
    {
      probeId: 'PROBE-DEMO-1-CAUSE',
      query: `What is driving the increase in ${lookups.heroProduct.name} sales and will it continue?`,
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: [`${mainSlug}-signal-evidence`, `${mainSlug}-overview`, `advisory-${slug(scenario.externalSignal.signalId)}`],
    },
    {
      probeId: 'PROBE-DEMO-1-WEATHER-CONTINUATION',
      query: `Will the weather conditions driving ${lookups.heroProduct.name} demand continue beyond Tim's decision day?`,
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: [
        forecastBriefingChunkId(String(weatherContext.decisionBriefing.issueDate)),
        weatherSeasonalOutlookChunkId(scenario.externalSignal.signalId),
        weatherDemandModelChunkId(String(weatherDemandResponse(lookups).modelId)),
        weatherProviderChunkId(String(weatherContext.provider.providerId)),
      ],
    },
    {
      probeId: 'PROBE-MAINTENANCE-POLICY',
      query: `Why was a ${scenario.maintenance.deferralDays} day maintenance deferral allowed only under the reduced-rate plan?`,
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: [
        casePolicyChunkId(scenario.decisionCase.caseId, maintenancePolicy),
        policyChunkId(maintenancePolicy),
        policyDeferralChunkId(maintenancePolicy, recommendedOption.requiredRateFactor),
        caseOptionChunkId(scenario.decisionCase.caseId, scenario.recommendedOptionId),
      ],
    },
  ];

  if (includePostDecisionFacts()) {
    const correction = firstCorrection(lookups, 'retrieval probes');
    const demandOutcome = demandOutcomeFromScenario(lookups, 'retrieval probes');
    probes[0].expectedChunkIds.push(
      caseCorrectionChunkId(scenario.decisionCase.caseId, correction.correctionId),
      caseOutcomeChunkId(scenario.decisionCase.caseId, demandOutcome.outcomeId),
    );
    probes.push({
      probeId: 'PROBE-GOVERNED-ACTIONS',
      query: 'Which governed actions executed the campaign and production plan, and what receipts prove it?',
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: lookups.actions.map((action) => `${mainSlug}-action-${slug(action.actionId)}`),
    });
    probes.push({
      probeId: 'PROBE-FORECAST-CORRECTION',
      query: 'Which forecast assumptions were invalidated and what correction was approved for future sun-care forecasts?',
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: [
        ...invalidated.map((assumption) => `assumption-${slug(assumption.assumptionId)}`),
        'assumption-enso-summary',
        caseCorrectionChunkId(scenario.decisionCase.caseId, correction.correctionId),
      ],
    });
  } else {
    probes.push({
      probeId: 'PROBE-FORECAST-ASSUMPTIONS',
      query: 'Which forecast assumptions were invalidated by the active sun-care climate signal?',
      expectedCaseId: scenario.decisionCase.caseId,
      expectedChunkIds: [...invalidated.map((assumption) => `assumption-${slug(assumption.assumptionId)}`), 'assumption-enso-summary'],
    });
  }

  return probes;
}

function receiptRecords(lookups: Lookups, decisionCases: DecisionCaseRecord[]): Entity[] {
  const receipts: Entity[] = lookups.actions
    .filter((action) => isVisibleObservedFact(lookups, action.executedAt))
    .map((action) => ({
      caseId: lookups.scenario.decisionCase.caseId,
      actionId: action.actionId,
      type: action.type,
      api: action.api,
      requestedAt: action.requestedAt,
      approvedAt: action.approvedAt,
      executedAt: action.executedAt,
      approvedByRole: action.approvedByRole,
      receiptId: action.receiptId,
      result: action.result,
      details: action.details,
    }));

  for (const decisionCase of decisionCases) {
    if (decisionCase.caseId === lookups.scenario.decisionCase.caseId) continue;
    for (const action of decisionCase.governedActions ?? []) {
      const approvedByRole = actionApprovedByRole(action);
      requireRole(lookups, approvedByRole, `historical receipt ${action.receiptId}`);
      receipts.push({
        caseId: decisionCase.caseId,
        actionId: action.actionId,
        type: action.type,
        api: action.api,
        requestedAt: action.requestedAt,
        approvedAt: action.approvedAt,
        executedAt: action.executedAt,
        approvedByRole,
        receiptId: action.receiptId,
        result: action.result,
        details: action.details,
      });
    }
  }

  return receipts;
}

function sourceStores(...values: string[]): string[] {
  return values;
}

function buildEvaluationQuestions(lookups: Lookups, weatherContext: WeatherContext): Entity[] {
  const { scenario } = lookups;
  const showOutcome = includePostDecisionFacts();
  const receipts = showOutcome ? lookups.actions.map((action) => action.receiptId) : [];
  const commercialPolicy = commercialPolicyFromScenario(lookups, 'evaluation questions');
  const maintenancePolicy = maintenancePolicyFromScenario(lookups, 'evaluation questions');
  const provider = weatherContext.provider;
  const decisionBriefing = weatherContext.decisionBriefing;
  const seasonalOutlook = weatherSeasonalOutlook(lookups);
  return [
    {
      id: 'DEMO-1',
      demo: 'Commercial Command Centre',
      persona: scenario.commitment.approvedByPersonaId,
      act: 1,
      question: `What's driving the increase in ${lookups.heroProduct.name} sales, and is it likely to continue?`,
      authoritativeSources: sourceStores('Fabric SQL Database', 'Lakehouse'),
      expectedFacts: [
        lookups.heroProduct.name,
        scenario.externalSignal.name,
        String(scenario.opportunity.incrementalRevenueUsd),
        affectedRegionPhrase(lookups),
        String(scenario.opportunity.affectedRegionCount),
        scenario.externalSignal.signalId,
        scenario.externalSignal.sourceLabel,
        scenario.forecast.baselineVersion,
        String(decisionBriefing.issueDate),
        String(decisionBriefing.horizonEndDate),
        String(requireWeather(lookups).forecast.leadDayRange),
        formatPct(Number(seasonalOutlook.persistenceProbability) * 100),
        ...affectedRegions(lookups).map((region) => region.regionId),
        ...affectedRegions(lookups).map((region) => region.name),
        String(provider.sourceLabel),
        String(weatherDemandResponse(lookups).modelId),
        ...weatherContext.reconciliationRows.map(
          (row) =>
            `${row.region_id} modelled weather uplift ${formatPct(Number(row.modelled_weather_uplift_pct))} vs observed variance ${formatPct(
              Number(row.actual_sales_variance_pct),
            )}`,
        ),
      ],
      mustNotClaim: [
        `The ${scenario.externalSignal.name} signal came from a public meteorological agency.`,
        `The ${provider.shortName} feed is a public agency source.`,
        'The agent approved campaign budget.',
        'Unaffected control regions prove a global trend.',
      ],
    },
    {
      id: 'DEMO-2',
      demo: 'Campaign approval',
      persona: scenario.commitment.approvedByPersonaId,
      act: 2,
      question: 'If we increase campaign investment, what demand should we expect, and which regions should we prioritise?',
      authoritativeSources: sourceStores('Fabric SQL Database', 'Lakehouse'),
      expectedFacts: [
        scenario.approvedScenarioId,
        String(requireScenarioOption(lookups, scenario.approvedScenarioId, 'evaluation questions').incrementalBudgetUsd),
        commercialPolicy.policyId,
        String(commercialPolicy.rule.maxIncrementalBudgetUsdWithoutBoardApproval),
        ...(showOutcome
          ? [String(scenario.commitment.committedUnits), String(scenario.commitment.committedRevenueUsd), lookups.actions[0].receiptId]
          : []),
      ],
      mustNotClaim: [
        `${lookups.scenarios.find((item) => item.blockedByPolicyId)?.name ?? 'The blocked commercial scenario'} was approved.`,
        'The agent approved the commitment itself.',
        'The commercial approver can exceed policy without board approval.',
      ],
    },
    {
      id: 'DEMO-3',
      demo: 'Production plan',
      persona: personaIdForAct(lookups, 3, 'evaluation questions'),
      act: 3,
      question: 'What would let us meet the demand without compromising maintenance or existing orders?',
      authoritativeSources: sourceStores('Fabric SQL Database', 'Eventhouse', 'Lakehouse'),
      expectedFacts: [
        maintenanceWindowPhrase(lookups),
        String(scenario.capacityModel.expected.shortfallUnits),
        deferralDaysPhrase(lookups),
        String(scenario.stressModel.projectedStressPctOfThreshold),
        scenario.recommendedOptionId,
        maintenancePolicy.policyId,
        ...(showOutcome ? [lookups.actions[1].receiptId, lookups.actions[2].receiptId] : []),
      ],
      mustNotClaim: [
        'Maintenance can be deferred at full rate.',
        'The agent bypassed an approver.',
        'Existing orders were missed.',
      ],
    },
    {
      id: 'DEMO-4',
      demo: 'Decision memory',
      persona: personaIdForAct(lookups, 5, 'evaluation questions'),
      act: 5,
      question: scenario.retrieval.futureQuery,
      authoritativeSources: sourceStores('Lakehouse'),
      expectedFacts: [
        scenario.decisionCase.caseId,
        scenario.retrieval.futureSignalId,
        ...(showOutcome ? scenario.retrieval.expectedReuse : [scenario.recommendedOptionId, maintenancePolicy.policyId]),
        ...receipts,
      ],
      mustNotClaim: [
        `The ${scenario.retrieval.futureSignalId} signal came from a public meteorological agency.`,
        `A new decision should ignore the retained ${scenario.decisionCase.caseId} case.`,
        'The corpus contains person-level business data.',
      ],
    },
  ];
}

function buildExpectedResults(lookups: Lookups, retrievalCorpusRows: number, weatherContext: WeatherContext): Entity {
  const { scenario } = lookups;
  const showOutcome = includePostDecisionFacts();
  const approvedScenario = requireScenarioOption(lookups, scenario.approvedScenarioId, 'expected results');
  const aggressiveScenario = lookups.scenarios.find((item) => item.blockedByPolicyId);
  assert(aggressiveScenario, 'expected blocked commercial scenario');
  const recommendedOption = requireOption(lookups, scenario.recommendedOptionId, 'expected results');
  const commercialPolicy = commercialPolicyFromScenario(lookups, 'expected results');
  const maintenancePolicy = maintenancePolicyFromScenario(lookups, 'expected results');
  const demandOutcome = showOutcome ? demandOutcomeFromScenario(lookups, 'expected results') : null;
  const revenueOutcome = showOutcome ? revenueOutcomeFromScenario(lookups, 'expected results') : null;
  const correction = showOutcome ? firstCorrection(lookups, 'expected results') : null;
  const seasonalOutlook = weatherSeasonalOutlook(lookups);
  const expectedMemoryChunkIds = [
    `${slug(scenario.decisionCase.caseId)}-future-reuse`,
    `${slug(scenario.decisionCase.caseId)}-overview`,
    caseOptionChunkId(scenario.decisionCase.caseId, scenario.recommendedOptionId),
    casePolicyChunkId(scenario.decisionCase.caseId, maintenancePolicy),
  ];
  if (showOutcome && correction && demandOutcome) {
    expectedMemoryChunkIds.push(
      caseCorrectionChunkId(scenario.decisionCase.caseId, correction.correctionId),
      caseOutcomeChunkId(scenario.decisionCase.caseId, demandOutcome.outcomeId),
    );
  }

  return {
    dataset: scenario.dataset,
    schemaVersion: scenario.schemaVersion,
    generatedFrom: 'data/scenario.json',
    demos: [
      {
        id: 'DEMO-1',
        sources: [
          { store: 'Lakehouse', file: 'data/lakehouse/dashboard/forecast-variance-by-region.csv' },
          { store: 'Lakehouse', file: 'data/lakehouse/dashboard/hero-demand-trend.csv' },
          { store: 'Lakehouse', file: 'data/lakehouse/dashboard/weather-anomaly-by-region.csv' },
          { store: 'Lakehouse', file: 'data/lakehouse/dashboard/weather-forecast-outlook.csv' },
          { store: 'Lakehouse', file: 'data/lakehouse/dashboard/weather-demand-reconciliation.csv' },
          { store: 'Lakehouse', file: 'data/lakehouse/external-signals/climate-advisories.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/external-signals/signal-evidence-trace.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/external-signals/weather-provider.json' },
          { store: 'Lakehouse', file: 'data/lakehouse/external-signals/weather-events.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/external-signals/forecast-briefings.jsonl' },
        ],
        expectedNumericValues: {
          affectedRegionCount: scenario.opportunity.affectedRegionCount,
          incrementalUnits: scenario.opportunity.incrementalUnits,
          incrementalRevenueUsd: scenario.opportunity.incrementalRevenueUsd,
          unitPriceUsd: scenario.unitPriceUsd,
          persistenceProbability: scenario.externalSignal.persistenceProbability,
          confidence: scenario.externalSignal.confidence,
          seaSurfaceAnomalyC: scenario.externalSignal.seaSurfaceAnomalyC,
          regionVariancePct: Object.fromEntries(lookups.regions.map((region) => [region.regionId, region.variancePct])),
          decisionDayHorizonDays: weatherContext.decisionBriefing.horizonDays,
          decisionDayForecastTargetDays: weatherContext.decisionBriefing.forecastTargetDays,
          seasonalPersistenceProbability: seasonalOutlook.persistenceProbability,
          decisionDayForecastMeanAnomalyByRegion: Object.fromEntries(
            weatherContext.decisionBriefing.regionSummaries.map((summary: Entity) => [
              summary.regionId,
              {
                meanUvIndexAnomalyP50: summary.meanUvIndexAnomalyP50,
                minUvIndexAnomalyP50: summary.minUvIndexAnomalyP50,
                maxUvIndexAnomalyP50: summary.maxUvIndexAnomalyP50,
                meanTemperatureMeanAnomalyCP50: summary.meanTemperatureMeanAnomalyCP50,
                minTemperatureMeanAnomalyCP50: summary.minTemperatureMeanAnomalyCP50,
                maxTemperatureMeanAnomalyCP50: summary.maxTemperatureMeanAnomalyCP50,
                meanConfidence: summary.meanConfidence,
              },
            ]),
          ),
          weatherDemandReconciliation: Object.fromEntries(
            weatherContext.reconciliationRows.map((row) => [
              row.region_id,
              {
                modelledWeatherUpliftPct: row.modelled_weather_uplift_pct,
                actualSalesVariancePct: row.actual_sales_variance_pct,
                differencePct: row.difference_pct,
              },
            ]),
          ),
        },
        expectedIds: {
          signalId: scenario.externalSignal.signalId,
          heroProductId: scenario.heroProductId,
          affectedRegionIds: scenario.externalSignal.affectedRegionIds,
          invalidatedAssumptionIds: lookups.assumptions
            .filter((assumption) => assumption.invalidatedBySignalId === scenario.externalSignal.signalId)
            .map((assumption) => assumption.assumptionId),
          weatherProviderId: weatherContext.provider.providerId,
          weatherProviderSourceLabel: weatherContext.provider.sourceLabel,
          decisionDayForecastIssueDate: weatherContext.decisionBriefing.issueDate,
          decisionDayHorizonEnd: weatherContext.decisionBriefing.horizonEndDate,
          decisionDayLeadDayRange: requireWeather(lookups).forecast.leadDayRange,
          decisionDayForecastBriefingId: weatherContext.decisionBriefing.briefingId,
        },
      },
      {
        id: 'DEMO-2',
        sources: [
          { store: 'Lakehouse', file: 'data/lakehouse/decision-cases/decision-cases.jsonl' },
          { store: 'Lakehouse', file: 'data/receipts/action-receipts.json' },
        ],
        expectedNumericValues: {
          blockedScenarioBudgetUsd: aggressiveScenario.incrementalBudgetUsd,
          commercialApprovalLimitUsd: commercialPolicy.rule.maxIncrementalBudgetUsdWithoutBoardApproval,
          ...(showOutcome
            ? {
                approvedIncrementalBudgetUsd: approvedScenario.incrementalBudgetUsd,
                committedUnits: scenario.commitment.committedUnits,
                committedRevenueUsd: scenario.commitment.committedRevenueUsd,
              }
            : {
                candidateIncrementalBudgetUsd: approvedScenario.incrementalBudgetUsd,
              }),
        },
        expectedIds: {
          caseId: scenario.decisionCase.caseId,
          blockingPolicy: policyKey(commercialPolicy.policyId, commercialPolicy.version),
          ...(showOutcome
            ? {
                approvedScenarioId: scenario.approvedScenarioId,
                commitmentId: scenario.commitment.commitmentId,
                campaignReceiptId: lookups.actions[0].receiptId,
              }
            : {
                scenarioUnderReviewId: scenario.approvedScenarioId,
              }),
        },
      },
      {
        id: 'DEMO-3',
        sources: [
          { store: 'Lakehouse', file: 'data/lakehouse/decision-cases/decision-cases.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/decision-cases/decision-case-timeline.jsonl' },
          { store: 'Lakehouse', file: 'data/receipts/action-receipts.json' },
        ],
        expectedNumericValues: {
          maintenanceOperatingDaysLost: scenario.capacityModel.maintenanceOperatingDaysLost,
          capacityWithoutMaintenanceUnits: scenario.capacityModel.expected.capacityWithoutMaintenanceUnits,
          capacityWithMaintenanceUnits: scenario.capacityModel.expected.capacityWithMaintenanceUnits,
          headroomWithoutMaintenanceUnits: scenario.capacityModel.expected.headroomWithoutMaintenanceUnits,
          headroomWithMaintenanceUnits: scenario.capacityModel.expected.headroomWithMaintenanceUnits,
          requiredIncrementalUnits: scenario.capacityModel.expected.requiredIncrementalUnits,
          shortfallUnits: scenario.capacityModel.expected.shortfallUnits,
          deferralDays: scenario.maintenance.deferralDays,
          projectedStressPctOfThreshold: scenario.stressModel.projectedStressPctOfThreshold,
          stressCeilingPct: scenario.stressModel.stressCeilingPct,
          rateFactor: recommendedOption.requiredRateFactor,
          utilisation: recommendedOption.requiredUtilisation,
          maxDeliverableIncrementalUnitsUnderBestPlan: scenario.capacityModel.expected.maxDeliverableIncrementalUnitsUnderBestPlan,
        },
        expectedIds: {
          recommendedOptionId: scenario.recommendedOptionId,
          lineId: scenario.capacityModel.lineId,
          maintenanceWindowId: scenario.maintenance.maintenanceWindowId,
          policy: policyKey(maintenancePolicy.policyId, maintenancePolicy.version),
          ...(showOutcome
            ? {
                productionReceiptId: lookups.actions[1].receiptId,
                maintenanceReceiptId: lookups.actions[2].receiptId,
              }
            : {}),
        },
      },
      {
        id: 'DEMO-4',
        sources: [
          { store: 'Lakehouse', file: 'data/lakehouse/retrieval/retrieval-corpus.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/retrieval/retrieval-probes.jsonl' },
          { store: 'Lakehouse', file: 'data/lakehouse/decision-cases/decision-cases.jsonl' },
        ],
        expectedNumericValues: {
          retrievalCorpusRows,
          plannedIncrementalUnits: scenario.opportunity.incrementalUnits,
          plannedIncrementalRevenueUsd: scenario.opportunity.incrementalRevenueUsd,
          stressPctOfThresholdAtMaintenance: scenario.stressModel.projectedStressPctOfThreshold,
          ...(showOutcome && demandOutcome && revenueOutcome
            ? {
                deliveredIncrementalUnits: demandOutcome.metricValue,
                realisedIncrementalRevenueUsd: revenueOutcome.metricValue,
              }
            : {}),
        },
        expectedIds: {
          mustRetrieveCaseId: scenario.retrieval.mustRetrieveCaseId,
          futureSignalId: scenario.retrieval.futureSignalId,
          expectedReuse: showOutcome ? scenario.retrieval.expectedReuse : [scenario.recommendedOptionId, policyKey(maintenancePolicy.policyId, maintenancePolicy.version)],
          receiptIds: showOutcome ? lookups.actions.map((action) => action.receiptId) : [],
          expectedChunkIds: expectedMemoryChunkIds,
        },
      },
    ],
  };
}

function validateRetrievalProbes(probes: Entity[], chunks: RetrievalChunk[]): void {
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  for (const probe of probes) {
    for (const chunkId of probe.expectedChunkIds) {
      assert(chunkIds.has(chunkId), `retrieval probe ${probe.probeId} expects missing chunk ${chunkId}`);
    }
  }
}

function validateNoPersonApprovals(receipts: Entity[], decisionCases: DecisionCaseRecord[]): void {
  for (const receipt of receipts) {
    assert(!('approvedByPersonaId' in receipt), `receipt ${receipt.receiptId} must not contain approvedByPersonaId`);
    assert(!('approvedByPerson' in receipt), `receipt ${receipt.receiptId} must not contain person-level approval data`);
    assert(!('approverRole' in receipt), `receipt ${receipt.receiptId} must use approvedByRole, not approverRole`);
    assert(typeof receipt.approvedByRole === 'string' && receipt.approvedByRole.startsWith('ROLE-'), `receipt ${receipt.receiptId} must use a role approver`);
  }
  for (const decisionCase of decisionCases) {
    for (const action of decisionCase.governedActions ?? []) {
      assert(!('approvedByPersonaId' in action), `case ${decisionCase.caseId} action ${action.actionId} must not contain approvedByPersonaId`);
      assert(action.approverRole || action.approvedByRole, `case ${decisionCase.caseId} action ${action.actionId} missing approver role`);
    }
  }
}

function validateReceiptCoverage(lookups: Lookups, decisionCases: DecisionCaseRecord[], receipts: Entity[]): void {
  const receiptById = new Map<string, Entity>();
  for (const receipt of receipts) {
    assert(!receiptById.has(receipt.receiptId), `duplicate receipt id ${receipt.receiptId}`);
    requireRole(lookups, receipt.approvedByRole, `receipt ${receipt.receiptId}`);
    receiptById.set(receipt.receiptId, receipt);
  }

  const visibleActions = lookups.actions.filter((action) => isVisibleObservedFact(lookups, action.executedAt));
  const hiddenActionReceiptIds = new Set(lookups.actions.filter((action) => !visibleActions.includes(action)).map((action) => action.receiptId));
  for (const receiptId of hiddenActionReceiptIds) {
    assert(!receiptById.has(receiptId), `default dataset must not emit future receipt ${receiptId}`);
  }

  for (const action of visibleActions) {
    const receipt = receiptById.get(action.receiptId);
    assert(receipt, `canonical action ${action.actionId} is missing receipt ${action.receiptId}`);
    assert(receipt.caseId === lookups.scenario.decisionCase.caseId, `canonical receipt ${action.receiptId} has wrong caseId`);
    for (const field of ['actionId', 'type', 'api', 'requestedAt', 'approvedAt', 'executedAt', 'approvedByRole', 'receiptId', 'result']) {
      assert(receipt[field] === action[field], `canonical receipt ${action.receiptId} changed ${field}`);
    }
    assert(JSON.stringify(receipt.details) === JSON.stringify(action.details), `canonical receipt ${action.receiptId} changed details`);
  }

  for (const decisionCase of decisionCases) {
    for (const action of decisionCase.governedActions ?? []) {
      const receipt = receiptById.get(action.receiptId);
      assert(receipt, `decision case ${decisionCase.caseId} references missing receipt ${action.receiptId}`);
      assert(receipt.caseId === decisionCase.caseId, `receipt ${action.receiptId} caseId does not match ${decisionCase.caseId}`);
      assert(receipt.actionId === action.actionId, `receipt ${action.receiptId} actionId does not match decision case`);
      assert(receipt.type === action.type, `receipt ${action.receiptId} type does not match decision case`);
      assert(receipt.api === action.api, `receipt ${action.receiptId} api does not match decision case`);
      assert(receipt.approvedAt === action.approvedAt, `receipt ${action.receiptId} approvedAt does not match decision case`);
      assert(receipt.approvedByRole === actionApprovedByRole(action), `receipt ${action.receiptId} approvedByRole does not match decision case`);
    }
  }
}

function validateDashboardRows(lookups: Lookups, varianceRows: ForecastVarianceRow[], trendRows: HeroTrendRow[]): void {
  assert(varianceRows.length === lookups.regions.length, 'forecast variance CSV must contain one row per region');
  const byRegion = new Map<string, { forecast: number; actual: number }>();
  const start = parseDate(lookups.scenario.clock.varianceWindowStart).getTime();
  const end = parseDate(lookups.scenario.clock.varianceWindowEnd).getTime();
  for (const row of trendRows) {
    const time = parseDate(String(row.date)).getTime();
    if (time < start || time > end) continue;
    const existing = byRegion.get(String(row.region_id)) ?? { forecast: 0, actual: 0 };
    existing.forecast += Number(row.forecast_units);
    existing.actual += Number(row.actual_units);
    byRegion.set(String(row.region_id), existing);
  }
  for (const row of varianceRows) {
    const fromTrend = byRegion.get(String(row.region_id));
    assert(fromTrend, `trend rows missing variance-window data for ${row.region_id}`);
    assert(fromTrend.forecast === Number(row.forecast_units), `trend forecast total mismatch for ${row.region_id}`);
    assert(fromTrend.actual === Number(row.actual_units), `trend actual total mismatch for ${row.region_id}`);
  }
}

function validateWeatherContext(lookups: Lookups, weatherContext: WeatherContext): void {
  const provider = weatherProviderConfig(lookups);
  const weatherDocs = [weatherContext.provider, ...weatherContext.events, ...weatherContext.briefings];
  for (const record of weatherDocs) {
    assert(record.provenance === provider.provenance, 'weather document must preserve provider provenance');
    assert(record.provenance === 'external', 'weather document provenance must be external');
    assert(record.sourceLabel === provider.sourceLabel, 'weather document must preserve provider sourceLabel');
  }
  for (const record of weatherContext.events) {
    // An event is observable once it has started. Its endDate may legitimately
    // sit in the future - a persistent advisory saying it runs through November
    // is a forward-looking validity period, not a leaked observation, and it is
    // exactly what the "will it continue?" question reasons about.
    assert(isVisibleObservedFact(lookups, String(record.startDate)), `weather event ${record.eventId} must not expose post-as-of observations`);
  }
  for (const record of weatherContext.briefings) {
    assert(
      includePostDecisionFacts() || isObservable(lookups.scenario, String(record.issueDate)),
      `forecast briefing ${record.briefingId} issue date is after ${asOfDate(lookups.scenario)}`,
    );
  }
  const weatherRows = [...weatherContext.anomalyRows, ...weatherContext.forecastOutlookRows, ...weatherContext.reconciliationRows];
  for (const row of weatherRows) {
    assert(row.provenance === provider.provenance, 'weather dashboard row must preserve provider provenance');
    assert(row.provenance === 'external', 'weather dashboard row provenance must be external');
    assert(row.source_label === provider.sourceLabel, 'weather dashboard row must preserve provider source_label');
  }
  assert(weatherContext.anomalyRows.length === lookups.regions.length, 'weather anomaly dashboard must contain one row per region');
  assert(weatherContext.reconciliationRows.length === lookups.regions.length, 'weather reconciliation dashboard must contain one row per region');
  assert(
    weatherContext.forecastOutlookRows.length === lookups.regions.length * forecastTargetDaysForIssue(lookups, requireWeather(lookups).forecast.decisionDayIssue),
    'weather forecast outlook must contain one decision-day row per region per lead day',
  );
  assert(
    weatherContext.decisionBriefing.horizonEndDate === requireWeather(lookups).forecast.decisionDayHorizonEnd,
    'decision-day weather briefing horizon end must match scenario.weather.forecast',
  );
}

export async function generateLakehouse(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const lookups = buildLookups(scenario);
  validateScenario(lookups);

  const weatherInputs = await loadWeatherInputs(lookups);
  const advisories = buildAdvisories(lookups);
  const weatherContext = buildWeatherContext(lookups, weatherInputs, advisories);
  const evidenceTrace = buildEvidenceTrace(lookups);
  const decisionCases = [mainDecisionCase(lookups), ...buildHistoricalCases(lookups)];
  const timeline = buildTimeline(lookups);
  const varianceRows = buildForecastVarianceRows(lookups);
  const trendRows = buildHeroTrendRows(lookups);
  const campaignRows = buildCampaignPerformanceRows(lookups);
  const assumptionRows = buildForecastAssumptionRows(lookups);
  const retrievalCorpus = buildRetrievalCorpus(lookups, advisories, decisionCases, trendRows, weatherContext);
  const retrievalProbes = buildRetrievalProbes(lookups, weatherContext);
  const receipts = receiptRecords(lookups, decisionCases);
  const evaluationQuestions = buildEvaluationQuestions(lookups, weatherContext);
  const expectedResults = buildExpectedResults(lookups, retrievalCorpus.length, weatherContext);

  validateRetrievalProbes(retrievalProbes, retrievalCorpus);
  validateNoPersonApprovals(receipts, decisionCases);
  validateReceiptCoverage(lookups, decisionCases, receipts);
  validateDashboardRows(lookups, varianceRows, trendRows);
  validateWeatherContext(lookups, weatherContext);

  const results: GenerationResult[] = [];
  results.push(await writeRecords('lakehouse/external-signals/climate-advisories.jsonl', advisories));
  results.push(await writeRecords('lakehouse/external-signals/signal-evidence-trace.jsonl', evidenceTrace));
  await writeJson('lakehouse/external-signals/weather-provider.json', weatherContext.provider);
  results.push({ file: 'lakehouse/external-signals/weather-provider.json', rows: 1 });
  results.push(await writeRecords('lakehouse/external-signals/weather-events.jsonl', weatherContext.events));
  results.push(await writeRecords('lakehouse/external-signals/forecast-briefings.jsonl', weatherContext.briefings));
  // Azure Cosmos DB requires every document to carry an `id` property, and these
  // documents are imported into a Cosmos container for Act 5. `id` mirrors the
  // natural key so the relational and document views stay reconcilable.
  const cosmosDecisionCases = decisionCases.map((c: Entity) => ({ id: c.caseId, ...c }));
  const cosmosTimeline = timeline.map((t: Entity, index: number) => ({
    id: `${t.caseId}-${String(index + 1).padStart(3, '0')}`,
    ...t,
  }));
  for (const doc of cosmosDecisionCases) {
    assert(typeof doc.id === 'string' && doc.id.length > 0, 'decision case document is missing a Cosmos id');
  }
  for (const doc of cosmosTimeline) {
    assert(typeof doc.id === 'string' && doc.id.length > 0, 'decision timeline document is missing a Cosmos id');
  }
  results.push(await writeRecords('lakehouse/decision-cases/decision-cases.jsonl', cosmosDecisionCases));
  results.push(await writeRecords('lakehouse/decision-cases/decision-case-timeline.jsonl', cosmosTimeline));
  results.push(await writeRecords('lakehouse/retrieval/retrieval-corpus.jsonl', retrievalCorpus));
  results.push(await writeRecords('lakehouse/retrieval/retrieval-probes.jsonl', retrievalProbes));
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/forecast-variance-by-region.csv',
      ['region_id', 'region', 'product_id', 'product', 'forecast_units', 'actual_units', 'variance_pct', 'signal_affected_flag'],
      varianceRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/hero-demand-trend.csv',
      ['date', 'region_id', 'region', 'product_id', 'product', 'forecast_units', 'actual_units', 'signal_affected_flag'],
      trendRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/weather-anomaly-by-region.csv',
      [
        'region_id',
        'region',
        'variance_window_start',
        'variance_window_end',
        'mean_uv_index_anomaly',
        'mean_temperature_mean_anomaly_c',
        'signal_affected_flag',
        'model_id',
        'modelled_uplift_pct',
        'provenance',
        'source_label',
      ],
      weatherContext.anomalyRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/weather-forecast-outlook.csv',
      [
        'issue_date',
        'target_date',
        'lead_days',
        'region_id',
        'region',
        'uvIndex_p10',
        'uvIndex_p50',
        'uvIndex_p90',
        'temperatureMeanAnomalyC_p50',
        'uvIndexAnomaly_p50',
        'confidence',
        'provenance',
        'source_label',
      ],
      weatherContext.forecastOutlookRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/weather-demand-reconciliation.csv',
      [
        'region_id',
        'region',
        'model_id',
        'modelled_weather_uplift_pct',
        'actual_sales_variance_pct',
        'difference_pct',
        'signal_affected_flag',
        'provenance',
        'source_label',
      ],
      weatherContext.reconciliationRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/campaign-performance.csv',
      [
        'campaign_id',
        'campaign',
        'region_id',
        'region',
        'product_id',
        'product',
        'channel',
        'spend_usd',
        'attributed_units',
        'revenue_usd',
        'contribution_margin_pct',
        'signal_affected_flag',
      ],
      campaignRows,
    ),
  );
  results.push(
    await writeCsvRows(
      'lakehouse/dashboard/forecast-assumptions.csv',
      ['assumption_id', 'forecast_version', 'statement', 'status', 'held_after_signal', 'invalidated_by_signal_id'],
      assumptionRows,
    ),
  );

  await writeJson('receipts/action-receipts.json', receipts);
  results.push({ file: 'receipts/action-receipts.json', rows: receipts.length });
  await writeJson('evaluation/questions.json', evaluationQuestions);
  results.push({ file: 'evaluation/questions.json', rows: evaluationQuestions.length });
  await writeJson('evaluation/expected-results.json', expectedResults);
  results.push({ file: 'evaluation/expected-results.json', rows: expectedResults.demos.length });

  return results;
}
