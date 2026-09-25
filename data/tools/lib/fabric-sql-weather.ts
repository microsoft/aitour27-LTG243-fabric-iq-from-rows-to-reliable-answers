import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DATA_ROOT,
  asOfDate,
  includeOutcomeSlice,
  clamp,
  eachDate,
  isObservable,
  loadScenario,
  logResults,
  openCsv,
  parseDate,
  round,
  toDateString,
} from './core.ts';
import type { CsvValue, GenerationResult } from './core.ts';

type ScenarioRecord = Record<string, any>;
type CsvRow = Record<string, CsvValue>;

type Observation = {
  observationDate: string;
  regionId: string;
  temperatureMeanC: number;
  uvIndex: number;
  temperatureMeanAnomalyC: number;
  uvIndexAnomaly: number;
  seaSurfaceAnomalyC: number | null;
};

const MS_PER_DAY = 86_400_000;
const NORMAL_TOLERANCE = 0.05;
const NORMAL_YEAR_LENGTH_DAYS = 365;

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

function isMissingFileError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await access(join(DATA_ROOT, relativePath));
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  assertCondition(!quoted, `Unclosed quoted field in CSV line: ${line}`);
  return values;
}

function parseCsv(raw: string, relativePath: string): Record<string, string>[] {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerLine = lines.shift();
  assertCondition(headerLine !== undefined && headerLine.length > 0, `CSV file is empty: ${relativePath}`);
  const headers = parseCsvLine(headerLine);
  return lines
    .filter((line) => line.length > 0)
    .map((line, lineIndex) => {
      const values = parseCsvLine(line);
      assertCondition(
        values.length === headers.length,
        `CSV column count mismatch in ${relativePath} line ${lineIndex + 2}: expected ${headers.length}, got ${values.length}`,
      );
      return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
}

async function readCsv(relativePath: string): Promise<Record<string, string>[]> {
  const fullPath = join(DATA_ROOT, relativePath);
  try {
    return parseCsv(await readFile(fullPath, 'utf8'), relativePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Required upstream weather file is missing: data/${relativePath}`);
    }
    throw error;
  }
}

async function readOptionalCsv(relativePath: string): Promise<Record<string, string>[] | null> {
  if (!(await fileExists(relativePath))) return null;
  return parseCsv(await readFile(join(DATA_ROOT, relativePath), 'utf8'), relativePath);
}

function field(row: Record<string, string>, column: string, fileName: string): string {
  const value = row[column];
  assertCondition(value !== undefined && value !== '', `Missing ${fileName}.${column}`);
  return value;
}

function firstField(row: Record<string, string>, columns: string[]): string | undefined {
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function numberField(row: Record<string, string>, column: string, fileName: string): number {
  const value = Number(field(row, column, fileName));
  assertCondition(Number.isFinite(value), `Invalid number in ${fileName}.${column}`);
  return value;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  assertCondition(Number.isFinite(numberValue), `Invalid optional number: ${value}`);
  return numberValue;
}

function booleanFromValue(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  const normalised = String(value).trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  throw new Error(`Invalid boolean in ${label}: ${value}`);
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  return booleanFromValue(value, 'optional boolean');
}

function normaliseDate(value: string, label: string): string {
  const dateString = value.slice(0, 10);
  assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(dateString), `Invalid date in ${label}: ${value}`);
  return dateString;
}

function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const thisDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((thisDay - startOfYear) / MS_PER_DAY) + 1;
}

function seasonalNormal(mean: number, amplitude: number, peakDayOfYear: number, normalDayOfYear: number, yearLengthDays: number): number {
  return mean + amplitude * Math.cos((2 * Math.PI * (normalDayOfYear - peakDayOfYear)) / yearLengthDays);
}

function regionOrderMap(regions: ScenarioRecord[]): Map<string, number> {
  return new Map(regions.map((region, index) => [String(region.regionId), index]));
}

function sortByDateAndRegion<T extends { observationDate: string; regionId: string }>(
  rows: T[],
  regionOrder: Map<string, number>,
): T[] {
  return [...rows].sort(
    (a, b) =>
      a.observationDate.localeCompare(b.observationDate) ||
      (regionOrder.get(a.regionId) ?? Number.MAX_SAFE_INTEGER) - (regionOrder.get(b.regionId) ?? Number.MAX_SAFE_INTEGER) ||
      a.regionId.localeCompare(b.regionId),
  );
}

function daysBetween(startInclusive: string, endInclusive: string): number {
  return Math.round((parseDate(endInclusive).getTime() - parseDate(startInclusive).getTime()) / MS_PER_DAY) + 1;
}

function loadObservations(rows: Record<string, string>[]): Observation[] {
  return rows.map((row) => ({
    observationDate: normaliseDate(field(row, 'timestamp', 'WeatherObservationsDaily.csv'), 'WeatherObservationsDaily.csv.timestamp'),
    regionId: field(row, 'regionId', 'WeatherObservationsDaily.csv'),
    temperatureMeanC: numberField(row, 'temperatureMeanC', 'WeatherObservationsDaily.csv'),
    uvIndex: numberField(row, 'uvIndex', 'WeatherObservationsDaily.csv'),
    temperatureMeanAnomalyC: numberField(row, 'temperatureMeanAnomalyC', 'WeatherObservationsDaily.csv'),
    uvIndexAnomaly: numberField(row, 'uvIndexAnomaly', 'WeatherObservationsDaily.csv'),
    seaSurfaceAnomalyC: optionalNumber(row.seaSurfaceAnomalyC),
  }));
}

function validateObservationCoverage(scenario: ScenarioRecord, observations: Observation[], regions: ScenarioRecord[]): void {
  const weather = asRecord(scenario.weather, 'weather');
  const window = asRecord(weather.observationWindow, 'weather.observationWindow');
  const dailyStart = String(window.dailyStart);
  const dailyEnd = String(window.dailyEnd);
  const expectedEnd = includeOutcomeSlice() || dailyEnd <= asOfDate(scenario) ? dailyEnd : asOfDate(scenario);
  const regionIds = new Set(regions.map((region) => String(region.regionId)));
  const expectedDates = dailyStart <= expectedEnd ? eachDate(dailyStart, expectedEnd).map(toDateString) : [];
  const expectedRows = expectedDates.length * regionIds.size;
  assertCondition(
    observations.length === expectedRows,
    `WeatherObservationsDaily row count mismatch: expected ${expectedRows}, got ${observations.length}`,
  );

  const seen = new Set<string>();
  for (const observation of observations) {
    assertCondition(regionIds.has(observation.regionId), `Unknown WeatherObservationsDaily regionId: ${observation.regionId}`);
    assertCondition(
      observation.observationDate >= dailyStart && observation.observationDate <= dailyEnd && (includeOutcomeSlice() || isObservable(scenario, observation.observationDate)),
      `WeatherObservationsDaily date outside window: ${observation.observationDate}`,
    );
    const key = `${observation.regionId}|${observation.observationDate}`;
    assertCondition(!seen.has(key), `Duplicate WeatherObservationsDaily row: ${key}`);
    seen.add(key);
  }

  for (const dateString of expectedDates) {
    for (const regionId of regionIds) {
      const key = `${regionId}|${dateString}`;
      assertCondition(seen.has(key), `Missing WeatherObservationsDaily row: ${key}`);
    }
  }
}

function buildWeatherStationRows(scenario: ScenarioRecord, regionClimate: ScenarioRecord[]): CsvRow[] {
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  return regionClimate.map((climate) => {
    const baseSeaSurfaceTemperatureC = optionalNumber(climate.baseSeaSurfaceTemperatureC);
    return {
      stationId: climate.stationId,
      regionId: climate.regionId,
      stationName: climate.stationName,
      providerId: provider.providerId,
      annualMeanTempC: climate.annualMeanTempC,
      annualMeanUvIndex: climate.annualMeanUvIndex,
      annualMeanHumidityPct: climate.annualMeanHumidityPct,
      annualMeanPressureHpa: climate.annualMeanPressureHpa,
      baseSeaSurfaceTemperatureC,
      annualRainfallMm: climate.annualRainfallMm,
      isCoastal: baseSeaSurfaceTemperatureC !== null,
      provenance: provider.provenance,
    };
  });
}

function buildObservedNormalAnchors(observations: Observation[]): Map<string, { temperatureMeanNormalC: number; uvIndexNormal: number }> {
  const anchors = new Map<string, { temperatureSum: number; uvSum: number; count: number }>();
  for (const observation of observations) {
    const normalDayOfYear = dayOfYear(parseDate(observation.observationDate));
    const key = `${observation.regionId}|${normalDayOfYear}`;
    const current = anchors.get(key) ?? { temperatureSum: 0, uvSum: 0, count: 0 };
    // Anchor observed days to the upstream baseline actually used to publish the anomaly columns.
    current.temperatureSum += observation.temperatureMeanC - observation.temperatureMeanAnomalyC;
    current.uvSum += observation.uvIndex - observation.uvIndexAnomaly;
    current.count += 1;
    anchors.set(key, current);
  }
  return new Map(
    [...anchors.entries()].map(([key, value]) => [
      key,
      {
        temperatureMeanNormalC: round(value.temperatureSum / value.count, 3),
        uvIndexNormal: round(value.uvSum / value.count, 3),
      },
    ]),
  );
}

function buildClimateNormalRows(
  scenario: ScenarioRecord,
  regionClimate: ScenarioRecord[],
  observedNormalAnchors: Map<string, { temperatureMeanNormalC: number; uvIndexNormal: number }>,
): CsvRow[] {
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  const climatology = asRecord(scenario.weather?.climatology, 'weather.climatology');
  const rows: CsvRow[] = [];
  for (const climate of regionClimate) {
    for (let normalDayOfYear = 1; normalDayOfYear <= 366; normalDayOfYear++) {
      const anchor = observedNormalAnchors.get(`${climate.regionId}|${normalDayOfYear}`);
      const temperatureWave = Math.cos((2 * Math.PI * (normalDayOfYear - Number(climate.peakDayOfYear))) / NORMAL_YEAR_LENGTH_DAYS);
      const rainfallDailyMean = Number(climate.annualRainfallMm) / 365;
      const precipitationNormalMm = Math.max(0, rainfallDailyMean * (1 - 0.35 * temperatureWave));
      rows.push({
        regionId: climate.regionId,
        dayOfYear: normalDayOfYear,
        temperatureMeanNormalC:
          anchor?.temperatureMeanNormalC ??
          round(
            seasonalNormal(
              Number(climate.annualMeanTempC),
              Number(climate.seasonalAmplitudeC),
              Number(climate.peakDayOfYear),
              normalDayOfYear,
              NORMAL_YEAR_LENGTH_DAYS,
            ),
            3,
          ),
        uvIndexNormal:
          anchor?.uvIndexNormal ??
          round(
            seasonalNormal(
              Number(climate.annualMeanUvIndex),
              Number(climate.uvSeasonalAmplitude),
              Number(climate.peakDayOfYear),
              normalDayOfYear,
              NORMAL_YEAR_LENGTH_DAYS,
            ),
            3,
          ),
        humidityNormalPct: round(clamp(Number(climate.annualMeanHumidityPct) - 6 * temperatureWave, 35, 95), 2),
        precipitationNormalMm: round(precipitationNormalMm, 2),
        sunshineNormalHours: round(clamp(7.2 + 2.1 * temperatureWave - precipitationNormalMm * 0.18, 2, 12.5), 2),
        baselinePeriodStart: climatology.baselinePeriodStart,
        baselinePeriodEnd: climatology.baselinePeriodEnd,
        baselineLabel: climatology.baselineLabel,
        provenance: provider.provenance,
      });
    }
  }
  return rows;
}

function validateClimateNormalsAgainstObservations(observations: Observation[], climateNormalRows: CsvRow[]): void {
  const normalByRegionDay = new Map(climateNormalRows.map((row) => [`${row.regionId}|${row.dayOfYear}`, row]));
  let maxMismatch = 0;
  let worst = '';
  for (const observation of observations) {
    const normalDayOfYear = dayOfYear(parseDate(observation.observationDate));
    const normal = normalByRegionDay.get(`${observation.regionId}|${normalDayOfYear}`);
    assertCondition(Boolean(normal), `Missing climate normal for ${observation.regionId} day ${normalDayOfYear}`);
    const temperatureMismatch = Math.abs(
      observation.temperatureMeanC - Number(normal?.temperatureMeanNormalC) - observation.temperatureMeanAnomalyC,
    );
    const uvMismatch = Math.abs(observation.uvIndex - Number(normal?.uvIndexNormal) - observation.uvIndexAnomaly);
    const mismatch = Math.max(temperatureMismatch, uvMismatch);
    if (mismatch > maxMismatch) {
      maxMismatch = mismatch;
      worst = `${observation.regionId} ${observation.observationDate} tempMismatch=${round(temperatureMismatch, 4)} uvMismatch=${round(uvMismatch, 4)}`;
    }
  }
  assertCondition(
    maxMismatch <= NORMAL_TOLERANCE,
    `Climate normals do not reproduce upstream anomalies within ${NORMAL_TOLERANCE}; max mismatch ${round(maxMismatch, 4)} at ${worst}`,
  );
}

function buildWeatherEventRows(scenario: ScenarioRecord, rawRows: Record<string, string>[] | null): CsvRow[] {
  if (rawRows === null) {
    console.warn('WeatherEvents.csv missing; emitted empty fabric-sql/weather_events.csv with headers.');
    return [];
  }
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  const externalSignal = asRecord(scenario.externalSignal, 'externalSignal');
  const eventCatalogue = asArray(scenario.weather?.eventCatalogue, 'weather.eventCatalogue');
  const relevanceByType = new Map(
    eventCatalogue.map((eventType) => [String(eventType.eventType), booleanFromValue(eventType.relevantToHeroProduct, 'weather.eventCatalogue.relevantToHeroProduct')]),
  );

  return rawRows
    .map((row) => {
      const eventType = field(row, 'eventType', 'WeatherEvents.csv');
      const startDate = normaliseDate(
        firstField(row, ['startDate', 'eventStartDate', 'startTimestamp', 'timestamp']) ?? '',
        'WeatherEvents.csv.startDate',
      );
      const endDate = normaliseDate(firstField(row, ['endDate', 'eventEndDate', 'endTimestamp']) ?? startDate, 'WeatherEvents.csv.endDate');
      const duration = firstField(row, ['durationDays']);
      const relevantToHeroProduct = optionalBoolean(firstField(row, ['relevantToHeroProduct'])) ?? relevanceByType.get(eventType);
      assertCondition(relevantToHeroProduct !== undefined, `Unable to determine hero-product relevance for eventType ${eventType}`);
      return {
        eventId: field(row, 'eventId', 'WeatherEvents.csv'),
        eventType,
        regionId: field(row, 'regionId', 'WeatherEvents.csv'),
        severity: field(row, 'severity', 'WeatherEvents.csv'),
        startDate,
        endDate,
        durationDays: duration === undefined ? daysBetween(startDate, endDate) : Number(duration),
        peakValue: Number(firstField(row, ['peakValue']) ?? 0),
        peakMetric: firstField(row, ['peakMetric']) ?? eventType,
        signalId: firstField(row, ['signalId']) ?? externalSignal.signalId,
        relevantToHeroProduct,
        headline: firstField(row, ['headline', 'eventName', 'name']) ?? eventType,
        provenance: firstField(row, ['provenance']) ?? provider.provenance,
      };
    })
    .filter((row) => includeOutcomeSlice() || isObservable(scenario, String(row.startDate)))
    .sort(
      (a, b) =>
        String(a.startDate).localeCompare(String(b.startDate)) ||
        String(a.regionId).localeCompare(String(b.regionId)) ||
        String(a.eventId).localeCompare(String(b.eventId)),
    );
}

function buildDemandResponseRows(
  observations: Observation[],
  scenario: ScenarioRecord,
  regionOrder: Map<string, number>,
): CsvRow[] {
  const response = asRecord(scenario.weather?.demandResponse, 'weather.demandResponse');
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  const betaUv = Number(response.betaUv);
  const betaTempC = Number(response.betaTempC);
  assertCondition(Number.isFinite(betaUv), 'Invalid weather.demandResponse.betaUv');
  assertCondition(Number.isFinite(betaTempC), 'Invalid weather.demandResponse.betaTempC');

  return sortByDateAndRegion(observations, regionOrder).map((observation) => ({
    regionId: observation.regionId,
    observationDate: observation.observationDate,
    uvIndexAnomaly: round(observation.uvIndexAnomaly, 4),
    temperatureMeanAnomalyC: round(observation.temperatureMeanAnomalyC, 4),
    betaUv,
    betaTempC,
    modelledUpliftPct: round(betaUv * observation.uvIndexAnomaly + betaTempC * observation.temperatureMeanAnomalyC, 4),
    modelId: response.modelId,
    modelVersion: response.version,
    provenance: provider.provenance,
  }));
}

function validateDemandReconciliation(observations: Observation[], scenario: ScenarioRecord, regions: ScenarioRecord[]): void {
  const response = asRecord(scenario.weather?.demandResponse, 'weather.demandResponse');
  const betaUv = Number(response.betaUv);
  const betaTempC = Number(response.betaTempC);
  const tolerancePct = Number(response.tolerancePct);
  assertCondition(Number.isFinite(tolerancePct), 'Invalid weather.demandResponse.tolerancePct');
  const windowStart = String(scenario.clock?.varianceWindowStart);
  const windowEnd = String(scenario.clock?.varianceWindowEnd);

  for (const region of regions) {
    const regionId = String(region.regionId);
    const windowRows = observations.filter(
      (observation) =>
        observation.regionId === regionId &&
        observation.observationDate >= windowStart &&
        observation.observationDate <= windowEnd,
    );
    assertCondition(windowRows.length > 0, `No weather demand response rows in variance window for ${regionId}`);
    const meanUplift =
      windowRows.reduce(
        (sum, observation) => sum + betaUv * observation.uvIndexAnomaly + betaTempC * observation.temperatureMeanAnomalyC,
        0,
      ) / windowRows.length;
    const expectedVariancePct = Number(region.variancePct);
    const delta = Math.abs(meanUplift - expectedVariancePct);
    assertCondition(
      delta <= tolerancePct,
      `Weather demand reconciliation failed for ${regionId}: modelled mean uplift ${round(meanUplift, 4)} vs variancePct ${expectedVariancePct} (delta ${round(delta, 4)}, tolerance ${tolerancePct})`,
    );
  }
}

function buildElasticityParamRows(scenario: ScenarioRecord): CsvRow[] {
  const response = asRecord(scenario.weather?.demandResponse, 'weather.demandResponse');
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  return [
    {
      modelId: response.modelId,
      modelVersion: response.version,
      status: response.status,
      stewardRole: response.stewardRole,
      formula: response.formula,
      betaUv: response.betaUv,
      betaTempC: response.betaTempC,
      unitNote: response.unitNote,
      coefficientsAreGlobal: response.coefficientsAreGlobal,
      tolerancePct: response.tolerancePct,
      effectiveFrom: scenario.clock?.decisionDay,
      provenance: provider.provenance,
      sourceLabel: provider.sourceLabel,
    },
  ];
}

function validateProviderLineage(fileName: string, columns: string[], rows: CsvRow[], provider: ScenarioRecord): void {
  assertCondition(columns.includes('provenance'), `${fileName} must include provenance`);
  assertCondition(provider.provenance === 'external', `weather.provider.provenance must be external for ${fileName}`);
  for (const [index, row] of rows.entries()) {
    assertCondition(row.provenance === provider.provenance, `${fileName} row ${index + 1} provenance must be ${provider.provenance}`);
    if (columns.includes('sourceLabel')) {
      assertCondition(row.sourceLabel === provider.sourceLabel, `${fileName} row ${index + 1} sourceLabel must match weather.provider`);
    }
  }
}

async function writeWeatherTable(
  results: GenerationResult[],
  fileName: string,
  columns: string[],
  rows: CsvRow[],
  provider: ScenarioRecord,
): Promise<void> {
  validateProviderLineage(fileName, columns, rows, provider);
  const writer = await openCsv(`fabric-sql/${fileName}`, columns);
  for (const row of rows) await writer.writeRow(row);
  results.push({ file: `fabric-sql/${fileName}`, rows: await writer.close() });
}

export async function generateFabricSqlWeather(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const results: GenerationResult[] = [];
  const regions = asArray(scenario.regions, 'regions');
  const regionClimate = asArray(scenario.weather?.regionClimate, 'weather.regionClimate');
  const provider = asRecord(scenario.weather?.provider, 'weather.provider');
  const regionOrder = regionOrderMap(regions);

  const observations = loadObservations(await readCsv('eventhouse/WeatherObservationsDaily.csv'));
  validateObservationCoverage(scenario, observations, regions);
  const climateNormalRows = buildClimateNormalRows(scenario, regionClimate, buildObservedNormalAnchors(observations));
  validateClimateNormalsAgainstObservations(observations, climateNormalRows);
  validateDemandReconciliation(observations, scenario, regions);

  const eventRows = buildWeatherEventRows(scenario, await readOptionalCsv('eventhouse/WeatherEvents.csv'));

  await writeWeatherTable(results, 'weather_stations.csv', [
    'stationId',
    'regionId',
    'stationName',
    'providerId',
    'annualMeanTempC',
    'annualMeanUvIndex',
    'annualMeanHumidityPct',
    'annualMeanPressureHpa',
    'baseSeaSurfaceTemperatureC',
    'annualRainfallMm',
    'isCoastal',
    'provenance',
  ], buildWeatherStationRows(scenario, regionClimate), provider);

  await writeWeatherTable(results, 'climate_normals.csv', [
    'regionId',
    'dayOfYear',
    'temperatureMeanNormalC',
    'uvIndexNormal',
    'humidityNormalPct',
    'precipitationNormalMm',
    'sunshineNormalHours',
    'baselinePeriodStart',
    'baselinePeriodEnd',
    'baselineLabel',
    'provenance',
  ], climateNormalRows, provider);

  await writeWeatherTable(results, 'weather_events.csv', [
    'eventId',
    'eventType',
    'regionId',
    'severity',
    'startDate',
    'endDate',
    'durationDays',
    'peakValue',
    'peakMetric',
    'signalId',
    'relevantToHeroProduct',
    'headline',
    'provenance',
  ], eventRows, provider);

  await writeWeatherTable(results, 'weather_elasticity_params.csv', [
    'modelId',
    'modelVersion',
    'status',
    'stewardRole',
    'formula',
    'betaUv',
    'betaTempC',
    'unitNote',
    'coefficientsAreGlobal',
    'tolerancePct',
    'effectiveFrom',
    'provenance',
    'sourceLabel',
  ], buildElasticityParamRows(scenario), provider);

  await writeWeatherTable(results, 'weather_demand_response.csv', [
    'regionId',
    'observationDate',
    'uvIndexAnomaly',
    'temperatureMeanAnomalyC',
    'betaUv',
    'betaTempC',
    'modelledUpliftPct',
    'modelId',
    'modelVersion',
    'provenance',
  ], buildDemandResponseRows(observations, scenario, regionOrder), provider);

  logResults('Fabric SQL Weather', results);
  return results;
}
