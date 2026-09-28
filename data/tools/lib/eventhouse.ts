// Deterministic Eventhouse CSV generator for the Caldova KQL scenario.
// Runs directly on Node.js 24+ via native TypeScript type stripping.

import {
  DATA_ROOT,
  addDays,
  addMinutes,
  allocateIntegers,
  asOfDate,
  clamp,
  createRng,
  eachDate,
  includeOutcomeSlice,
  isOperatingDay,
  isObservable,
  loadScenario,
  logResults,
  openCsv,
  parseDate,
  round,
  toDateString,
  toIsoSeconds,
} from './core.ts';
import type { GenerationResult, Rng, Scenario } from './core.ts';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MINUTES_PER_DAY = 24 * 60;
const LINE_INTERVAL_MINUTES = 5;
const LINE_INTERVAL_HOURS = LINE_INTERVAL_MINUTES / 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const FORECAST_SNAPSHOT_HOURS = [0, 6, 12, 18];

/**
 * Share of a region's baseline demand credited to its campaign while the
 * campaign is running. The rest is organic and other channels.
 *
 * Held below 1 deliberately. At full attribution the two control regions would
 * be credited with more units than they actually sold — REG-NORTH sells 134,874
 * hero units over the observed plan window against a baseline of 138,600 — which
 * is incoherent. 0.6 leaves headroom in every region, including the controls,
 * and keeps the surplus above baseline available to the weather signal, which is
 * what the session's narrative attributes it to.
 */
const CAMPAIGN_ATTRIBUTION_SHARE = 0.6;

const SALES_COLUMNS = [
  'timestamp',
  'regionId',
  'productId',
  'channel',
  'units',
  'revenueUsd',
  'orderCount',
];

const FORECAST_COLUMNS = [
  'timestamp',
  'regionId',
  'productId',
  'forecastUnits',
  'actualUnits',
  'variancePct',
  'forecastVersion',
  'signalAffected',
];

const CAMPAIGN_COLUMNS = [
  'timestamp',
  'campaignId',
  'regionId',
  'productId',
  'impressions',
  'engagements',
  'spendUsd',
  'attributedUnits',
  'revenueUsd',
  'contributionMarginPct',
];

const LINE_COLUMNS = [
  'timestamp',
  'lineId',
  'plantId',
  'productionOrderId',
  'ratedRateUnitsPerMin',
  'actualRateUnitsPerMin',
  'rateFactor',
  'utilisation',
  'producing',
  'state',
  'cumulativeStressIndex',
];

const CLIMATE_COLUMNS = [
  'timestamp',
  'signalId',
  'regionId',
  'seaSurfaceAnomalyC',
  'uvIndex',
  'anomalyVsBaselineC',
  'provenance',
];

const INVENTORY_COLUMNS = [
  'timestamp',
  'regionId',
  'productId',
  'availableUnits',
  'reservedUnits',
  'coverageDays',
];

const PLAN_STATE_COLUMNS = [
  'timestamp',
  'entityType',
  'entityId',
  'fromState',
  'toState',
  'actorRole',
  'caseId',
];

type Product = {
  productId: string;
  category: string;
  handlingClass: string;
  unitPriceUsd: number;
  hero?: boolean;
};

type Region = {
  regionId: string;
  signalAffected: boolean;
  baselineForecastUnits30d: number;
  variancePct: number;
  incrementalUnits: number;
};

type Campaign = {
  campaignId: string;
  regionId: string;
  channel: string;
  baseBudgetUsd: number;
  incrementalBudgetUsd: number;
};

type ProductionLine = {
  lineId: string;
  plantId: string;
  family: string;
  ratedRateUnitsPerMin: number;
  scheduledHoursPerDay: number;
  baselineUtilisation: number;
  preferredForHeroProduct?: boolean;
};

type PlanOption = {
  optionId: string;
  requiredRateFactor: number;
  requiredUtilisation: number;
  appliesFrom: string;
  appliesTo: string;
  requiredApproverRole: string;
};

type ScenarioAction = {
  type: string;
  requestedAt: string;
  approvedAt: string;
  executedAt: string;
  approvedByRole: string;
  details: {
    commitmentId?: string;
    maintenanceWindowId?: string;
    optionId?: string;
    lineId?: string;
  };
};

type ProductionOrder = {
  productionOrderId: string;
  lineId: string;
  productId: string;
  plannedStartDate: string;
  plannedEndDate: string;
};

type ProductionOrderLookup = {
  ids: Set<string>;
  byLineDate: Map<string, Map<string, ProductionOrder[]>>;
};

type WeatherDailyObservation = {
  dateKey: string;
  regionId: string;
  uvIndexText: string;
  uvIndex: number;
  seaSurfaceAnomalyC: number;
};

type DailyPlan = {
  date: Date;
  dateKey: string;
  dayIndex: number;
  region: Region;
  regionIndex: number;
  product: Product;
  productIndex: number;
  forecastUnits: number;
  actualUnits: number;
};

type Context = {
  scenario: Scenario;
  dates: Date[];
  regions: Region[];
  products: Product[];
  campaigns: Campaign[];
  lines: ProductionLine[];
  operatingDays: number[];
  heroProduct: Product;
  campaignByRegion: Map<string, Campaign>;
  productById: Map<string, Product>;
  regionById: Map<string, Region>;
  campaignIds: Set<string>;
  lineIds: Set<string>;
  historyEnd: string;
  outcomeSlice: boolean;
};

type Checks = {
  salesHeroActualByRegion: Map<string, number>;
  stressAtDeferredStart: number | null;
  firstStressThresholdCrossing: Date | null;
  maintenanceRowsInDeferredWindow: number;
  maintenanceRowsOutsideDeferredWindow: number;
  climateAffectedAnomalySum: number;
  climateAffectedRows: number;
  climateUnaffectedAnomalySum: number;
  climateUnaffectedRows: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireArray<T>(value: unknown, name: string): T[] {
  assert(Array.isArray(value), `${name} must be an array in scenario.json`);
  return value as T[];
}

function indexById<T extends Record<string, unknown>>(items: T[], idKey: keyof T, label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = item[idKey];
    assert(typeof id === 'string' && id.length > 0, `${label} contains an invalid id`);
    assert(!map.has(id), `${label} contains duplicate id ${id}`);
    map.set(id, item);
  }
  return map;
}

function assertKnownId(id: string, ids: Set<string>, label: string): void {
  assert(ids.has(id), `${label} '${id}' is not defined in scenario.json`);
}

function recommendedOption(context: Context): PlanOption {
  const option = requireArray<PlanOption>(context.scenario.options, 'options').find(
    (candidate) => candidate.optionId === context.scenario.recommendedOptionId,
  );
  assert(option, `recommendedOptionId '${context.scenario.recommendedOptionId}' is not defined in options`);
  return option;
}

function scenarioActionByDetail(context: Context, label: string, predicate: (action: ScenarioAction) => boolean): ScenarioAction {
  const action = requireArray<ScenarioAction>(context.scenario.actions, 'actions').find(predicate);
  assert(action, `Scenario action for ${label} is missing`);
  return action;
}

