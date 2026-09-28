// Deterministic external weather feed for the Caldova launch scenario.
// Runs directly on Node.js 24+ via native TypeScript type stripping.

import {
  DATA_ROOT,
  addDays,
  addMinutes,
  asOfDate,
  clamp,
  createRng,
  eachDate,
  includeOutcomeSlice,
  isObservable,
  loadScenario,
  logResults,
  openCsv,
  parseDate,
  round,
  toDateString,
  toIsoSeconds,
} from './core.ts';
import type { CsvValue, GenerationResult, Scenario } from './core.ts';

const MS_PER_DAY = 86_400_000;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const DAILY_COLUMNS = [
  'timestamp',
  'regionId',
  'stationId',
  'temperatureMinC',
  'temperatureMaxC',
  'temperatureMeanC',
  'feelsLikeC',
  'heatIndexC',
  'uvIndex',
  'uvAlertLevel',
  'humidityPct',
  'precipitationMm',
  'rainDay',
  'cloudCoverPct',
  'sunshineHours',
  'windSpeedKph',
  'seaSurfaceTemperatureC',
  'pressureHpa',
  'temperatureMeanAnomalyC',
  'uvIndexAnomaly',
  'humidityAnomalyPct',
  'precipitationAnomalyMm',
  'sunshineAnomalyHours',
  'seaSurfaceAnomalyC',
  'provenance',
  'providerId',
];

const HOURLY_COLUMNS = [
  'timestamp',
  'regionId',
  'stationId',
  'temperatureC',
  'feelsLikeC',
  'uvIndex',
  'humidityPct',
  'precipitationMm',
  'cloudCoverPct',
  'windSpeedKph',
  'pressureHpa',
  'provenance',
];

const FORECAST_COLUMNS = [
  'issueTimestamp',
  'issueDate',
  'targetDate',
  'leadDays',
  'regionId',
  'providerId',
  'temperatureMeanC_p10',
  'temperatureMeanC_p50',
  'temperatureMeanC_p90',
  'uvIndex_p10',
  'uvIndex_p50',
  'uvIndex_p90',
  'temperatureMeanAnomalyC_p50',
  'uvIndexAnomaly_p50',
  'precipitationMm_p50',
  'confidence',
  'provenance',
];

const EVENT_COLUMNS = [
  'eventId',
  'eventType',
  'regionId',
  'severity',
  'startDate',
  'endDate',
  'peakValue',
  'peakMetric',
  'signalId',
  'relevantToHeroProduct',
  'headline',
  'provenance',
  'providerId',
];

type Region = {
  regionId: string;
  name: string;
  signalAffected: boolean;
  variancePct: number;
};

type RegionClimate = {
  regionId: string;
  stationId: string;
  stationName: string;
  annualMeanTempC: number;
  seasonalAmplitudeC: number;
  peakDayOfYear: number;
  annualMeanUvIndex: number;
  uvSeasonalAmplitude: number;
  annualMeanHumidityPct: number;
  annualMeanPressureHpa: number;
  baseSeaSurfaceTemperatureC: number | null;
  annualRainfallMm: number;
};

type RegionIntensity = {
  regionId: string;
  intensity: number;
  uvIndexAnomaly: number;
  temperatureMeanAnomalyC: number;
  targetUpliftPct: number;
};

type UvAlertLevel = {
  level: string;
  minUvIndex: number;
  maxUvIndexExclusive: number;
};

type WeatherEventCatalogueItem = {
  eventType: string;
  name: string;
  severityScale: string;
  relevantToHeroProduct: boolean;
};

export type DailyAnomalyRecord = {
  date: string;
  regionId: string;
  ramp: number;
  temperatureMeanAnomalyC: number;
  uvIndexAnomaly: number;
  humidityAnomalyPct: number;
  precipitationAnomalyMm: number;
  sunshineAnomalyHours: number;
  seaSurfaceAnomalyC: number | null;
};

export type WeatherDailyRecord = DailyAnomalyRecord & {
  timestamp: string;
  stationId: string;
  temperatureMinC: number;
  temperatureMaxC: number;
  temperatureMeanC: number;
  feelsLikeC: number;
  heatIndexC: number;
  uvIndex: number;
  uvAlertLevel: string;
  humidityPct: number;
  precipitationMm: number;
  rainDay: boolean;
  cloudCoverPct: number;
  sunshineHours: number;
  windSpeedKph: number;
  seaSurfaceTemperatureC: number | null;
  pressureHpa: number;
  temperatureNormalC: number;
  uvNormal: number;
};

type WeatherHourlyRecord = {
  timestamp: string;
  regionId: string;
  stationId: string;
  temperatureC: number;
  feelsLikeC: number;
  uvIndex: number;
  humidityPct: number;
  precipitationMm: number;
  cloudCoverPct: number;
  windSpeedKph: number;
  pressureHpa: number;
  provenance: string;
};

type WeatherForecastRecord = {
  issueTimestamp: string;
  issueDate: string;
  targetDate: string;
  leadDays: number;
  regionId: string;
  providerId: string;
  temperatureMeanC_p10: number;
  temperatureMeanC_p50: number;
  temperatureMeanC_p90: number;
  uvIndex_p10: number;
  uvIndex_p50: number;
  uvIndex_p90: number;
  temperatureMeanAnomalyC_p50: number;
  uvIndexAnomaly_p50: number;
  precipitationMm_p50: number;
  confidence: number;
  provenance: string;
};

type WeatherEventRecord = {
  eventId: string;
  eventType: string;
  regionId: string;
  severity: string;
  startDate: string;
  endDate: string;
  peakValue: number;
  peakMetric: string;
  signalId: string;
  relevantToHeroProduct: boolean;
  headline: string;
  provenance: string;
  providerId: string;
};

type ForecastDiagnostic = {
  leadDays: number;
  regionId: string;
  targetDate: string;
  issueDate: string;
  affected: boolean;
  tempAbsError: number;
  uvAbsError: number;
  uvAnomalyP50: number;
  normalUv: number;
  uvP10: number;
  uvP90: number;
};

let cachedAnomalySeries: DailyAnomalyRecord[] | null = null;
let cachedDailySeries: WeatherDailyRecord[] | null = null;

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