function demandPlannerRole(context: Context): string {
  const role = requireArray<string>(context.scenario.approverRoles, 'approverRoles').find((candidate) =>
    candidate.endsWith('DEMAND-PLANNER'),
  );
  assert(role, 'Demand planner role is missing from scenario.approverRoles');
  return role;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function csvColumnIndex(header: string[], column: string): number {
  const index = header.indexOf(column);
  assert(index >= 0, `production_orders.csv is missing required column '${column}'`);
  return index;
}

function weatherCsvColumnIndex(header: string[], column: string): number {
  const index = header.indexOf(column);
  assert(index >= 0, `WeatherObservationsDaily.csv is missing required column '${column}'`);
  return index;
}

async function loadProductionOrderLookup(context: Context): Promise<ProductionOrderLookup> {
  const file = join(DATA_ROOT, 'fabric-sql', 'production_orders.csv');
  const ids = new Set<string>();
  const byLineDate = new Map<string, Map<string, ProductionOrder[]>>();
  const productIds = new Set(context.productById.keys());
  const stream = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let idIndex = -1;
  let lineIndex = -1;
  let productIndex = -1;
  let startIndex = -1;
  let endIndex = -1;

  for await (const line of stream) {
    if (line.length === 0) continue;
    if (header === null) {
      header = parseCsvLine(line);
      idIndex = csvColumnIndex(header, 'productionOrderId');
      lineIndex = csvColumnIndex(header, 'lineId');
      productIndex = csvColumnIndex(header, 'productId');
      startIndex = csvColumnIndex(header, 'plannedStartDate');
      endIndex = csvColumnIndex(header, 'plannedEndDate');
      continue;
    }

    const values = parseCsvLine(line);
    const order: ProductionOrder = {
      productionOrderId: values[idIndex] ?? '',
      lineId: values[lineIndex] ?? '',
      productId: values[productIndex] ?? '',
      plannedStartDate: values[startIndex] ?? '',
      plannedEndDate: values[endIndex] ?? '',
    };
    assert(order.productionOrderId.length > 0, 'production_orders.csv contains an empty productionOrderId');
    assert(!ids.has(order.productionOrderId), `production_orders.csv contains duplicate id ${order.productionOrderId}`);
    assertKnownId(order.lineId, context.lineIds, 'production_orders.lineId');
    assertKnownId(order.productId, productIds, 'production_orders.productId');
    assert(order.plannedStartDate.length === 10, `Production order ${order.productionOrderId} has invalid plannedStartDate`);
    assert(order.plannedEndDate.length === 10, `Production order ${order.productionOrderId} has invalid plannedEndDate`);
    assert(order.plannedStartDate <= order.plannedEndDate, `Production order ${order.productionOrderId} has an inverted date range`);
    ids.add(order.productionOrderId);

    let lineMap = byLineDate.get(order.lineId);
    if (!lineMap) {
      lineMap = new Map<string, ProductionOrder[]>();
      byLineDate.set(order.lineId, lineMap);
    }
    for (const date of eachDate(order.plannedStartDate, order.plannedEndDate)) {
      const dateKey = toDateString(date);
      let dateOrders = lineMap.get(dateKey);
      if (!dateOrders) {
        dateOrders = [];
        lineMap.set(dateKey, dateOrders);
      }
      dateOrders.push(order);
    }
  }

  assert(header !== null, 'production_orders.csv is empty');
  assert(ids.size > 0, 'production_orders.csv contains no production orders');

  for (const lineMap of byLineDate.values()) {
    for (const orders of lineMap.values()) {
      orders.sort(
        (a, b) =>
          a.plannedStartDate.localeCompare(b.plannedStartDate) ||
          a.plannedEndDate.localeCompare(b.plannedEndDate) ||
          a.productionOrderId.localeCompare(b.productionOrderId),
      );
    }
  }

  return { ids, byLineDate };
}

async function loadWeatherDailyObservationLookup(context: Context): Promise<Map<string, WeatherDailyObservation>> {
  const file = join(DATA_ROOT, 'eventhouse', 'WeatherObservationsDaily.csv');
  const rows = new Map<string, WeatherDailyObservation>();
  const regionIds = new Set(context.regionById.keys());
  const stream = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let timestampIndex = -1;
  let regionIndex = -1;
  let uvIndex = -1;
  let seaSurfaceAnomalyIndex = -1;

  for await (const line of stream) {
    if (line.length === 0) continue;
    if (header === null) {
      header = parseCsvLine(line);
      timestampIndex = weatherCsvColumnIndex(header, 'timestamp');
      regionIndex = weatherCsvColumnIndex(header, 'regionId');
      uvIndex = weatherCsvColumnIndex(header, 'uvIndex');
      seaSurfaceAnomalyIndex = weatherCsvColumnIndex(header, 'seaSurfaceAnomalyC');
      continue;
    }

    const values = parseCsvLine(line);
    const timestamp = values[timestampIndex] ?? '';
    const regionId = values[regionIndex] ?? '';
    const uvIndexText = values[uvIndex] ?? '';
    const seaSurfaceAnomalyText = values[seaSurfaceAnomalyIndex] ?? '';
    const numericUvIndex = Number(uvIndexText);
    const seaSurfaceAnomalyC = seaSurfaceAnomalyText === '' ? 0 : Number(seaSurfaceAnomalyText);
    assert(timestamp.length >= 10, 'WeatherObservationsDaily.csv contains an invalid timestamp');
    assertKnownId(regionId, regionIds, 'WeatherObservationsDaily.regionId');
    assert(Number.isFinite(numericUvIndex), `WeatherObservationsDaily.csv contains invalid uvIndex '${uvIndexText}'`);
    assert(Number.isFinite(seaSurfaceAnomalyC), `WeatherObservationsDaily.csv contains invalid seaSurfaceAnomalyC '${seaSurfaceAnomalyText}'`);
    const dateKey = timestamp.slice(0, 10);
    const key = `${regionId}|${dateKey}`;
    assert(!rows.has(key), `WeatherObservationsDaily.csv contains duplicate row for ${key}`);
    rows.set(key, {
      dateKey,
      regionId,
      uvIndexText,
      uvIndex: numericUvIndex,
      seaSurfaceAnomalyC,
    });
  }

  assert(header !== null, 'WeatherObservationsDaily.csv is empty; run generateWeather before generateEventhouse');
  assert(rows.size > 0, 'WeatherObservationsDaily.csv contains no observations');
  return rows;
}

function isDateKeyBetween(dateKey: string, startInclusive: string, endInclusive: string): boolean {
  return dateKey >= startInclusive && dateKey <= endInclusive;
}

function requireDateKey(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.length >= 10, `${label} must be a date in scenario.json`);
  return value.slice(0, 10);
}

function authoredHistoryEnd(scenario: Scenario): string {
  return requireDateKey(
    scenario.weather?.forecast?.issueEnd ?? scenario.weather?.observationWindow?.dailyEnd ?? scenario.launchPlan?.endsOn ?? scenario.clock?.campaignEnd,
    'weather.forecast.issueEnd',
  );
}

function historyEndForScenario(scenario: Scenario, outcomeSlice: boolean): string {
  const historyEnd = outcomeSlice ? authoredHistoryEnd(scenario) : asOfDate(scenario);
  const salesHistoryStart = requireDateKey(scenario.clock?.salesHistoryStart, 'clock.salesHistoryStart');
  assert(salesHistoryStart <= historyEnd, `Eventhouse history end ${historyEnd} is before salesHistoryStart ${salesHistoryStart}`);
  return historyEnd;
}

function isObservedInHistory(context: Context, value: string): boolean {
  if (context.outcomeSlice) return value.slice(0, 10) <= context.historyEnd;
  return isObservable(context.scenario, value);
}

function observedDateRange(context: Context, startInclusive: string, endInclusive: string): Date[] {
  // The climate signal series tracks the advisory for as long as it persists, so
  // in the reveal it follows its own authored window rather than the telemetry
  // history end. Before the boundary it is truncated like any other observation.
  const boundedEnd = includeOutcomeSlice() || endInclusive <= context.historyEnd ? endInclusive : context.historyEnd;
  if (startInclusive > boundedEnd) return [];
  return eachDate(startInclusive, boundedEnd);
}

function countOperatingDaysBetween(startInclusive: string, endInclusive: string, operatingDays: number[]): number {
  if (startInclusive > endInclusive) return 0;
  return eachDate(startInclusive, endInclusive).filter((date) => isOperatingDay(date, operatingDays)).length;
}

function buildContext(scenario: Scenario): Context {
  const outcomeSlice = includeOutcomeSlice();
  const historyEnd = historyEndForScenario(scenario, outcomeSlice);
  const products = requireArray<Product>(scenario.products, 'products');
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const campaigns = requireArray<Campaign>(scenario.campaigns, 'campaigns');
  const lines = requireArray<ProductionLine>(scenario.productionLines, 'productionLines');
  const operatingDays = requireArray<number>(scenario.clock?.operatingDays, 'clock.operatingDays');
  const productById = indexById(products, 'productId', 'products');
  const regionById = indexById(regions, 'regionId', 'regions');
  const campaignById = indexById(campaigns, 'campaignId', 'campaigns');
  const lineById = indexById(lines, 'lineId', 'productionLines');
  const heroProduct = productById.get(String(scenario.heroProductId));
  assert(heroProduct, `heroProductId '${scenario.heroProductId}' is not defined in products`);

  const campaignByRegion = new Map<string, Campaign>();
  for (const campaign of campaigns) {
    assertKnownId(campaign.regionId, new Set(regionById.keys()), 'campaign.regionId');
    assert(!campaignByRegion.has(campaign.regionId), `Multiple campaigns defined for ${campaign.regionId}`);
    campaignByRegion.set(campaign.regionId, campaign);
  }

  for (const line of lines) {
    assert(typeof line.plantId === 'string' && line.plantId.length > 0, `Line ${line.lineId} has no plantId`);
  }

  assertKnownId(String(scenario.capacityModel?.lineId), new Set(lineById.keys()), 'capacityModel.lineId');
  assertKnownId(String(scenario.maintenance?.lineId), new Set(lineById.keys()), 'maintenance.lineId');
  assert(scenario.capacityModel.lineId === scenario.maintenance.lineId, 'capacityModel.lineId and maintenance.lineId diverge');
  assert(scenario.commitment.productId === scenario.heroProductId, 'commitment.productId must match heroProductId');

  return {
    scenario,
    dates: eachDate(String(scenario.clock.salesHistoryStart), historyEnd),
    regions,
    products,
    campaigns,
    lines,
    operatingDays,
    heroProduct,
    campaignByRegion,
    productById,
    regionById,
    campaignIds: new Set(campaignById.keys()),
    lineIds: new Set(lineById.keys()),
    historyEnd,
    outcomeSlice,
  };
}

function dayNumberSince(startDate: string, date: Date): number {
  const start = parseDate(startDate).getTime();
  return Math.round((date.getTime() - start) / 86_400_000);
}

function dailySeasonality(context: Context, date: Date, regionIndex: number, productIndex: number): number {
  const dayIndex = dayNumberSince(String(context.scenario.clock.salesHistoryStart), date);
  const seasonal = 1.0 + 0.18 * Math.sin((dayIndex / Math.max(1, context.dates.length - 1)) * Math.PI - 0.35);
  const weekday = isOperatingDay(date, context.operatingDays) ? 1.04 : 0.78;
  const regional = 0.96 + regionIndex * 0.018;
  const product = 1.02 - productIndex * 0.012;
  return clamp(seasonal * weekday * regional * product, 0.55, 1.45);
}

function productDemandFactor(product: Product, heroProductId: string, productIndex: number): number {
  if (product.productId === heroProductId) return 1;
  const categoryFactor = product.category === 'Sun Care' ? 0.42 : 0.27;
  const handlingFactor = product.handlingClass === 'controlled' ? 0.55 : 1;
  const priceFactor = clamp(8 / Math.max(1, product.unitPriceUsd), 0.58, 1.45);
  return round(clamp(categoryFactor * handlingFactor * priceFactor * (1 - productIndex * 0.035), 0.12, 0.58), 3);
}

function varianceWeights(context: Context, varianceDates: Date[], regionIndex: number, productIndex: number): number[] {
  return varianceDates.map((date, index) => dailySeasonality(context, date, regionIndex, productIndex) * (1 + index * 0.002));
}

function buildDailyPlans(context: Context): DailyPlan[] {
  const varianceDates = context.dates.filter((date) =>
    isDateKeyBetween(
      toDateString(date),
      String(context.scenario.clock.varianceWindowStart),
      String(context.scenario.clock.varianceWindowEnd),
    ),
  );
  const heroVarianceParts = new Map<string, { forecast: Map<string, number>; actual: Map<string, number> }>();
  const horizonDays = Number(context.scenario.forecast.horizonDays);

  for (const [regionIndex, region] of context.regions.entries()) {
    const forecastTotal = Math.round((region.baselineForecastUnits30d * varianceDates.length) / horizonDays);
    const actualTotal = Math.round(forecastTotal * (1 + region.variancePct / 100));
    const forecastParts = allocateIntegers(forecastTotal, varianceWeights(context, varianceDates, regionIndex, 0));
    const actualParts = allocateIntegers(
      actualTotal,
      varianceWeights(context, varianceDates, regionIndex, 0).map((weight, index) => weight * (1 + index * 0.0015)),
    );
    const forecast = new Map<string, number>();
    const actual = new Map<string, number>();
    for (const [index, date] of varianceDates.entries()) {
      const dateKey = toDateString(date);
      forecast.set(dateKey, forecastParts[index]);
      actual.set(dateKey, actualParts[index]);
    }
    heroVarianceParts.set(region.regionId, { forecast, actual });
  }

  const plans: DailyPlan[] = [];
  for (const [dayIndex, date] of context.dates.entries()) {
    const dateKey = toDateString(date);
    for (const [regionIndex, region] of context.regions.entries()) {
      for (const [productIndex, product] of context.products.entries()) {
        let forecastUnits: number;
        let actualUnits: number;
        if (
          product.productId === context.heroProduct.productId &&
          isDateKeyBetween(
            dateKey,
            String(context.scenario.clock.varianceWindowStart),
            String(context.scenario.clock.varianceWindowEnd),
          )
        ) {
          const parts = heroVarianceParts.get(region.regionId);
          assert(parts, `Missing variance allocation for ${region.regionId}`);
          forecastUnits = parts.forecast.get(dateKey) ?? 0;
          actualUnits = parts.actual.get(dateKey) ?? 0;
        } else {
          const baseDailyHeroForecast = region.baselineForecastUnits30d / horizonDays;
          const productFactor = productDemandFactor(product, context.heroProduct.productId, productIndex);
          forecastUnits = Math.max(
            1,
            Math.round(baseDailyHeroForecast * productFactor * dailySeasonality(context, date, regionIndex, productIndex)),
          );
          const signalLift =
            product.productId === context.heroProduct.productId &&
            region.signalAffected &&
            dateKey >= String(context.scenario.externalSignal.observationPeriodStart)
              ? clamp(region.variancePct / 100, 0.05, 0.34) * 0.45
              : 0;
          const campaignLift =
            product.productId === context.heroProduct.productId &&
            region.signalAffected &&
            isDateKeyBetween(dateKey, String(context.scenario.clock.campaignStart), String(context.scenario.clock.campaignEnd))
              ? 0.08
              : 0;
          const patternedNoise = Math.sin(dayIndex * 0.37 + regionIndex * 0.91 + productIndex * 1.7) * 0.025;
          actualUnits = Math.max(1, Math.round(forecastUnits * (1 + signalLift + campaignLift + patternedNoise)));
        }
        plans.push({
          date,
          dateKey,
          dayIndex,
          region,
          regionIndex,
          product,
          productIndex,
          forecastUnits,
          actualUnits,
        });
      }
    }
  }
  return plans;
}