function dayDifference(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / MS_PER_DAY);
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function average(values: number[], label: string): number {
  assert(values.length > 0, `Cannot average empty ${label}`);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  assert(values.length > 0, 'Cannot calculate a percentile over an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

function seasonalCosine(annualMean: number, amplitude: number, peakDayOfYear: number, date: Date): number {
  return annualMean + amplitude * Math.cos((2 * Math.PI * (dayOfYear(date) - peakDayOfYear)) / 365);
}

function weatherConfig(scenario: Scenario): Record<string, any> {
  assert(scenario.weather && typeof scenario.weather === 'object', 'scenario.weather is missing');
  return scenario.weather as Record<string, any>;
}

function providerId(scenario: Scenario): string {
  const id = weatherConfig(scenario).provider?.providerId;
  assert(typeof id === 'string' && id.length > 0, 'scenario.weather.provider.providerId is missing');
  return id;
}

function providerProvenance(scenario: Scenario): string {
  const provenance = weatherConfig(scenario).provider?.provenance;
  assert(typeof provenance === 'string' && provenance.length > 0, 'scenario.weather.provider.provenance is missing');
  return provenance;
}

function maxForecastTargetDate(scenario: Scenario): Date {
  const forecast = weatherConfig(scenario).forecast;
  return addDays(parseDate(String(forecast.issueEnd)), Number(forecast.horizonDays));
}

function observedDates(scenario: Scenario, startInclusive: string, endInclusive: string): Date[] {
  // The outcome slice reveals what happened after the decision, so it runs to the
  // full authored window rather than stopping at the boundary.
  const end = includeOutcomeSlice() || endInclusive <= asOfDate(scenario) ? endInclusive : asOfDate(scenario);
  if (startInclusive > end) return [];
  return eachDate(startInclusive, end);
}

function weatherSeriesEnd(scenario: Scenario): string {
  const observationEnd = String(weatherConfig(scenario).observationWindow.dailyEnd);
  const forecastEnd = toDateString(maxForecastTargetDate(scenario));
  return observationEnd > forecastEnd ? observationEnd : forecastEnd;
}

function anomalyRamp(scenario: Scenario, date: Date): number {
  const ramp = weatherConfig(scenario).anomalyRamp;
  const dateKey = toDateString(date);
  const floor = Number(ramp.decayFloor);

  if (dateKey < String(ramp.onsetStart)) return 0.15;
  if (dateKey < String(ramp.plateauStart)) {
    const start = parseDate(String(ramp.onsetStart));
    const end = parseDate(String(ramp.plateauStart));
    const progress = dayDifference(start, date) / Math.max(1, dayDifference(start, end));
    return 0.15 + (1 - 0.15) * smoothstep(progress);
  }
  if (dateKey < String(ramp.decayStart)) return 1;
  if (dateKey <= String(ramp.decayEnd)) {
    const start = parseDate(String(ramp.decayStart));
    const end = parseDate(String(ramp.decayEnd));
    const progress = dayDifference(start, date) / Math.max(1, dayDifference(start, end));
    return 1 - (1 - floor) * smoothstep(progress);
  }
  return floor;
}

function regionWave(dayIndex: number, regionIndex: number): number {
  return 0.055 * Math.sin(dayIndex / 17.5 + regionIndex * 0.83) + 0.035 * Math.sin(dayIndex / 38 - regionIndex * 0.41);
}

function dateRangeForAnomalies(scenario: Scenario): Date[] {
  return eachDate(String(weatherConfig(scenario).observationWindow.dailyStart), weatherSeriesEnd(scenario));
}

function buildDailyAnomalySeries(scenario: Scenario): DailyAnomalyRecord[] {
  const weather = weatherConfig(scenario);
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const intensities = requireArray<RegionIntensity>(weather.regionIntensity, 'weather.regionIntensity');
  const climates = requireArray<RegionClimate>(weather.regionClimate, 'weather.regionClimate');
  const intensityByRegion = indexById(intensities, 'regionId', 'weather.regionIntensity');
  const climateByRegion = indexById(climates, 'regionId', 'weather.regionClimate');
  const affectedRegionIds = new Set<string>(scenario.externalSignal?.affectedRegionIds ?? []);
  const dates = dateRangeForAnomalies(scenario);
  const rampConfig = weather.anomalyRamp;
  const normalisationStart = String(rampConfig.normalisationWindowStart);
  const normalisationEnd = String(rampConfig.normalisationWindowEnd);
  const betaUv = Number(weather.demandResponse?.betaUv);
  const betaTempC = Number(weather.demandResponse?.betaTempC);
  const seaSurfaceSignal = Number(scenario.externalSignal?.seaSurfaceAnomalyC);
  const output: DailyAnomalyRecord[] = [];

  assert(Number.isFinite(betaUv) && Number.isFinite(betaTempC), 'weather.demandResponse beta values are invalid');

  for (const [regionIndex, region] of regions.entries()) {
    const intensity = intensityByRegion.get(region.regionId);
    const climate = climateByRegion.get(region.regionId);
    assert(intensity, `weather.regionIntensity is missing ${region.regionId}`);
    assert(climate, `weather.regionClimate is missing ${region.regionId}`);
    const rng = createRng(`weather:anomaly:${region.regionId}`);
    const rawMultipliers = dates.map((date, dateIndex) => {
      const noise = rng.normal(0, 0.022);
      return anomalyRamp(scenario, date) + regionWave(dateIndex, regionIndex) + noise;
    });
    const windowMultipliers = rawMultipliers.filter((_, index) => {
      const dateKey = toDateString(dates[index]);
      return dateKey >= normalisationStart && dateKey <= normalisationEnd;
    });
    const realisedMultiplierMean = average(windowMultipliers, `${region.regionId} anomaly normalisation window`);
    const uvCorrection = Number(intensity.uvIndexAnomaly) * (1 - realisedMultiplierMean);
    const tempCorrection = Number(intensity.temperatureMeanAnomalyC) * (1 - realisedMultiplierMean);
    const regionRecords: DailyAnomalyRecord[] = [];

    for (const [dateIndex, date] of dates.entries()) {
      const dateKey = toDateString(date);
      const multiplier = rawMultipliers[dateIndex];
      const uvIndexAnomaly = Number(intensity.uvIndexAnomaly) * multiplier + uvCorrection;
      const temperatureMeanAnomalyC = Number(intensity.temperatureMeanAnomalyC) * multiplier + tempCorrection;
      const affected = affectedRegionIds.has(region.regionId);
      const seaSurfaceAnomalyC =
        climate.baseSeaSurfaceTemperatureC === null
          ? null
          : affected
            ? seaSurfaceSignal * anomalyRamp(scenario, date)
            : 0.035 * Math.sin(dateIndex / 23 + regionIndex * 1.7);

      regionRecords.push({
        date: dateKey,
        regionId: region.regionId,
        ramp: anomalyRamp(scenario, date),
        temperatureMeanAnomalyC,
        uvIndexAnomaly,
        humidityAnomalyPct: clamp(-temperatureMeanAnomalyC * 1.85 - Math.max(0, uvIndexAnomaly) * 0.9, -16, 8),
        precipitationAnomalyMm: clamp(-Math.max(0, uvIndexAnomaly) * 0.42 + Math.min(0, temperatureMeanAnomalyC) * 0.35, -3.5, 1.2),
        sunshineAnomalyHours: clamp(Math.max(0, uvIndexAnomaly) * 0.52 - Math.max(0, -uvIndexAnomaly) * 0.2, -1.2, 2.6),
        seaSurfaceAnomalyC,
      });
    }

    const windowRecords = regionRecords.filter((record) => record.date >= normalisationStart && record.date <= normalisationEnd);
    const meanUv = average(
      windowRecords.map((record) => record.uvIndexAnomaly),
      `${region.regionId} uv anomaly`,
    );
    const meanTemp = average(
      windowRecords.map((record) => record.temperatureMeanAnomalyC),
      `${region.regionId} temperature anomaly`,
    );
    const predictedUpliftPct = betaUv * meanUv + betaTempC * meanTemp;

    assert(
      Math.abs(meanUv - Number(intensity.uvIndexAnomaly)) <= 1e-10,
      `${region.regionId} UV anomaly calibration drifted: ${meanUv} != ${intensity.uvIndexAnomaly}`,
    );
    assert(
      Math.abs(meanTemp - Number(intensity.temperatureMeanAnomalyC)) <= 1e-10,
      `${region.regionId} temperature anomaly calibration drifted: ${meanTemp} != ${intensity.temperatureMeanAnomalyC}`,
    );
    assert(
      Math.abs(predictedUpliftPct - Number(intensity.targetUpliftPct)) <= 0.01,
      `${region.regionId} elasticity calibration ${round(predictedUpliftPct, 4)}% != target ${intensity.targetUpliftPct}%`,
    );

    output.push(...regionRecords);
  }

  return output.sort((a, b) => a.date.localeCompare(b.date) || a.regionId.localeCompare(b.regionId));
}

export async function getDailyAnomalySeries(): Promise<DailyAnomalyRecord[]> {
  if (cachedAnomalySeries) return cachedAnomalySeries;
  const scenario = await loadScenario();
  cachedAnomalySeries = buildDailyAnomalySeries(scenario);
  return cachedAnomalySeries;
}

function sortedUvAlertLevels(levels: UvAlertLevel[]): UvAlertLevel[] {
  const sorted = [...levels].sort((a, b) => Number(a.minUvIndex) - Number(b.minUvIndex));
  assert(sorted.length > 0, 'weather.uvAlertLevels must contain at least one band');
  for (const [index, level] of sorted.entries()) {
    assert(typeof level.level === 'string' && level.level.length > 0, 'weather.uvAlertLevels contains an invalid level name');
    assert(Number.isFinite(Number(level.minUvIndex)), `weather.uvAlertLevels.${level.level}.minUvIndex is invalid`);
    assert(
      Number.isFinite(Number(level.maxUvIndexExclusive)),
      `weather.uvAlertLevels.${level.level}.maxUvIndexExclusive is invalid`,
    );
    assert(
      Number(level.minUvIndex) < Number(level.maxUvIndexExclusive),
      `weather.uvAlertLevels.${level.level} has an empty or inverted UV range`,
    );
    if (index > 0) {
      const previous = sorted[index - 1];
      assert(
        Number(previous.maxUvIndexExclusive) === Number(level.minUvIndex),
        `weather.uvAlertLevels has a gap or overlap between ${previous.level} and ${level.level}`,
      );
    }
  }
  assert(sorted[0].level === 'low' && Number(sorted[0].minUvIndex) === 0, 'weather.uvAlertLevels must start with low at UV 0');
  assert(sorted[sorted.length - 1].level === 'extreme', 'weather.uvAlertLevels must end with extreme');
  return sorted;
}

function uvAlertLevelFor(levels: UvAlertLevel[], uvIndex: number): string {
  assert(Number.isFinite(uvIndex), `Cannot derive UV alert level for non-finite UV index ${uvIndex}`);
  const sorted = sortedUvAlertLevels(levels);
  if (uvIndex < Number(sorted[0].minUvIndex)) return 'low';
  const top = sorted[sorted.length - 1];
  if (uvIndex >= Number(top.maxUvIndexExclusive)) return 'extreme';
  const matched = sorted.find(
    (level) => uvIndex >= Number(level.minUvIndex) && uvIndex < Number(level.maxUvIndexExclusive),
  );
  if (matched) return matched.level;
  throw new Error(`No UV alert level matches uvIndex=${uvIndex}; check weather.uvAlertLevels half-open bands`);
}

function heatIndexC(temperatureC: number, humidityPct: number): number {
  const humidityEffect = Math.max(0, humidityPct - 45) * 0.035;
  const heatEffect = Math.max(0, temperatureC - 26) * 0.32;
  return temperatureC + humidityEffect + heatEffect;
}

function feelsLikeC(temperatureC: number, humidityPct: number, windSpeedKph: number, sunshineHours: number): number {
  const humidityEffect = (humidityPct - 55) * 0.025;
  const sunEffect = Math.max(0, sunshineHours - 7) * 0.13;
  const windEffect = Math.max(0, windSpeedKph - 12) * 0.045;
  return temperatureC + humidityEffect + sunEffect - windEffect;
}

function buildDailyWeatherSeries(scenario: Scenario, anomalies: DailyAnomalyRecord[]): WeatherDailyRecord[] {
  const weather = weatherConfig(scenario);
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const climates = requireArray<RegionClimate>(weather.regionClimate, 'weather.regionClimate');
  const climateByRegion = indexById(climates, 'regionId', 'weather.regionClimate');
  const levels = sortedUvAlertLevels(requireArray<UvAlertLevel>(weather.uvAlertLevels, 'weather.uvAlertLevels'));
  const anomalyByKey = new Map(anomalies.map((record) => [`${record.regionId}|${record.date}`, record]));
  const rng = createRng('weather:daily-observations');
  const rows: WeatherDailyRecord[] = [];
  const provenance = providerProvenance(scenario);
  const provider = providerId(scenario);

  for (const date of eachDate(String(weather.observationWindow.dailyStart), weatherSeriesEnd(scenario))) {
    const dateKey = toDateString(date);
    const dateIndex = dayDifference(parseDate(String(weather.observationWindow.dailyStart)), date);
    for (const [regionIndex, region] of regions.entries()) {
      const climate = climateByRegion.get(region.regionId);
      const anomaly = anomalyByKey.get(`${region.regionId}|${dateKey}`);
      assert(climate, `weather.regionClimate is missing ${region.regionId}`);
      assert(anomaly, `Missing anomaly record for ${region.regionId} ${dateKey}`);

      const annualRainfallMm = Number(climate.annualRainfallMm);
      const clearTempNormal =
        seasonalCosine(Number(climate.annualMeanTempC), Number(climate.seasonalAmplitudeC), Number(climate.peakDayOfYear), date) +
        0.55 * Math.sin(dateIndex / 5.8 + regionIndex * 0.7) +
        0.25 * Math.sin(dateIndex / 14.5 - regionIndex * 0.33) +
        rng.normal(0, 0.1);
      const wetSeason = 0.92 + 0.25 * Math.cos((2 * Math.PI * (dayOfYear(date) - Number(climate.peakDayOfYear) - 95)) / 365);
      const drynessSignal = clamp(Math.max(0, anomaly.uvIndexAnomaly) * 0.025 + Math.max(0, anomaly.temperatureMeanAnomalyC) * 0.012, 0, 0.18);
      const wetProbability = clamp((annualRainfallMm / 365 / 7.2) * wetSeason - drynessSignal, 0.025, 0.52);
      const rainDay = rng.bool(wetProbability);
      const rainBase = annualRainfallMm / 365;
      const precipitationMm = rainDay
        ? clamp(rainBase * (1.3 + rng.float(0.2, 4.8)) + rng.normal(0, 0.9), 0.25, 46)
        : 0;
      const precipitationAnomalyMm = precipitationMm - rainBase;

      const humidityNormal =
        Number(climate.annualMeanHumidityPct) +
        4.5 * Math.cos((2 * Math.PI * (dayOfYear(date) - Number(climate.peakDayOfYear) + 45)) / 365) +
        rng.normal(0, 1.5);
      const humidityAnomalyPct = clamp(anomaly.humidityAnomalyPct + (rainDay ? 4.8 : 0) + rng.normal(0, 0.55), -18, 12);
      const humidityPct = clamp(humidityNormal + humidityAnomalyPct, 0, 100);
      const baseCloudCover = 38 + (humidityNormal - 60) * 0.45 + (rainDay ? 34 : 0) + rng.normal(0, 4.2);
      const cloudCoverPct = clamp(
        baseCloudCover - Math.max(0, anomaly.uvIndexAnomaly) * 5.2 - Math.max(0, anomaly.temperatureMeanAnomalyC) * 1.6,
        0,
        100,
      );
      const daylightHours = clamp(12.2 + 2.0 * Math.sin((2 * Math.PI * (dayOfYear(date) - 80)) / 365), 9.5, 14.8);
      const sunshineNormal = clamp(daylightHours * (1 - clamp(baseCloudCover, 0, 100) / 100), 0, daylightHours);
      const sunshineHours = clamp(
        daylightHours * (1 - cloudCoverPct / 100) + anomaly.sunshineAnomalyHours - (rainDay ? 0.8 : 0),
        0,
        daylightHours,
      );
      const sunshineAnomalyHours = sunshineHours - sunshineNormal;

      const clearSkyUv =
        seasonalCosine(Number(climate.annualMeanUvIndex), Number(climate.uvSeasonalAmplitude), Number(climate.peakDayOfYear), date) +
        0.2 * Math.sin(dateIndex / 8.5 + regionIndex);
      const uvNormal = clamp(clearSkyUv - cloudCoverPct * 0.018 - (rainDay ? 0.45 : 0), 0, 14);
      const uvIndex = round(clamp(uvNormal + anomaly.uvIndexAnomaly, 0, 20), 3);
      const temperatureNormalC = clearTempNormal - (rainDay ? 0.35 : 0) + (sunshineHours - sunshineNormal) * 0.08;
      const temperatureMeanC = temperatureNormalC + anomaly.temperatureMeanAnomalyC;
      const diurnalRange = clamp(8.2 - humidityPct * 0.028 - cloudCoverPct * 0.022 + sunshineHours * 0.22 + rng.normal(0, 0.28), 4.2, 13.8);
      const temperatureMinC = temperatureMeanC - diurnalRange * 0.49;
      const temperatureMaxC = temperatureMeanC + diurnalRange * 0.51;
      const windSpeedKph = clamp(13.5 + regionIndex * 0.7 + (rainDay ? 5.5 : 0) + rng.normal(0, 2.2), 2, 52);
      const pressureHpa = Number(climate.annualMeanPressureHpa) - (rainDay ? 4.8 : 0) + Math.sin(dateIndex / 6.5 + regionIndex) * 2.5 + rng.normal(0, 0.8);
      const seaSurfaceAnomalyC = anomaly.seaSurfaceAnomalyC;
      const seaSurfaceTemperatureC =
        climate.baseSeaSurfaceTemperatureC === null
          ? null
          : Number(climate.baseSeaSurfaceTemperatureC) +
            0.9 * Math.cos((2 * Math.PI * (dayOfYear(date) - Number(climate.peakDayOfYear) - 25)) / 365) +
            (seaSurfaceAnomalyC ?? 0) +
            0.07 * Math.sin(dateIndex / 18 + regionIndex);

      const uvAlertLevel = uvAlertLevelFor(levels, uvIndex);
      const row = {
        timestamp: toIsoSeconds(date),
        date: dateKey,
        regionId: region.regionId,
        stationId: climate.stationId,
        temperatureMinC: round(temperatureMinC, 2),
        temperatureMaxC: round(temperatureMaxC, 2),
        temperatureMeanC: round(temperatureMeanC, 2),
        feelsLikeC: round(feelsLikeC(temperatureMeanC, humidityPct, windSpeedKph, sunshineHours), 2),
        heatIndexC: round(heatIndexC(temperatureMeanC, humidityPct), 2),
        uvIndex,
        uvAlertLevel,
        humidityPct: round(humidityPct, 2),
        precipitationMm: round(precipitationMm, 2),
        rainDay: precipitationMm >= 0.05,
        cloudCoverPct: round(cloudCoverPct, 2),
        sunshineHours: round(sunshineHours, 2),
        windSpeedKph: round(windSpeedKph, 2),
        seaSurfaceTemperatureC: seaSurfaceTemperatureC === null ? null : round(seaSurfaceTemperatureC, 3),
        pressureHpa: round(pressureHpa, 2),
        temperatureMeanAnomalyC: round(anomaly.temperatureMeanAnomalyC, 3),
        uvIndexAnomaly: round(anomaly.uvIndexAnomaly, 3),
        humidityAnomalyPct: round(humidityAnomalyPct, 2),
        precipitationAnomalyMm: round(precipitationAnomalyMm, 2),
        sunshineAnomalyHours: round(sunshineAnomalyHours, 2),
        seaSurfaceAnomalyC: seaSurfaceAnomalyC === null ? null : round(seaSurfaceAnomalyC, 3),
        ramp: round(anomaly.ramp, 5),
        provenance,
        providerId: provider,
        temperatureNormalC: round(temperatureNormalC, 3),
        uvNormal: round(uvNormal, 3),
      } as WeatherDailyRecord & { provenance: string; providerId: string };
      const expectedUvAlertLevel = uvAlertLevelFor(levels, row.uvIndex);
      assert(
        row.uvAlertLevel === expectedUvAlertLevel,
        `${region.regionId} ${dateKey} UV alert level ${row.uvAlertLevel} does not match uvIndex ${row.uvIndex}`,
      );
      rows.push(row);
    }
  }

  assert(
    rows.length ===
      requireArray<Region>(scenario.regions, 'regions').length *
        eachDate(String(weather.observationWindow.dailyStart), weatherSeriesEnd(scenario)).length,
    `Weather daily basis row count ${rows.length} does not match the weather basis window`,
  );
  return rows;
}

export async function getWeatherDailySeries(): Promise<WeatherDailyRecord[]> {
  if (cachedDailySeries) return cachedDailySeries;
  const scenario = await loadScenario();
  const anomalies = await getDailyAnomalySeries();
  cachedDailySeries = buildDailyWeatherSeries(scenario, anomalies);
  return cachedDailySeries;
}

function dailyCsvRow(row: WeatherDailyRecord, scenario: Scenario): Record<string, CsvValue> {
  return {
    timestamp: row.timestamp,
    regionId: row.regionId,
    stationId: row.stationId,
    temperatureMinC: row.temperatureMinC,
    temperatureMaxC: row.temperatureMaxC,
    temperatureMeanC: row.temperatureMeanC,
    feelsLikeC: row.feelsLikeC,
    heatIndexC: row.heatIndexC,
    uvIndex: row.uvIndex,
    uvAlertLevel: row.uvAlertLevel,
    humidityPct: row.humidityPct,
    precipitationMm: row.precipitationMm,
    rainDay: row.rainDay,
    cloudCoverPct: row.cloudCoverPct,
    sunshineHours: row.sunshineHours,
    windSpeedKph: row.windSpeedKph,
    seaSurfaceTemperatureC: row.seaSurfaceTemperatureC,
    pressureHpa: row.pressureHpa,
    temperatureMeanAnomalyC: row.temperatureMeanAnomalyC,
    uvIndexAnomaly: row.uvIndexAnomaly,
    humidityAnomalyPct: row.humidityAnomalyPct,
    precipitationAnomalyMm: row.precipitationAnomalyMm,
    sunshineAnomalyHours: row.sunshineAnomalyHours,
    seaSurfaceAnomalyC: row.seaSurfaceAnomalyC,
    provenance: providerProvenance(scenario),
    providerId: providerId(scenario),
  };
}

function solarCurve(hour: number): number {
  if (hour < 6 || hour >= 19) return 0;
  return Math.sin((Math.PI * (hour - 6)) / 13);
}

function buildHourlyWeatherSeries(scenario: Scenario, dailyRows: WeatherDailyRecord[]): WeatherHourlyRecord[] {
  const weather = weatherConfig(scenario);
  const rows: WeatherHourlyRecord[] = [];
  const dailyByKey = new Map(dailyRows.map((row) => [`${row.regionId}|${row.date}`, row]));
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const rng = createRng('weather:hourly-observations');
  const maxSolarCurve = Math.max(...HOURS.map(solarCurve));
  const provenance = providerProvenance(scenario);

  for (const date of observedDates(scenario, String(weather.observationWindow.hourlyStart), String(weather.observationWindow.hourlyEnd))) {
    const dateKey = toDateString(date);
    for (const [regionIndex, region] of regions.entries()) {
      const daily = dailyByKey.get(`${region.regionId}|${dateKey}`);
      assert(daily, `Missing daily weather row for hourly consistency: ${region.regionId} ${dateKey}`);
      const amplitude = clamp((daily.temperatureMaxC - daily.temperatureMinC) / 2, 2, 8);
      const baseTemperatures = HOURS.map((hour) => daily.temperatureMeanC + amplitude * Math.cos((2 * Math.PI * (hour - 15)) / 24) + rng.normal(0, 0.08));
      const offset = daily.temperatureMeanC - average(baseTemperatures, `${region.regionId} ${dateKey} hourly temperature`);
      const temperatures = baseTemperatures.map((value) => value + offset);
      const wetHours = new Set<number>();
      if (daily.precipitationMm > 0) {
        const stormStart = rng.int(5, 19);
        const stormLength = clamp(Math.round(daily.precipitationMm / 4) + rng.int(1, 3), 1, 8);
        for (let i = 0; i < stormLength; i += 1) wetHours.add((stormStart + i) % 24);
      }
      const rainWeights = HOURS.map((hour) => (wetHours.has(hour) ? 1 + rng.float(0, 0.8) : 0));
      const rainWeightSum = rainWeights.reduce((sum, value) => sum + value, 0);
      const hourlyRows: WeatherHourlyRecord[] = [];

      for (const hour of HOURS) {
        const temperatureC = temperatures[hour];
        const solar = solarCurve(hour) / maxSolarCurve;
        const uvIndex = hour < 6 || hour >= 19 ? 0 : daily.uvIndex * solar;
        const precipitationMm = rainWeightSum > 0 ? (daily.precipitationMm * rainWeights[hour]) / rainWeightSum : 0;
        const cloudCoverPct = clamp(daily.cloudCoverPct + (precipitationMm > 0 ? 14 : 0) - solar * 7 + rng.normal(0, 2.3), 0, 100);
        const humidityPct = clamp(daily.humidityPct - (temperatureC - daily.temperatureMeanC) * 1.85 + (precipitationMm > 0 ? 4 : 0), 0, 100);
        const windSpeedKph = clamp(daily.windSpeedKph + (precipitationMm > 0 ? 3.5 : 0) + rng.normal(0, 0.9), 1, 58);
        hourlyRows.push({
          timestamp: toIsoSeconds(addMinutes(date, hour * 60)),
          regionId: region.regionId,
          stationId: daily.stationId,
          temperatureC: round(temperatureC, 2),
          feelsLikeC: round(feelsLikeC(temperatureC, humidityPct, windSpeedKph, Math.max(0, solar * daily.sunshineHours)), 2),
          uvIndex: round(uvIndex, 3),
          humidityPct: round(humidityPct, 2),
          precipitationMm: round(precipitationMm, 3),
          cloudCoverPct: round(cloudCoverPct, 2),
          windSpeedKph: round(windSpeedKph, 2),
          pressureHpa: round(daily.pressureHpa + Math.sin((hour / 24) * 2 * Math.PI + regionIndex) * 0.55, 2),
          provenance,
        });
      }

      const meanTemperature = average(
        hourlyRows.map((row) => row.temperatureC),
        `${region.regionId} ${dateKey} emitted hourly temperature`,
      );
      const maxUv = Math.max(...hourlyRows.map((row) => row.uvIndex));
      assert(
        Math.abs(meanTemperature - daily.temperatureMeanC) <= 0.6,
        `${region.regionId} ${dateKey} hourly mean temperature ${round(meanTemperature, 3)}C diverges from daily ${daily.temperatureMeanC}C`,
      );
      assert(
        Math.abs(maxUv - daily.uvIndex) <= 0.6,
        `${region.regionId} ${dateKey} hourly max UV ${round(maxUv, 3)} diverges from daily ${daily.uvIndex}`,
      );
      rows.push(...hourlyRows);
    }
  }

  return rows;
}

function awarenessFactor(scenario: Scenario, issueDate: string, affected: boolean): number {
  if (!affected) return 1;
  const signalEnd = parseDate(String(scenario.externalSignal?.observationPeriodEnd));
  const revisionStart = addDays(signalEnd, -30);
  const decisionIssue = parseDate(String(weatherConfig(scenario).forecast.decisionDayIssue));
  const issue = parseDate(issueDate);
  const progress = smoothstep(dayDifference(revisionStart, issue) / Math.max(1, dayDifference(revisionStart, decisionIssue)));
  return clamp(0.38 + progress * 0.67, 0.38, 1.05);
}

function forecastRowsForScenario(scenario: Scenario, dailyRows: WeatherDailyRecord[]): WeatherForecastRecord[] {
  const weather = weatherConfig(scenario);
  const dailyByKey = new Map(dailyRows.map((row) => [`${row.regionId}|${row.date}`, row]));
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const affectedRegionIds = new Set<string>(scenario.externalSignal?.affectedRegionIds ?? []);
  const horizonDays = Number(weather.forecast.horizonDays);
  const issueDates = eachDate(String(weather.forecast.issueStart), String(weather.forecast.issueEnd)).filter((issue) =>
    includeOutcomeSlice() || isObservable(scenario, toDateString(issue)),
  );
  const persistenceProbability = Number(weather.seasonalOutlook?.persistenceProbability);
  const rows: WeatherForecastRecord[] = [];
  const diagnostics: ForecastDiagnostic[] = [];
  const provenance = providerProvenance(scenario);
  const provider = providerId(scenario);

  for (const issue of issueDates) {
    const issueDate = toDateString(issue);
    const issueTimestamp = `${issueDate}T${weather.provider.issueTimeUtc ?? '05:00:00'}Z`;
    for (const [regionIndex, region] of regions.entries()) {
      const affected = affectedRegionIds.has(region.regionId);
      for (let leadDays = 1; leadDays <= horizonDays; leadDays += 1) {
        const targetDate = toDateString(addDays(issue, leadDays));
        const observed = dailyByKey.get(`${region.regionId}|${targetDate}`);
        assert(observed, `Missing weather basis for forecast target ${region.regionId} ${targetDate}`);
        const leadRatio = leadDays / horizonDays;
        const awareness = awarenessFactor(scenario, issueDate, affected);
        const persistenceBlend = affected ? 1 - (1 - persistenceProbability) * leadRatio * 0.22 : 1;
        const anomalyFactor = affected ? awareness * persistenceBlend : 0.88;
        const wave = Math.sin(dayDifference(parseDate(String(weather.forecast.issueStart)), issue) * 0.29 + regionIndex * 0.83 + leadDays * 0.17);
        const tempAnomalyP50 =
          observed.temperatureMeanAnomalyC * anomalyFactor + wave * (affected ? 0.12 : 0.035) * leadRatio;
        const uvAnomalyP50 = observed.uvIndexAnomaly * anomalyFactor + wave * (affected ? 0.07 : 0.028) * leadRatio;
        const tempP50 = observed.temperatureNormalC + tempAnomalyP50;
        const uvP50 = clamp(observed.uvNormal + uvAnomalyP50, 0, 20);
        const tempSpread = 0.32 + 0.062 * leadDays;
        const uvSpread = 0.12 + 0.014 * leadDays;
        const temperatureMeanC_p10 = tempP50 - tempSpread;
        const temperatureMeanC_p90 = tempP50 + tempSpread;
        const uvIndex_p10 = clamp(uvP50 - uvSpread, 0, 20);
        const uvIndex_p90 = clamp(uvP50 + uvSpread, 0, 20);
        const precipitationMm_p50 = clamp(observed.precipitationMm + wave * leadRatio * 0.9, 0, 55);
        const confidence = affected
          ? 0.96 - (0.96 - persistenceProbability) * leadRatio ** 0.85
          : 0.94 - 0.17 * leadRatio ** 0.9;
        const row: WeatherForecastRecord = {
          issueTimestamp: toIsoSeconds(parseDate(issueTimestamp)),
          issueDate,
          targetDate,
          leadDays,
          regionId: region.regionId,
          providerId: provider,
          temperatureMeanC_p10: round(temperatureMeanC_p10, 2),
          temperatureMeanC_p50: round(tempP50, 2),
          temperatureMeanC_p90: round(temperatureMeanC_p90, 2),
          uvIndex_p10: round(uvIndex_p10, 3),
          uvIndex_p50: round(uvP50, 3),
          uvIndex_p90: round(uvIndex_p90, 3),
          temperatureMeanAnomalyC_p50: round(tempAnomalyP50, 3),
          uvIndexAnomaly_p50: round(uvAnomalyP50, 3),
          precipitationMm_p50: round(precipitationMm_p50, 2),
          confidence: round(clamp(confidence, 0.55, 0.98), 3),
          provenance,
        };
        assert(row.temperatureMeanC_p10 <= row.temperatureMeanC_p50 && row.temperatureMeanC_p50 <= row.temperatureMeanC_p90, `Forecast temperature quantiles are unordered for ${region.regionId} ${issueDate} lead ${leadDays}`);
        assert(row.uvIndex_p10 <= row.uvIndex_p50 && row.uvIndex_p50 <= row.uvIndex_p90, `Forecast UV quantiles are unordered for ${region.regionId} ${issueDate} lead ${leadDays}`);
        diagnostics.push({
          leadDays,
          regionId: region.regionId,
          targetDate,
          issueDate,
          affected,
          tempAbsError: Math.abs(row.temperatureMeanC_p50 - observed.temperatureMeanC),
          uvAbsError: Math.abs(row.uvIndex_p50 - observed.uvIndex),
          uvAnomalyP50: row.uvIndexAnomaly_p50,
          normalUv: observed.uvNormal,
          uvP10: row.uvIndex_p10,
          uvP90: row.uvIndex_p90,
        });
        rows.push(row);
      }
    }
  }

  assertForecastSkill(scenario, diagnostics);
  assertForecastRevision(scenario, diagnostics);
  assertDecisionDayForecast(scenario, diagnostics);
  return rows;
}

function assertForecastSkill(scenario: Scenario, diagnostics: ForecastDiagnostic[]): void {
  const sampleStart = toDateString(addDays(parseDate(String(weatherConfig(scenario).anomalyRamp.normalisationWindowEnd)), -5));
  const sampleEnd = String(scenario.clock?.campaignEnd ?? weatherConfig(scenario).forecast.issueEnd);
  const sampled = diagnostics.filter((row) => row.targetDate >= sampleStart && row.targetDate <= sampleEnd);
  const near = sampled.filter((row) => row.leadDays <= 5).map((row) => row.tempAbsError + row.uvAbsError * 2);
  const middle = sampled.filter((row) => row.leadDays >= 13 && row.leadDays <= 17).map((row) => row.tempAbsError + row.uvAbsError * 2);
  const far = sampled.filter((row) => row.leadDays >= 26).map((row) => row.tempAbsError + row.uvAbsError * 2);
  const nearAvg = average(near, 'near-lead forecast errors');
  const middleAvg = average(middle, 'mid-lead forecast errors');
  const farAvg = average(far, 'far-lead forecast errors');
  assert(
    nearAvg < middleAvg && middleAvg < farAvg,
    `Forecast skill check failed: near=${round(nearAvg, 3)}, middle=${round(middleAvg, 3)}, far=${round(farAvg, 3)}`,
  );
}

function assertForecastRevision(scenario: Scenario, diagnostics: ForecastDiagnostic[]): void {
  const end = parseDate(String(weatherConfig(scenario).anomalyRamp.normalisationWindowEnd));
  const juneTargets = new Set(eachDate(toDateString(addDays(end, -4)), toDateString(end)).map((date) => toDateString(date)));
  const sample = diagnostics.filter((row) => row.affected && juneTargets.has(row.targetDate));
  const earlyMay = sample.filter((row) => row.leadDays >= 24 && row.leadDays <= 30).map((row) => row.uvAnomalyP50);
  const lateMay = sample.filter((row) => row.leadDays >= 12 && row.leadDays <= 18).map((row) => row.uvAnomalyP50);
  const earlyJune = sample.filter((row) => row.leadDays >= 1 && row.leadDays <= 7).map((row) => row.uvAnomalyP50);
  const earlyMayAvg = average(earlyMay, 'early-May anomaly forecasts');
  const lateMayAvg = average(lateMay, 'late-May anomaly forecasts');
  const earlyJuneAvg = average(earlyJune, 'early-June anomaly forecasts');
  assert(
    earlyMayAvg < lateMayAvg && lateMayAvg < earlyJuneAvg && earlyJuneAvg - earlyMayAvg >= 0.5,
    `Forecast revision check failed: earlyMay=${round(earlyMayAvg, 3)}, lateMay=${round(lateMayAvg, 3)}, earlyJune=${round(earlyJuneAvg, 3)}`,
  );
}

function assertDecisionDayForecast(scenario: Scenario, diagnostics: ForecastDiagnostic[]): void {
  const weather = weatherConfig(scenario);
  const decisionIssue = String(weather.forecast.decisionDayIssue);
  const affectedRegionIds = new Set<string>(scenario.externalSignal?.affectedRegionIds ?? []);
  const unaffectedRegionIds = new Set<string>(scenario.externalSignal?.unaffectedRegionIds ?? []);
  const decisionRows = diagnostics.filter((row) => row.issueDate === decisionIssue);
  assert(decisionRows.length > 0, `No decision-day forecast rows found for ${decisionIssue}`);

  for (const row of decisionRows) {
    if (affectedRegionIds.has(row.regionId)) {
      assert(row.uvAnomalyP50 > 0, `${row.regionId} ${row.targetDate} decision-day UV anomaly is not positive`);
      assert(
        row.uvP10 > row.normalUv,
        `${row.regionId} ${row.targetDate} decision-day UV p10 ${row.uvP10} is not above normal ${row.normalUv}`,
      );
    } else if (unaffectedRegionIds.has(row.regionId)) {
      assert(Math.abs(row.uvAnomalyP50) <= 0.25, `${row.regionId} ${row.targetDate} control UV anomaly ${row.uvAnomalyP50} is not near zero`);
      assert(
        row.uvP10 <= row.normalUv && row.normalUv <= row.uvP90,
        `${row.regionId} ${row.targetDate} control UV band does not straddle normal ${row.normalUv}`,
      );
    }
  }
}

function chunkRun<T>(items: T[], minLength: number, chunkLength: number, limit: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index + minLength <= items.length && chunks.length < limit; index += chunkLength) {
    const chunk = items.slice(index, Math.min(items.length, index + chunkLength));
    if (chunk.length >= minLength) chunks.push(chunk);
  }
  return chunks;
}

function findRuns(rows: WeatherDailyRecord[], predicate: (row: WeatherDailyRecord) => boolean): WeatherDailyRecord[][] {
  const runs: WeatherDailyRecord[][] = [];
  let current: WeatherDailyRecord[] = [];
  for (const row of rows) {
    if (predicate(row)) {
      current.push(row);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function severityForHeat(peak: number): string {
  if (peak >= 35) return 'severe';
  if (peak >= 31.5) return 'moderate';
  return 'minor';
}

function severityForUv(peak: number, levels: UvAlertLevel[]): string {
  const extreme = levels.find((level) => level.level === 'extreme');
  return extreme && peak >= Number(extreme.minUvIndex) ? 'extreme' : 'very-high';
}

function severityForRain(peak: number): string {
  if (peak >= 24) return 'severe';
  if (peak >= 12) return 'moderate';
  return 'minor';
}

function addDaysToDateString(date: string, days: number): string {
  return toDateString(addDays(parseDate(date), days));
}

function buildWeatherEvents(scenario: Scenario, dailyRows: WeatherDailyRecord[]): WeatherEventRecord[] {
  const weather = weatherConfig(scenario);
  const regions = requireArray<Region>(scenario.regions, 'regions');
  const climates = requireArray<RegionClimate>(weather.regionClimate, 'weather.regionClimate');
  const levels = sortedUvAlertLevels(requireArray<UvAlertLevel>(weather.uvAlertLevels, 'weather.uvAlertLevels'));
  const catalogue = requireArray<WeatherEventCatalogueItem>(weather.eventCatalogue, 'weather.eventCatalogue');
  const catalogueByType = indexById(catalogue, 'eventType', 'weather.eventCatalogue');
  const climateByRegion = indexById(climates, 'regionId', 'weather.regionClimate');
  const rowsByRegion = new Map<string, WeatherDailyRecord[]>();
  const affectedRegionIds = new Set<string>(scenario.externalSignal?.affectedRegionIds ?? []);
  const events: WeatherEventRecord[] = [];
  const eventIds = new Set<string>();
  const sequenceByTypeRegion = new Map<string, number>();
  const provider = providerId(scenario);
  const provenance = providerProvenance(scenario);
  const heatThresholdByRegion = new Map<string, number>();
  const veryHighUv = levels.find((level) => level.level === 'very-high');
  assert(veryHighUv, 'weather.uvAlertLevels is missing very-high');

  for (const row of dailyRows) {
    const regionRows = rowsByRegion.get(row.regionId) ?? [];
    regionRows.push(row);
    rowsByRegion.set(row.regionId, regionRows);
  }

  for (const region of regions) {
    const regionRows = rowsByRegion.get(region.regionId) ?? [];
    heatThresholdByRegion.set(region.regionId, percentile(regionRows.map((row) => row.temperatureMaxC), affectedRegionIds.has(region.regionId) ? 0.72 : 0.88));
  }

  function nextEventId(eventType: string, regionId: string): string {
    const key = `${eventType}|${regionId}`;
    const next = (sequenceByTypeRegion.get(key) ?? 0) + 1;
    sequenceByTypeRegion.set(key, next);
    return `WXE-${eventType.toUpperCase().replaceAll('_', '-')}-${regionId}-${String(next).padStart(3, '0')}`;
  }

  function addEvent(input: Omit<WeatherEventRecord, 'eventId' | 'provenance' | 'providerId' | 'relevantToHeroProduct'>): void {
    const item = catalogueByType.get(input.eventType);
    assert(item, `Event type ${input.eventType} is missing from weather.eventCatalogue`);
    const eventId = nextEventId(input.eventType, input.regionId);
    assert(!eventIds.has(eventId), `Duplicate weather event id ${eventId}`);
    eventIds.add(eventId);
    events.push({
      ...input,
      eventId,
      relevantToHeroProduct: Boolean(item.relevantToHeroProduct),
      provenance,
      providerId: provider,
    });
  }

  for (const regionId of scenario.externalSignal?.affectedRegionIds ?? []) {
    addEvent({
      eventType: 'enso_phase',
      regionId,
      severity: 'strong',
      startDate: String(scenario.externalSignal.observationPeriodStart),
      endDate: String(scenario.externalSignal.persistenceThrough),
      peakValue: round(Number(scenario.externalSignal.seaSurfaceAnomalyC), 3),
      peakMetric: 'seaSurfaceAnomalyC',
      signalId: String(scenario.externalSignal.signalId),
      headline: `${String(scenario.externalSignal.name)} persists over ${regionId}`,
    });
  }

  for (const region of regions) {
    const regionRows = rowsByRegion.get(region.regionId) ?? [];
    const affected = affectedRegionIds.has(region.regionId);
    const heatThreshold = heatThresholdByRegion.get(region.regionId) ?? 30;
    const plateauRows = regionRows.filter(
      (row) => row.date >= String(weather.anomalyRamp.plateauStart) && row.date <= String(weather.anomalyRamp.decayStart),
    );
    const heatRuns = findRuns(plateauRows, (row) => row.temperatureMaxC >= heatThreshold);
    const heatLimit = affected ? 6 : 1;
    for (const run of heatRuns.flatMap((candidate) => chunkRun(candidate, 3, 5, heatLimit)).slice(0, heatLimit)) {
      const peak = Math.max(...run.map((row) => row.temperatureMaxC));
      addEvent({
        eventType: 'heatwave',
        regionId: region.regionId,
        severity: severityForHeat(peak),
        startDate: run[0].date,
        endDate: run[run.length - 1].date,
        peakValue: peak,
        peakMetric: 'temperatureMaxC',
        signalId: affected ? String(scenario.externalSignal.signalId) : '',
        headline: `${region.regionId} heatwave reaches ${round(peak, 1)}C`,
      });
    }

    const uvRuns = findRuns(plateauRows, (row) => row.uvIndex >= Number(veryHighUv.minUvIndex));
    const uvLimit = affected ? 8 : 2;
    for (const run of uvRuns.flatMap((candidate) => chunkRun(candidate, 1, 4, uvLimit)).slice(0, uvLimit)) {
      const peak = Math.max(...run.map((row) => row.uvIndex));
      addEvent({
        eventType: 'uv_alert',
        regionId: region.regionId,
        severity: severityForUv(peak, levels),
        startDate: run[0].date,
        endDate: run[run.length - 1].date,
        peakValue: peak,
        peakMetric: 'uvIndex',
        signalId: affected ? String(scenario.externalSignal.signalId) : '',
        headline: `${region.regionId} UV advisory peaks at index ${round(peak, 1)}`,
      });
    }

    const climate = climateByRegion.get(region.regionId);
    if (affected && climate?.baseSeaSurfaceTemperatureC !== null) {
      const marineRuns = findRuns(plateauRows, (row) => (row.seaSurfaceAnomalyC ?? 0) >= Number(scenario.externalSignal.seaSurfaceAnomalyC) * 0.75);
      for (const run of marineRuns.flatMap((candidate) => chunkRun(candidate, 5, 10, 4)).slice(0, 4)) {
        const peak = Math.max(...run.map((row) => row.seaSurfaceAnomalyC ?? 0));
        addEvent({
          eventType: 'marine_heatwave',
          regionId: region.regionId,
          severity: peak >= 1.35 ? 'severe' : peak >= 1.15 ? 'strong' : 'moderate',
          startDate: run[0].date,
          endDate: run[run.length - 1].date,
          peakValue: round(peak, 3),
          peakMetric: 'seaSurfaceAnomalyC',
          signalId: String(scenario.externalSignal.signalId),
          headline: `${region.regionId} marine heatwave sustains warm basin conditions`,
        });
      }
    }

    const rainCandidates = regionRows
      .filter((row) => row.precipitationMm >= percentile(regionRows.map((candidate) => candidate.precipitationMm), 0.86) && row.precipitationMm > 0)
      .sort((a, b) => b.precipitationMm - a.precipitationMm || a.date.localeCompare(b.date))
      .slice(0, 4)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const row of rainCandidates) {
      addEvent({
        eventType: 'rain_storm',
        regionId: region.regionId,
        severity: severityForRain(row.precipitationMm),
        startDate: row.date,
        endDate: row.precipitationMm > 18 ? addDaysToDateString(row.date, 1) : row.date,
        peakValue: row.precipitationMm,
        peakMetric: 'precipitationMm',
        signalId: '',
        headline: `${region.regionId} rainfall event brings ${round(row.precipitationMm, 1)} mm`,
      });
    }

    const coldRows = regionRows.filter((row) => row.date <= String(weather.anomalyRamp.onsetStart));
    const coldThreshold = percentile(coldRows.map((row) => row.temperatureMinC), 0.18);
    for (const row of coldRows.filter((candidate) => candidate.temperatureMinC <= coldThreshold).slice(0, 2)) {
      addEvent({
        eventType: 'cold_snap',
        regionId: region.regionId,
        severity: row.temperatureMinC <= coldThreshold - 2 ? 'severe' : row.temperatureMinC <= coldThreshold - 1 ? 'moderate' : 'minor',
        startDate: row.date,
        endDate: row.date,
        peakValue: row.temperatureMinC,
        peakMetric: 'temperatureMinC',
        signalId: '',
        headline: `${region.regionId} unseasonal cold snap dips to ${round(row.temperatureMinC, 1)}C`,
      });
    }

    const airQualityRows = regionRows
      .filter((row) => row.windSpeedKph >= percentile(regionRows.map((candidate) => candidate.windSpeedKph), 0.78) && row.humidityPct < 72)
      .slice(0, 2);
    for (const row of airQualityRows) {
      addEvent({
        eventType: 'air_quality',
        regionId: region.regionId,
        severity: row.windSpeedKph > 24 ? 'very-poor' : row.windSpeedKph > 18 ? 'poor' : 'moderate',
        startDate: row.date,
        endDate: row.date,
        peakValue: row.windSpeedKph,
        peakMetric: 'windSpeedKph',
        signalId: '',
        headline: `${region.regionId} dust and air-quality advisory follows dry winds`,
      });
    }
  }

  const tropicalWatchRegions = requireArray<string>(scenario.externalSignal?.affectedRegionIds, 'externalSignal.affectedRegionIds').filter(
    (regionId) => climateByRegion.get(regionId)?.baseSeaSurfaceTemperatureC !== null,
  );
  for (const regionId of tropicalWatchRegions) {
    const regionRows = rowsByRegion.get(regionId) ?? [];
    // Storm watches are deliberate distractors: irrelevant to sunscreen demand,
    // present so the demo can show the agent discriminating them from the signal.
    // They are therefore drawn from the observable window rather than from days
    // after the decision, which the default dataset no longer contains at all.
    const windThreshold = percentile(regionRows.map((candidate) => candidate.windSpeedKph), 0.72);
    const stormRows = regionRows
      .filter((row) => row.windSpeedKph >= windThreshold)
      .slice(-2);
    for (const row of stormRows) {
      addEvent({
        eventType: 'tropical_storm_watch',
        regionId,
        severity: row.windSpeedKph > 24 ? 'warning' : 'watch',
        startDate: row.date,
        endDate: addDaysToDateString(row.date, 2),
        peakValue: row.windSpeedKph,
        peakMetric: 'windSpeedKph',
        signalId: '',
        headline: `${regionId} tropical storm watch stays unrelated to sunscreen signal`,
      });
    }
  }

  events.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.eventType.localeCompare(b.eventType) || a.regionId.localeCompare(b.regionId) || a.eventId.localeCompare(b.eventId));
  assertWeatherEvents(scenario, events, dailyRows, heatThresholdByRegion, Number(veryHighUv.minUvIndex), catalogueByType);
  return events;
}

function assertWeatherEvents(
  scenario: Scenario,
  events: WeatherEventRecord[],
  dailyRows: WeatherDailyRecord[],
  heatThresholdByRegion: Map<string, number>,
  uvThreshold: number,
  catalogueByType: Map<string, WeatherEventCatalogueItem>,
): void {
  const dailyByKey = new Map(dailyRows.map((row) => [`${row.regionId}|${row.date}`, row]));
  const eventTypes = new Set(events.map((event) => event.eventType));
  const eventIds = new Set<string>();
  const affectedRegionIds = new Set<string>(scenario.externalSignal?.affectedRegionIds ?? []);

  for (const eventType of catalogueByType.keys()) {
    assert(eventTypes.has(eventType), `WeatherEvents is missing catalogue type ${eventType}`);
  }
  assert(events.length >= 90 && events.length <= 140, `WeatherEvents row count ${events.length} is outside the requested 90-140 range`);

  for (const event of events) {
    assert(!eventIds.has(event.eventId), `WeatherEvents duplicate eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    if (event.eventType === 'enso_phase' && affectedRegionIds.has(event.regionId)) {
      assert(event.signalId === String(scenario.externalSignal.signalId), `${event.eventId} does not reference ${scenario.externalSignal.signalId}`);
      assert(event.startDate === String(scenario.externalSignal.observationPeriodStart), `${event.eventId} startDate does not align with externalSignal`);
      assert(event.endDate === String(scenario.externalSignal.persistenceThrough), `${event.eventId} endDate does not align with externalSignal`);
    }
    if (event.eventType === 'heatwave') {
      const rows = eachDate(event.startDate, event.endDate).map((date) => dailyByKey.get(`${event.regionId}|${toDateString(date)}`));
      assert(rows.length >= 3 && rows.every(Boolean), `${event.eventId} heatwave does not cover at least three generated days`);
      const threshold = heatThresholdByRegion.get(event.regionId) ?? Number.POSITIVE_INFINITY;
      assert(
        rows.every((row) => (row?.temperatureMaxC ?? Number.NEGATIVE_INFINITY) >= threshold),
        `${event.eventId} heatwave includes a non-qualifying day`,
      );
    }
    if (event.eventType === 'uv_alert') {
      const rows = eachDate(event.startDate, event.endDate).map((date) => dailyByKey.get(`${event.regionId}|${toDateString(date)}`));
      assert(rows.length > 0 && rows.every(Boolean), `${event.eventId} UV alert references missing generated days`);
      assert(rows.every((row) => (row?.uvIndex ?? Number.NEGATIVE_INFINITY) >= uvThreshold), `${event.eventId} UV alert includes a non-qualifying day`);
    }
  }
}

async function writeCsv(relativePath: string, columns: string[], rows: Record<string, CsvValue>[]): Promise<GenerationResult> {
  const writer = await openCsv(relativePath, columns);
  for (const row of rows) await writer.writeRow(row);
  const writtenRows = await writer.close();
  return { file: relativePath, rows: writtenRows };
}

export async function generateWeather(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const dailyRows = await getWeatherDailySeries();
  const observationRows = dailyRows.filter((row) => includeOutcomeSlice() || isObservable(scenario, row.date));
  const hourlyRows = buildHourlyWeatherSeries(scenario, observationRows);
  const forecastRows = forecastRowsForScenario(scenario, dailyRows);
  const eventRows = buildWeatherEvents(scenario, observationRows);

  const results: GenerationResult[] = [];
  results.push(await writeCsv('eventhouse/WeatherObservationsDaily.csv', DAILY_COLUMNS, observationRows.map((row) => dailyCsvRow(row, scenario))));
  results.push(await writeCsv('eventhouse/WeatherObservationsHourly.csv', HOURLY_COLUMNS, hourlyRows));
  results.push(await writeCsv('eventhouse/WeatherForecastDaily.csv', FORECAST_COLUMNS, forecastRows));
  results.push(await writeCsv('eventhouse/WeatherEvents.csv', EVENT_COLUMNS, eventRows));

  logResults('Weather generated', results);
  assert(DATA_ROOT.endsWith('/data'), 'Weather generator DATA_ROOT is not the data folder');
  return results;
}