function hourlySalesWeights(rng: Rng, hour: number, regionIndex: number, productIndex: number): number {
  const morningPeak = Math.exp(-((hour - 10) ** 2) / 20);
  const eveningPeak = Math.exp(-((hour - 18) ** 2) / 18);
  const nightPenalty = hour < 6 ? 0.35 : 1;
  const regionalShift = 1 + ((regionIndex % 3) - 1) * 0.025;
  const productShift = 1 + ((productIndex % 4) - 1.5) * 0.018;
  return Math.max(0.05, (0.45 + morningPeak + eveningPeak) * nightPenalty * regionalShift * productShift + rng.float(0, 0.08));
}

function channelForHour(context: Context, regionId: string, hour: number): string {
  const campaign = context.campaignByRegion.get(regionId);
  if (campaign && hour >= 9 && hour <= 20 && hour % 3 === 0) return campaign.channel;
  if (hour >= 7 && hour <= 21) return hour % 4 === 0 ? 'digital' : 'retail';
  return 'online';
}

async function generateSalesObservations(context: Context, plans: DailyPlan[], checks: Checks): Promise<GenerationResult> {
  const rng = createRng('eventhouse:sales-observations');
  const writer = await openCsv('eventhouse/SalesObservations.csv', SALES_COLUMNS);
  const productIds = new Set(context.productById.keys());
  const regionIds = new Set(context.regionById.keys());

  for (const plan of plans) {
    assertKnownId(plan.region.regionId, regionIds, 'SalesObservations.regionId');
    assertKnownId(plan.product.productId, productIds, 'SalesObservations.productId');
    const hourlyUnits = allocateIntegers(
      plan.actualUnits,
      HOURS.map((hour) => hourlySalesWeights(rng, hour, plan.regionIndex, plan.productIndex)),
    );
    for (const hour of HOURS) {
      const units = hourlyUnits[hour];
      if (
        plan.product.productId === context.heroProduct.productId &&
        isDateKeyBetween(
          plan.dateKey,
          String(context.scenario.clock.varianceWindowStart),
          String(context.scenario.clock.varianceWindowEnd),
        )
      ) {
        checks.salesHeroActualByRegion.set(
          plan.region.regionId,
          (checks.salesHeroActualByRegion.get(plan.region.regionId) ?? 0) + units,
        );
      }
      const timestamp = toIsoSeconds(addMinutes(plan.date, hour * 60));
      const averageBasketUnits = 2.8 + rng.float(0, 2.4);
      await writer.writeRow({
        timestamp,
        regionId: plan.region.regionId,
        productId: plan.product.productId,
        channel: channelForHour(context, plan.region.regionId, hour),
        units,
        revenueUsd: round(units * plan.product.unitPriceUsd, 2),
        orderCount: units === 0 ? 0 : Math.max(1, Math.round(units / averageBasketUnits)),
      });
    }
  }

  const rows = await writer.close();
  return { file: 'eventhouse/SalesObservations.csv', rows };
}

function adjustedForecastUnits(context: Context, rng: Rng, plan: DailyPlan, snapshotHour: number): number {
  if (snapshotHour === 0) return plan.forecastUnits;
  const dateKey = plan.dateKey;
  const revisedForecastDate = String(context.scenario.forecast.revisedForecastDate);
  const isHero = plan.product.productId === context.heroProduct.productId;
  const isAfterRevision = dateKey >= revisedForecastDate;
  const baseRipple = Math.sin(plan.dayIndex * 0.21 + plan.regionIndex + snapshotHour) * 0.009 + rng.normal(0, 0.002);

  if (isHero && isAfterRevision) {
    const blend = plan.region.signalAffected ? 0.82 : 0.35;
    const revised = plan.forecastUnits + (plan.actualUnits - plan.forecastUnits) * blend;
    return Math.max(1, Math.round(revised * (1 + baseRipple)));
  }

  return Math.max(1, Math.round(plan.forecastUnits * (1 + baseRipple)));
}

function forecastVersion(context: Context, snapshotHour: number): string {
  if (snapshotHour === 0) return String(context.scenario.forecast.baselineVersion);
  if (snapshotHour === 6) return `${context.scenario.forecast.baselineVersion}-snapshot-06`;
  if (snapshotHour === 12) return String(context.scenario.forecast.revisedVersion);
  return `${context.scenario.forecast.revisedVersion}-snapshot-18`;
}

async function generateForecastActualDaily(context: Context, plans: DailyPlan[]): Promise<GenerationResult> {
  const rng = createRng('eventhouse:forecast-actual-daily');
  const writer = await openCsv('eventhouse/ForecastActualDaily.csv', FORECAST_COLUMNS);
  const productIds = new Set(context.productById.keys());
  const regionIds = new Set(context.regionById.keys());

  for (const plan of plans) {
    assertKnownId(plan.region.regionId, regionIds, 'ForecastActualDaily.regionId');
    assertKnownId(plan.product.productId, productIds, 'ForecastActualDaily.productId');
    for (const snapshotHour of FORECAST_SNAPSHOT_HOURS) {
      const forecastUnits = adjustedForecastUnits(context, rng, plan, snapshotHour);
      const timestamp = toIsoSeconds(addMinutes(plan.date, snapshotHour * 60));
      await writer.writeRow({
        timestamp,
        regionId: plan.region.regionId,
        productId: plan.product.productId,
        forecastUnits,
        actualUnits: plan.actualUnits,
        variancePct: round(((plan.actualUnits - forecastUnits) / forecastUnits) * 100, 3),
        forecastVersion: forecastVersion(context, snapshotHour),
        signalAffected: plan.region.signalAffected,
      });
    }
  }

  const rows = await writer.close();
  return { file: 'eventhouse/ForecastActualDaily.csv', rows };
}

function activeCampaignDates(context: Context): Date[] {
  // Campaigns run on their launch plan's window, not on clock.campaignStart /
  // campaignEnd. Those two describe the *proposed* incremental campaign — the
  // decision the session is about — and are consumed by the capacity model.
  // Gating observed telemetry on them silently produced an all-zero fact table
  // whenever the proposed window fell entirely after the as-of boundary.
  //
  // Only days the dataset actually covers can carry activity, so a plan that
  // has not started by the as-of date still yields nothing.
  const emitted = new Set(context.dates.map((date) => toDateString(date)));
  return campaignPlanDates(context).filter((date) => emitted.has(toDateString(date)));
}

/** Every day of the launch plan, whether or not the dataset observes it. */
function campaignPlanDates(context: Context): Date[] {
  const launchPlan = context.scenario.launchPlan;
  assert(launchPlan, 'scenario.launchPlan is required to place campaign telemetry');
  return eachDate(String(launchPlan.startsOn), String(launchPlan.endsOn));
}

function campaignHourWeight(
  rng: Rng,
  activeIndex: number,
  activeHourCount: number,
  hour: number,
  campaignIndex: number,
  channel: string,
): number {
  const dayCurve = 1 + Math.sin((activeIndex / Math.max(1, activeHourCount)) * Math.PI) * 0.35;
  const hourCurve = hour >= 8 && hour <= 21 ? 1.2 : 0.55;
  const channelFactor = channel === 'field' ? 0.9 : channel === 'partner' ? 0.82 : 1.08;
  const campaignFactor = 1 + campaignIndex * 0.015;
  return Math.max(0.01, dayCurve * hourCurve * channelFactor * campaignFactor + rng.float(0, 0.05));
}

async function generateCampaignSignals(context: Context): Promise<GenerationResult> {
  const rng = createRng('eventhouse:campaign-signals');
  const writer = await openCsv('eventhouse/CampaignSignals.csv', CAMPAIGN_COLUMNS);
  const regionIds = new Set(context.regionById.keys());
  const productIds = new Set(context.productById.keys());
  // Budget and demand are apportioned across the whole launch plan, then only
  // the days the dataset observes are emitted. Allocating a full season across
  // the observed slice alone would overstate spend-to-date.
  const planDates = campaignPlanDates(context);
  const planIndexByDate = new Map(planDates.map((date, index) => [toDateString(date), index]));
  const observedPlanDays = context.dates.filter((date) => planIndexByDate.has(toDateString(date))).length;

  for (const [campaignIndex, campaign] of context.campaigns.entries()) {
    assertKnownId(campaign.campaignId, context.campaignIds, 'CampaignSignals.campaignId');
    assertKnownId(campaign.regionId, regionIds, 'CampaignSignals.regionId');
    assertKnownId(context.heroProduct.productId, productIds, 'CampaignSignals.productId');
    const region = context.regionById.get(campaign.regionId);
    assert(region, `Campaign ${campaign.campaignId} references missing region ${campaign.regionId}`);
    const weights: number[] = [];
    const planHourCount = planDates.length * HOURS.length;
    for (const [dateIndex] of planDates.entries()) {
      for (const hour of HOURS) {
        weights.push(campaignHourWeight(rng, dateIndex * 24 + hour, planHourCount, hour, campaignIndex, campaign.channel));
      }
    }
    // The incremental budget belongs to the campaign being decided, so it is
    // only spent in the outcome slice where that decision was approved.
    const totalBudgetUsd = campaign.baseBudgetUsd + (context.outcomeSlice ? campaign.incrementalBudgetUsd : 0);
    const spendCents = allocateIntegers(Math.round(totalBudgetUsd * 100), weights);
    const planDemandUnits = Math.round(
      (Number(region.baselineForecastUnits30d) * planDates.length) / 30 * CAMPAIGN_ATTRIBUTION_SHARE,
    );
    const attributedUnits = allocateIntegers(Math.max(0, planDemandUnits), weights);
    const impressions = allocateIntegers(
      Math.round(totalBudgetUsd * (campaign.channel === 'field' ? 18 : campaign.channel === 'partner' ? 30 : 48)),
      weights,
    );
    const engagements = allocateIntegers(
      Math.round(impressions.reduce((sum, value) => sum + value, 0) * (campaign.channel === 'field' ? 0.055 : 0.043)),
      weights,
    );

    let emittedHours = 0;
    for (const date of context.dates) {
      const dateKey = toDateString(date);
      const planIndex = planIndexByDate.get(dateKey);
      const active = planIndex !== undefined;
      for (const hour of HOURS) {
        const slot = active ? planIndex * HOURS.length + hour : -1;
        const units = active ? attributedUnits[slot] : 0;
        const revenueUsd = round(units * context.heroProduct.unitPriceUsd, 2);
        await writer.writeRow({
          timestamp: toIsoSeconds(addMinutes(date, hour * 60)),
          campaignId: campaign.campaignId,
          regionId: campaign.regionId,
          productId: context.heroProduct.productId,
          impressions: active ? impressions[slot] : 0,
          engagements: active ? engagements[slot] : 0,
          spendUsd: active ? round(spendCents[slot] / 100, 2) : 0,
          attributedUnits: units,
          revenueUsd,
          contributionMarginPct: revenueUsd > 0 ? round(49.5 + campaignIndex * 0.85 + rng.float(-0.3, 0.3), 3) : 0,
        });
        if (active) emittedHours += 1;
      }
    }
    assert(
      emittedHours === observedPlanDays * HOURS.length,
      `Campaign ${campaign.campaignId} emitted ${emittedHours} active hours, expected ${observedPlanDays * HOURS.length}`,
    );
  }

  const rows = await writer.close();
  return { file: 'eventhouse/CampaignSignals.csv', rows };
}

function shiftStartMinute(line: ProductionLine): number {
  return line.scheduledHoursPerDay >= 16 ? 6 * 60 : 8 * 60;
}

function isScheduledMinute(line: ProductionLine, minuteOfDay: number): boolean {
  const start = shiftStartMinute(line);
  return minuteOfDay >= start && minuteOfDay < start + line.scheduledHoursPerDay * 60;
}

function pkg02RateAndUtilisation(context: Context, dateKey: string): { rateFactor: number; utilisation: number } {
  const option = recommendedOption(context);
  if (isDateKeyBetween(dateKey, String(option.appliesFrom), String(option.appliesTo))) {
    return { rateFactor: Number(option.requiredRateFactor), utilisation: Number(option.requiredUtilisation) };
  }
  return {
    rateFactor: Number(context.scenario.capacityModel.baselineRateFactor),
    utilisation: Number(context.scenario.capacityModel.baselineUtilisation),
  };
}

function productionOrderIdFor(
  orders: ProductionOrderLookup,
  line: ProductionLine,
  dateKey: string,
  minuteOfDay: number,
  producing: boolean,
  state: string,
): string {
  if (!producing || state === 'maintenance') return '';
  const activeOrders = orders.byLineDate.get(line.lineId)?.get(dateKey) ?? [];
  if (activeOrders.length === 0) return '';
  const sampleIndex = Math.max(0, Math.floor((minuteOfDay - shiftStartMinute(line)) / LINE_INTERVAL_MINUTES));
  return activeOrders[sampleIndex % activeOrders.length].productionOrderId;
}

function initialStressForLine(context: Context, line: ProductionLine, baselineRateFactor: number): number {
  const beforeDataStart = toDateString(addDays(parseDate(String(context.scenario.clock.salesHistoryStart)), -1));
  const operatingDaysBeforeData = countOperatingDaysBetween(
    String(context.scenario.maintenance.lastMajorMaintenance),
    beforeDataStart,
    context.operatingDays,
  );
  const producingHours = line.scheduledHoursPerDay * line.baselineUtilisation;
  return round(operatingDaysBeforeData * producingHours * baselineRateFactor ** Number(context.scenario.stressModel.rateExponent), 6);
}

async function generateLineSignals(
  context: Context,
  productionOrders: ProductionOrderLookup,
  checks: Checks,
): Promise<GenerationResult> {
  const rng = createRng('eventhouse:line-signals');
  const writer = await openCsv('eventhouse/LineSignals.csv', LINE_COLUMNS);
  const cumulativeByLine = new Map<string, number>();
  const baselineRateFactorByLine = new Map<string, number>();
  const maintenanceLineId = String(context.scenario.maintenance.lineId);
  const deferredStart = String(context.scenario.maintenance.deferredStart);
  const deferredEnd = String(context.scenario.maintenance.deferredEnd);
  const threshold = Number(context.scenario.stressModel.thresholdStressIndex);
  const rateExponent = Number(context.scenario.stressModel.rateExponent);
  let resetAfterMaintenance = false;

  const operatingDaysToPlanStart = countOperatingDaysBetween(
    String(context.scenario.maintenance.lastMajorMaintenance),
    toDateString(addDays(parseDate(String(context.scenario.clock.campaignStart)), -1)),
    context.operatingDays,
  );
  assert(
    operatingDaysToPlanStart === Number(context.scenario.stressModel.operatingDaysLastMaintenanceToPlanStart),
    'Calculated operating days to plan start does not match scenario.stressModel',
  );
  assert(
    Math.abs(
      operatingDaysToPlanStart * Number(context.scenario.stressModel.baselineStressPerOperatingDay) -
        Number(context.scenario.stressModel.cumulativeAtPlanStart),
    ) <= 0.0001,
    'Calculated stress at plan start does not match scenario.stressModel',
  );

  for (const [lineIndex, line] of context.lines.entries()) {
    assertKnownId(line.lineId, context.lineIds, 'LineSignals.lineId');
    const baselineRateFactor =
      line.lineId === maintenanceLineId
        ? Number(context.scenario.capacityModel.baselineRateFactor)
        : round(clamp(0.965 + lineIndex * 0.011 + rng.normal(0, 0.006), 0.92, 1.04), 3);
    baselineRateFactorByLine.set(line.lineId, baselineRateFactor);
    cumulativeByLine.set(line.lineId, initialStressForLine(context, line, baselineRateFactor));
  }

  for (const date of context.dates) {
    const dateKey = toDateString(date);
    if (dateKey > deferredEnd && !resetAfterMaintenance) {
      cumulativeByLine.set(maintenanceLineId, 0);
      resetAfterMaintenance = true;
    }

    for (let minuteOfDay = 0; minuteOfDay < MINUTES_PER_DAY; minuteOfDay += LINE_INTERVAL_MINUTES) {
      const timestamp = addMinutes(date, minuteOfDay);
      for (const line of context.lines) {
        const isMaintenance =
          line.lineId === maintenanceLineId && isDateKeyBetween(dateKey, deferredStart, deferredEnd);
        const operating = isOperatingDay(date, context.operatingDays);
        const scheduled = operating && isScheduledMinute(line, minuteOfDay);
        const producing = scheduled && !isMaintenance;
        let state = producing ? 'producing' : operating ? 'idle' : 'off';
        let rateFactor = baselineRateFactorByLine.get(line.lineId) ?? 1;
        let utilisation = producing ? line.baselineUtilisation : 0;

        if (isMaintenance) {
          state = 'maintenance';
          rateFactor = 0;
          utilisation = 0;
        } else if (line.lineId === maintenanceLineId) {
          const plan = pkg02RateAndUtilisation(context, dateKey);
          rateFactor = producing ? plan.rateFactor : plan.rateFactor;
          utilisation = producing ? plan.utilisation : 0;
        }

        let cumulativeStressIndex = cumulativeByLine.get(line.lineId) ?? 0;
        if (producing) {
          cumulativeStressIndex += LINE_INTERVAL_HOURS * utilisation * rateFactor ** rateExponent;
          cumulativeByLine.set(line.lineId, cumulativeStressIndex);
        }

        if (line.lineId === maintenanceLineId) {
          if (state === 'maintenance') {
            if (isDateKeyBetween(dateKey, deferredStart, deferredEnd)) {
              checks.maintenanceRowsInDeferredWindow += 1;
            } else {
              checks.maintenanceRowsOutsideDeferredWindow += 1;
            }
          }
          if (checks.firstStressThresholdCrossing === null && cumulativeStressIndex >= threshold) {
            checks.firstStressThresholdCrossing = timestamp;
          }
          if (dateKey === deferredStart && minuteOfDay === 0) {
            checks.stressAtDeferredStart = cumulativeStressIndex;
          }
        }

        const productionOrderId = productionOrderIdFor(productionOrders, line, dateKey, minuteOfDay, producing, state);
        assert(
          productionOrderId === '' || productionOrders.ids.has(productionOrderId),
          `LineSignals emitted unknown productionOrderId '${productionOrderId}'`,
        );

        await writer.writeRow({
          timestamp: toIsoSeconds(timestamp),
          lineId: line.lineId,
          plantId: line.plantId,
          productionOrderId,
          ratedRateUnitsPerMin: round(line.ratedRateUnitsPerMin, 3),
          actualRateUnitsPerMin: producing ? round(line.ratedRateUnitsPerMin * rateFactor, 3) : 0,
          rateFactor: round(rateFactor, 3),
          utilisation: round(utilisation, 3),
          producing,
          state,
          cumulativeStressIndex: round(cumulativeStressIndex, 3),
        });
      }
    }
  }

  const rows = await writer.close();
  return { file: 'eventhouse/LineSignals.csv', rows };
}

async function generateClimateSignalObservations(context: Context, checks: Checks): Promise<GenerationResult> {
  const writer = await openCsv('eventhouse/ClimateSignalObservations.csv', CLIMATE_COLUMNS);
  const weatherDaily = await loadWeatherDailyObservationLookup(context);
  const regionIds = new Set(context.regionById.keys());
  const affectedRegionIds = new Set<string>(context.scenario.externalSignal.affectedRegionIds);
  const unaffectedRegionIds = new Set<string>(context.scenario.externalSignal.unaffectedRegionIds);
  const dates = observedDateRange(
    context,
    String(context.scenario.externalSignal.observationPeriodStart),
    String(context.scenario.externalSignal.persistenceThrough),
  );
  const provider = context.scenario.weather?.provider;
  assert(provider && typeof provider === 'object', 'weather.provider is required in scenario.json');
  assert(
    context.scenario.externalSignal.issuedBy === provider.providerId,
    `externalSignal.issuedBy ${context.scenario.externalSignal.issuedBy} does not match weather.provider.providerId ${provider.providerId}`,
  );
  const provenance = String(provider.provenance);
  assert(provenance.length > 0, 'weather.provider.provenance is required');
  let sharedWeatherRows = 0;

  for (const date of dates) {
    const dateKey = toDateString(date);
    for (const region of context.regions) {
      assertKnownId(region.regionId, regionIds, 'ClimateSignalObservations.regionId');
      assert(
        affectedRegionIds.has(region.regionId) || unaffectedRegionIds.has(region.regionId),
        `Region ${region.regionId} is not classified in externalSignal affected/unaffected sets`,
      );
      const affected = affectedRegionIds.has(region.regionId);
      const weatherRow = weatherDaily.get(`${region.regionId}|${dateKey}`);
      assert(weatherRow, `WeatherObservationsDaily.csv has no shared UV row for ${region.regionId} ${dateKey}`);
      const anomaly = weatherRow.seaSurfaceAnomalyC;
      const uvIndex = weatherRow.uvIndex;
      assert(uvIndex === Number(weatherRow.uvIndexText), `ClimateSignalObservations UV derivation failed for ${region.regionId} ${dateKey}`);
      sharedWeatherRows += 1;

      if (
        isDateKeyBetween(
          dateKey,
          String(context.scenario.clock.varianceWindowStart),
          String(context.scenario.clock.varianceWindowEnd),
        )
      ) {
        if (affected) {
          checks.climateAffectedAnomalySum += anomaly;
          checks.climateAffectedRows += 1;
        } else {
          checks.climateUnaffectedAnomalySum += anomaly;
          checks.climateUnaffectedRows += 1;
        }
      }

      await writer.writeRow({
        timestamp: toIsoSeconds(date),
        signalId: context.scenario.externalSignal.signalId,
        regionId: region.regionId,
        seaSurfaceAnomalyC: round(Number(context.scenario.externalSignal.seaSurfaceAnomalyC), 3),
        uvIndex: round(uvIndex, 3),
        anomalyVsBaselineC: round(anomaly, 3),
        provenance,
      });
    }
  }

  assert(
    sharedWeatherRows === dates.length * context.regions.length,
    `ClimateSignalObservations shared ${sharedWeatherRows} weather UV rows, expected ${dates.length * context.regions.length}`,
  );

  const rows = await writer.close();
  return { file: 'eventhouse/ClimateSignalObservations.csv', rows };
}

async function generateInventorySnapshots(context: Context, plans: DailyPlan[]): Promise<GenerationResult> {
  const rng = createRng('eventhouse:inventory-snapshots');
  const writer = await openCsv('eventhouse/InventorySnapshots.csv', INVENTORY_COLUMNS);
  const productIds = new Set(context.productById.keys());
  const regionIds = new Set(context.regionById.keys());

  for (const plan of plans) {
    assertKnownId(plan.region.regionId, regionIds, 'InventorySnapshots.regionId');
    assertKnownId(plan.product.productId, productIds, 'InventorySnapshots.productId');
    const isHeroCampaign =
      plan.product.productId === context.heroProduct.productId &&
      isDateKeyBetween(plan.dateKey, String(context.scenario.clock.campaignStart), String(context.scenario.clock.campaignEnd));
    const coverageTarget = isHeroCampaign && plan.region.signalAffected ? 18 + Math.sin(plan.dayIndex / 6) * 2.2 : 25 + Math.sin(plan.dayIndex / 9) * 3.0;
    const reservedUnits = Math.max(0, Math.round(plan.forecastUnits * (0.16 + rng.float(0, 0.08))));
    const netAvailableUnits = Math.max(0, Math.round(plan.forecastUnits * clamp(coverageTarget, 12, 35)));
    const availableUnits = netAvailableUnits + reservedUnits;
    await writer.writeRow({
      timestamp: toIsoSeconds(plan.date),
      regionId: plan.region.regionId,
      productId: plan.product.productId,
      availableUnits,
      reservedUnits,
      coverageDays: round(netAvailableUnits / Math.max(1, plan.forecastUnits), 3),
    });
  }

  const rows = await writer.close();
  return { file: 'eventhouse/InventorySnapshots.csv', rows };
}

function actorRoleForCaseState(context: Context, state: string): string {
  if (state === 'approved') return String(context.scenario.commitment.approvedByRole);
  if (state === 'executing') return String(recommendedOption(context).requiredApproverRole);
  if (state === 'resolved') {
    return String(
      scenarioActionByDetail(
        context,
        'maintenance deferral',
        (action) => action.details.maintenanceWindowId === context.scenario.maintenance.maintenanceWindowId,
      ).approvedByRole,
    );
  }
  return demandPlannerRole(context);
}

async function generatePlanStateTransitions(context: Context): Promise<GenerationResult> {
  createRng('eventhouse:plan-state-transitions');
  const writer = await openCsv('eventhouse/PlanStateTransitions.csv', PLAN_STATE_COLUMNS);
  const caseId = String(context.scenario.decisionCase.caseId);
  const states = requireArray<{ state: string; at: string }>(context.scenario.decisionCase.states, 'decisionCase.states');
  let fromState = 'none';

  for (const state of states) {
    if (!isObservedInHistory(context, state.at)) continue;
    await writer.writeRow({
      timestamp: toIsoSeconds(parseDate(state.at)),
      entityType: 'decision_case',
      entityId: caseId,
      fromState,
      toState: state.state,
      actorRole: actorRoleForCaseState(context, state.state),
      caseId,
    });
    fromState = state.state;
  }

  const option = recommendedOption(context);
  const campaignAction = scenarioActionByDetail(
    context,
    'campaign commitment',
    (action) => action.details.commitmentId === context.scenario.commitment.commitmentId,
  );
  const productionAction = scenarioActionByDetail(
    context,
    'production plan change',
    (action) => action.details.optionId === option.optionId,
  );
  const maintenanceAction = scenarioActionByDetail(
    context,
    'maintenance deferral',
    (action) => action.details.maintenanceWindowId === context.scenario.maintenance.maintenanceWindowId,
  );
  assert(productionAction.details.optionId, 'production_plan_change action is missing details.optionId');
  assert(productionAction.details.lineId, 'production_plan_change action is missing details.lineId');

  const rows = [
    {
      timestamp: campaignAction.requestedAt,
      entityType: 'campaign_commitment',
      entityId: context.scenario.commitment.commitmentId,
      fromState: 'draft',
      toState: 'requested',
      actorRole: demandPlannerRole(context),
    },
    {
      timestamp: campaignAction.approvedAt,
      entityType: 'campaign_commitment',
      entityId: context.scenario.commitment.commitmentId,
      fromState: 'requested',
      toState: 'approved',
      actorRole: campaignAction.approvedByRole,
    },
    {
      timestamp: campaignAction.executedAt,
      entityType: 'campaign_commitment',
      entityId: context.scenario.commitment.commitmentId,
      fromState: 'approved',
      toState: 'executed',
      actorRole: campaignAction.approvedByRole,
    },
    {
      timestamp: productionAction.requestedAt,
      entityType: 'production_plan',
      entityId: productionAction.details.optionId,
      fromState: 'draft',
      toState: 'requested',
      actorRole: productionAction.approvedByRole,
    },
    {
      timestamp: productionAction.approvedAt,
      entityType: 'production_plan',
      entityId: productionAction.details.optionId,
      fromState: 'requested',
      toState: 'approved',
      actorRole: productionAction.approvedByRole,
    },
    {
      timestamp: productionAction.executedAt,
      entityType: 'production_line',
      entityId: productionAction.details.lineId,
      fromState: 'baseline',
      toState: `${option.optionId.toLowerCase()}_committed`,
      actorRole: productionAction.approvedByRole,
    },
    {
      timestamp: `${context.scenario.clock.campaignStart}T06:00:00Z`,
      entityType: 'production_line',
      entityId: productionAction.details.lineId,
      fromState: 'baseline_run',
      toState: 'reduced_rate_high_utilisation',
      actorRole: productionAction.approvedByRole,
    },
    {
      timestamp: maintenanceAction.requestedAt,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'scheduled',
      toState: 'deferral_requested',
      actorRole: maintenanceAction.approvedByRole,
    },
    {
      timestamp: maintenanceAction.approvedAt,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'deferral_requested',
      toState: 'deferred',
      actorRole: maintenanceAction.approvedByRole,
    },
    {
      timestamp: maintenanceAction.executedAt,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'scheduled_dates_active',
      toState: 'deferred_dates_active',
      actorRole: maintenanceAction.approvedByRole,
    },
    {
      timestamp: `${context.scenario.maintenance.originalStart}T06:00:00Z`,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'original_window_due',
      toState: 'deferred_under_policy',
      actorRole: maintenanceAction.approvedByRole,
    },
    {
      timestamp: `${context.scenario.maintenance.deferredStart}T06:00:00Z`,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'deferred',
      toState: 'maintenance_started',
      actorRole: maintenanceAction.approvedByRole,
    },
    {
      timestamp: `${context.scenario.maintenance.deferredEnd}T16:00:00Z`,
      entityType: 'maintenance_window',
      entityId: context.scenario.maintenance.maintenanceWindowId,
      fromState: 'maintenance_started',
      toState: 'maintenance_completed',
      actorRole: maintenanceAction.approvedByRole,
    },
  ];

  rows.sort((a, b) => parseDate(a.timestamp).getTime() - parseDate(b.timestamp).getTime() || a.entityType.localeCompare(b.entityType));

  for (const row of rows) {
    if (!isObservedInHistory(context, row.timestamp)) continue;
    await writer.writeRow({
      timestamp: toIsoSeconds(parseDate(row.timestamp)),
      entityType: row.entityType,
      entityId: row.entityId,
      fromState: row.fromState,
      toState: row.toState,
      actorRole: row.actorRole,
      caseId,
    });
  }

  const writtenRows = await writer.close();
  return { file: 'eventhouse/PlanStateTransitions.csv', rows: writtenRows };
}

function assertHeroVariance(context: Context, plans: DailyPlan[], checks: Checks): void {
  const forecastByRegion = new Map<string, number>();
  for (const plan of plans) {
    if (
      plan.product.productId === context.heroProduct.productId &&
      isDateKeyBetween(
        plan.dateKey,
        String(context.scenario.clock.varianceWindowStart),
        String(context.scenario.clock.varianceWindowEnd),
      )
    ) {
      forecastByRegion.set(plan.region.regionId, (forecastByRegion.get(plan.region.regionId) ?? 0) + plan.forecastUnits);
    }
  }

  for (const region of context.regions) {
    const forecastUnits = forecastByRegion.get(region.regionId) ?? 0;
    const actualUnits = checks.salesHeroActualByRegion.get(region.regionId) ?? 0;
    assert(forecastUnits > 0, `No hero forecast units generated for ${region.regionId}`);
    assert(actualUnits > 0, `No hero actual units generated for ${region.regionId}`);
    const variancePct = ((actualUnits - forecastUnits) / forecastUnits) * 100;
    assert(
      Math.abs(variancePct - region.variancePct) <= 0.15,
      `Hero variance for ${region.regionId} was ${round(variancePct, 3)}%, expected ${region.variancePct}%`,
    );
  }
}

function assertStress(context: Context, checks: Checks): void {
  assert(checks.stressAtDeferredStart !== null, 'No PKG-02 stress sample found at deferred maintenance start');
  assert(checks.firstStressThresholdCrossing !== null, 'PKG-02 cumulative stress never crossed the policy threshold');
  assert(checks.maintenanceRowsInDeferredWindow > 0, 'No deferred-window maintenance rows were generated for PKG-02');
  assert(
    checks.maintenanceRowsOutsideDeferredWindow === 0,
    `Generated ${checks.maintenanceRowsOutsideDeferredWindow} maintenance rows outside the deferred window`,
  );
  const projected = Number(context.scenario.stressModel.projectedStressAtDeferredMaintenance);
  const threshold = Number(context.scenario.stressModel.thresholdStressIndex);
  const stressCeilingPct = Number(context.scenario.stressModel.stressCeilingPct);
  const stressPct = (checks.stressAtDeferredStart / threshold) * 100;
  assert(
    Math.abs(checks.stressAtDeferredStart - projected) <= 0.5,
    `PKG-02 stress at deferred maintenance was ${round(checks.stressAtDeferredStart, 3)}, expected ${projected}`,
  );
  assert(stressPct <= stressCeilingPct, `PKG-02 stress percentage ${round(stressPct, 2)}% exceeds ${stressCeilingPct}% ceiling`);
  assert(
    Math.abs(stressPct - Number(context.scenario.stressModel.projectedStressPctOfThreshold)) <= 0.1,
    `PKG-02 stress percentage ${round(stressPct, 2)}% does not match scenario projection`,
  );
  assert(
    checks.firstStressThresholdCrossing > parseDate(String(context.scenario.maintenance.originalStart)) &&
      checks.firstStressThresholdCrossing < parseDate(String(context.scenario.maintenance.deferredStart)),
    'PKG-02 threshold crossing did not occur after the original due date and before the deferred window',
  );
}

function assertClimateSeparation(context: Context, checks: Checks): void {
  assert(checks.climateAffectedRows > 0, 'No affected climate observations generated');
  assert(checks.climateUnaffectedRows > 0, 'No unaffected climate observations generated');
  const affectedAverage = checks.climateAffectedAnomalySum / checks.climateAffectedRows;
  const unaffectedAverage = checks.climateUnaffectedAnomalySum / checks.climateUnaffectedRows;
  const expected = Number(context.scenario.externalSignal.seaSurfaceAnomalyC);
  assert(
    Math.abs(affectedAverage - expected) <= 0.2,
    `Affected climate anomaly average ${round(affectedAverage, 3)}C is not near ${expected}C`,
  );
  assert(Math.abs(unaffectedAverage) <= 0.08, `Unaffected climate anomaly average ${round(unaffectedAverage, 3)}C is not near zero`);
  assert(
    affectedAverage - unaffectedAverage >= expected * 0.8,
    `Climate anomaly separation ${round(affectedAverage - unaffectedAverage, 3)}C is too small`,
  );
}

function createChecks(): Checks {
  return {
    salesHeroActualByRegion: new Map<string, number>(),
    stressAtDeferredStart: null,
    firstStressThresholdCrossing: null,
    maintenanceRowsInDeferredWindow: 0,
    maintenanceRowsOutsideDeferredWindow: 0,
    climateAffectedAnomalySum: 0,
    climateAffectedRows: 0,
    climateUnaffectedAnomalySum: 0,
    climateUnaffectedRows: 0,
  };
}

export async function generateEventhouse(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const context = buildContext(scenario);
  const checks = createChecks();
  const plans = buildDailyPlans(context);
  const productionOrders = await loadProductionOrderLookup(context);

  const results: GenerationResult[] = [];
  results.push(await generateSalesObservations(context, plans, checks));
  assertHeroVariance(context, plans, checks);
  results.push(await generateForecastActualDaily(context, plans));
  results.push(await generateCampaignSignals(context));
  results.push(await generateLineSignals(context, productionOrders, checks));
  if (context.outcomeSlice) assertStress(context, checks);
  results.push(await generateClimateSignalObservations(context, checks));
  assertClimateSeparation(context, checks);
  results.push(await generateInventorySnapshots(context, plans));
  results.push(await generatePlanStateTransitions(context));

  logResults('Eventhouse generated', results);
  return results;
}
