import {
  addDays,
  allocateIntegers,
  asOfDate,
  clamp,
  countOperatingDays,
  createRng,
  eachDate,
  includeOutcomeSlice,
  isObservable,
  isOperatingDay,
  loadScenario,
  logResults,
  openCsv,
  parseDate,
  round,
  toDateString,
} from './core.ts';
import type { CsvValue, CsvWriter, GenerationResult, Rng } from './core.ts';

type ScenarioRecord = Record<string, any>;
type CsvRow = Record<string, CsvValue>;
type ProductionOrderInfo = { productionOrderId: string; productId: string; plannedUnits: number; emit: boolean };

const SALES_ORDER_LINE_TARGET = 260_000;
const PRODUCTION_ORDER_TARGET = 12_000;
const MATERIAL_RESERVATION_TARGET = 25_000;

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

function compactDate(value: string): string {
  return value.replaceAll('-', '');
}

function isBetweenDate(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function rowKey(...parts: string[]): string {
  return parts.join('|');
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function sortedDeferralTable(policy: ScenarioRecord): ScenarioRecord[] {
  return [...asArray(policy.rule?.deferralTable, `${policy.policyId}.rule.deferralTable`)].sort(
    (a, b) => Number(a.maxSustainedRateFactor) - Number(b.maxSustainedRateFactor),
  );
}

function permittedDeferralDays(policy: ScenarioRecord, sustainedRateFactor: number): number {
  for (const entry of sortedDeferralTable(policy)) {
    if (sustainedRateFactor <= Number(entry.maxSustainedRateFactor) + 1e-9) {
      return Number(entry.maxDeferralDays);
    }
  }
  return 0;
}

function deriveForecastVersionId(forecastDate: string, heroProductId: string): string {
  const [year, month, day] = forecastDate.split('-');
  const productToken = heroProductId.split('-')[1] ?? 'PRODUCT';
  return `FC-${year}-${month}${day}-${productToken}`;
}

function getBaselineForecastVersionId(scenario: ScenarioRecord, fallback: string): string {
  const hops = asArray(scenario.evidenceChain?.hops, 'evidenceChain.hops');
  const hop = hops.find((item) => item.relation === 'campaign_built_on_forecast_version');
  return typeof hop?.to === 'string' ? hop.to : fallback;
}

function productDemandFactor(product: ScenarioRecord, productIndex: number, heroProduct: ScenarioRecord): number {
  if (product.productId === heroProduct.productId) return 1;
  const categoryBoost = product.category === heroProduct.category ? 0.08 : -0.02;
  const controlledPenalty = product.handlingClass === 'controlled' ? -0.05 : 0;
  return clamp(0.52 - productIndex * 0.055 + categoryBoost + controlledPenalty, 0.18, 0.58);
}

function checkNoPersonaName(
  fileName: string,
  row: CsvRow,
  personaNames: string[],
): void {
  for (const [column, value] of Object.entries(row)) {
    if (fileName === 'personas.csv' && column === 'displayName') continue;
    if (typeof value !== 'string') continue;
    const lower = value.toLowerCase();
    for (const personaName of personaNames) {
      if (personaName && lower.includes(personaName)) {
        throw new Error(`Persona name leaked to ${fileName}.${column}`);
      }
    }
  }
}

function assertRoleColumn(row: CsvRow, column: string, roleIds: Set<string>, fileName: string): void {
  const value = row[column];
  if (value === null || value === undefined || value === '') return;
  assertCondition(typeof value === 'string' && roleIds.has(value), `${fileName}.${column} must contain an approver role id`);
}

async function writeCheckedRow(
  writer: CsvWriter,
  fileName: string,
  row: CsvRow,
  personaNames: string[],
  roleIds: Set<string>,
): Promise<void> {
  checkNoPersonaName(fileName, row, personaNames);
  for (const column of ['approvedByRole', 'requiredApproverRole', 'secondaryApproverRole', 'approverRole', 'proposedByRole']) {
    assertRoleColumn(row, column, roleIds, fileName);
  }
  await writer.writeRow(row);
}

async function writeTable(
  results: GenerationResult[],
  fileName: string,
  columns: string[],
  rows: CsvRow[],
  personaNames: string[],
  roleIds: Set<string>,
): Promise<void> {
  const writer = await openCsv(`fabric-sql/${fileName}`, columns);
  for (const row of rows) await writeCheckedRow(writer, fileName, row, personaNames, roleIds);
  results.push({ file: `fabric-sql/${fileName}`, rows: await writer.close() });
}

function assertMember(value: string | null | undefined, values: Set<string>, label: string): void {
  if (value === null || value === undefined || value === '') return;
  assertCondition(values.has(value), `Missing parent for ${label}: ${value}`);
}

function buildMaintenanceWindows(
  scenario: ScenarioRecord,
  lines: ScenarioRecord[],
  operatingDays: number[],
): CsvRow[] {
  const maintenance = asRecord(scenario.maintenance, 'maintenance');
  const rows: CsvRow[] = [
    {
      maintenanceWindowId: maintenance.maintenanceWindowId,
      lineId: maintenance.lineId,
      maintenanceType: maintenance.type,
      originalStartDate: maintenance.originalStart,
      originalEndDate: maintenance.originalEnd,
      durationDays: maintenance.durationDays,
      operatingDaysLost: maintenance.operatingDaysLost,
      deferredStartDate: maintenance.deferredStart,
      deferredEndDate: maintenance.deferredEnd,
      deferralDays: maintenance.deferralDays,
      lastMajorMaintenanceDate: maintenance.lastMajorMaintenance,
      insideCampaignPeriod: maintenance.insideCampaignPeriod,
      deferredOutsideCampaignPeriod: maintenance.deferredOutsideCampaignPeriod,
    },
  ];

  const historyStart = String(scenario.clock.salesHistoryStart);
  const nonConflictLines = lines.filter((line) => line.lineId !== maintenance.lineId);
  for (const [index, line] of nonConflictLines.entries()) {
    const originalStartDate = toDateString(addDays(parseDate(historyStart), 21 + index * 23));
    const durationDays = 2 + (index % 2);
    const originalEndDate = toDateString(addDays(parseDate(originalStartDate), durationDays - 1));
    const deferralDays = 7 + (index % 3);
    const deferredStartDate = toDateString(addDays(parseDate(originalStartDate), deferralDays));
    const deferredEndDate = toDateString(addDays(parseDate(deferredStartDate), durationDays - 1));
    rows.push({
      maintenanceWindowId: `MW-${line.lineId}-${compactDate(originalStartDate).slice(0, 6)}`,
      lineId: line.lineId,
      maintenanceType: index % 2 === 0 ? 'minor_preventive' : 'calibration',
      originalStartDate,
      originalEndDate,
      durationDays,
      operatingDaysLost: countOperatingDays(originalStartDate, originalEndDate, operatingDays),
      deferredStartDate,
      deferredEndDate,
      deferralDays,
      lastMajorMaintenanceDate: toDateString(addDays(parseDate(originalStartDate), -175 - index * 3)),
      insideCampaignPeriod: false,
      deferredOutsideCampaignPeriod: true,
    });
  }
  return rows;
}

function buildHeroVarianceUnits(
  scenario: ScenarioRecord,
  regions: ScenarioRecord[],
  varianceDates: string[],
): Map<string, number> {
  const rng = createRng('fabric-sql:sales-hero-variance');
  const forecast = asRecord(scenario.forecast, 'forecast');
  const out = new Map<string, number>();
  for (const [regionIndex, region] of regions.entries()) {
    const dailyBaselineUnits = Number(region.baselineForecastUnits30d) / Number(forecast.horizonDays);
    const forecastWindowUnits = dailyBaselineUnits * varianceDates.length;
    const targetActualUnits = Math.round(forecastWindowUnits * (1 + Number(region.variancePct) / 100));
    const weights = varianceDates.map((dateString, dateIndex) => {
      const rampPosition = varianceDates.length === 1 ? 1 : dateIndex / (varianceDates.length - 1);
      const upliftShape = region.signalAffected ? 0.7 + rampPosition * 0.6 : 1;
      const upliftFactor = 1 + (Number(region.variancePct) / 100) * upliftShape;
      const weekdayFactor = isOperatingDay(parseDate(dateString), scenario.clock.operatingDays) ? 1.03 : 0.82;
      const rhythm = 0.97 + ((dateIndex + regionIndex * 2) % 5) * 0.015;
      const noise = clamp(1 + rng.normal(0, 0.025), 0.94, 1.06);
      return Math.max(1, dailyBaselineUnits * upliftFactor * weekdayFactor * rhythm * noise);
    });
    const scale = targetActualUnits / sum(weights);
    const dailyUnits = weights.map((value) => Math.max(1, Math.round(value * scale)));
    let correction = targetActualUnits - sum(dailyUnits);
    let cursor = dailyUnits.length - 1;
    let attempts = 0;
    while (correction !== 0) {
      const delta = correction > 0 ? 1 : -1;
      if (dailyUnits[cursor] + delta > 0) {
        dailyUnits[cursor] += delta;
        correction -= delta;
      }
      cursor = cursor === 0 ? dailyUnits.length - 1 : cursor - 1;
      attempts += 1;
      assertCondition(attempts < 100_000, `Unable to correct variance units for ${region.regionId}`);
    }
    for (const [dateIndex, dateString] of varianceDates.entries()) {
      out.set(rowKey(dateString, region.regionId), dailyUnits[dateIndex]);
    }
  }
  return out;
}

function buildDailyDemand(
  scenario: ScenarioRecord,
  regions: ScenarioRecord[],
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  dates: string[],
  varianceDates: string[],
): Map<string, number> {
  const rng = createRng('fabric-sql:sales-demand');
  const forecast = asRecord(scenario.forecast, 'forecast');
  const signal = asRecord(scenario.externalSignal, 'externalSignal');
  const heroVarianceUnits = buildHeroVarianceUnits(scenario, regions, varianceDates);
  const dateIndexByDate = new Map(dates.map((dateString, index) => [dateString, index]));
  const signalStartIndex = dateIndexByDate.get(String(signal.observationPeriodStart)) ?? 0;
  const out = new Map<string, number>();

  for (const dateString of dates) {
    const date = parseDate(dateString);
    const dateIndex = dateIndexByDate.get(dateString) ?? 0;
    const inVarianceWindow = varianceDates.includes(dateString);
    for (const [regionIndex, region] of regions.entries()) {
      for (const [productIndex, product] of products.entries()) {
        if (product.productId === heroProduct.productId && inVarianceWindow) {
          out.set(rowKey(dateString, region.regionId, product.productId), heroVarianceUnits.get(rowKey(dateString, region.regionId)) ?? 0);
          continue;
        }

        const factor = productDemandFactor(product, productIndex, heroProduct);
        const dailyBaselineUnits = (Number(region.baselineForecastUnits30d) * factor) / Number(forecast.horizonDays);
        const afterSignal = dateString >= String(signal.observationPeriodStart);
        let signalFactor = 1;
        if (afterSignal && region.signalAffected && product.category === heroProduct.category) {
          const ramp = clamp((dateIndex - signalStartIndex + 1) / 70, 0, 1);
          const productSensitivity = product.productId === heroProduct.productId ? 0.85 : 0.22;
          signalFactor += (Number(region.variancePct) / 100) * productSensitivity * ramp;
        } else if (afterSignal && product.productId === heroProduct.productId) {
          signalFactor += (Number(region.variancePct) / 100) * 0.35;
        }
        const weekdayFactor = isOperatingDay(date, scenario.clock.operatingDays)
          ? 0.93 + ((dateIndex + regionIndex + productIndex) % 6) * 0.026
          : 0.62;
        const historySeason = 0.96 + (((dateIndex + productIndex * 5 + regionIndex * 3) % 23) / 22) * 0.08;
        const noise = clamp(1 + rng.normal(0, product.productId === heroProduct.productId ? 0.025 : 0.05), 0.85, 1.15);
        out.set(
          rowKey(dateString, region.regionId, product.productId),
          Math.max(1, Math.round(dailyBaselineUnits * signalFactor * weekdayFactor * historySeason * noise)),
        );
      }
    }
  }
  return out;
}

function buildForecastLines(
  scenario: ScenarioRecord,
  regions: ScenarioRecord[],
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  forecastVersions: CsvRow[],
): CsvRow[] {
  const rows: CsvRow[] = [];
  const forecast = asRecord(scenario.forecast, 'forecast');
  for (const version of forecastVersions) {
    for (const region of regions) {
      for (const [productIndex, product] of products.entries()) {
        const baselineUnits = Math.round(Number(region.baselineForecastUnits30d) * productDemandFactor(product, productIndex, heroProduct));
        const signalSensitive = product.category === heroProduct.category;
        const revisedMultiplier =
          version.versionType === 'revised' && signalSensitive
            ? 1 + (Number(region.variancePct) / 100) * (product.productId === heroProduct.productId ? 1 : 0.25)
            : 1;
        rows.push({
          forecastVersionId: version.forecastVersionId,
          regionId: region.regionId,
          productId: product.productId,
          forecastUnits: Math.max(1, Math.round(baselineUnits * revisedMultiplier)),
          horizonDays: forecast.horizonDays,
        });
      }
    }
  }
  return rows;
}

function buildScenarioRegionAllocations(
  scenarios: ScenarioRecord[],
  affectedRegions: ScenarioRecord[],
  unitPriceUsd: number,
): CsvRow[] {
  const rows: CsvRow[] = [];
  const weights = affectedRegions.map((region) => Number(region.incrementalUnits));
  for (const scenario of scenarios) {
    const allocations = allocateIntegers(Number(scenario.incrementalUnits), weights);
    const budgetCents = allocateIntegers(Math.round(Number(scenario.incrementalBudgetUsd) * 100), weights);
    for (const [index, region] of affectedRegions.entries()) {
      rows.push({
        scenarioId: scenario.scenarioId,
        regionId: region.regionId,
        allocationUnits: allocations[index],
        allocationRevenueUsd: round(allocations[index] * unitPriceUsd, 2),
        allocationBudgetUsd: round(budgetCents[index] / 100, 2),
        impactWeight: round(weights[index] / sum(weights), 6),
      });
    }
  }
  return rows;
}

function buildMaintenancePolicyEvaluations(
  scenario: ScenarioRecord,
  options: ScenarioRecord[],
  maintenancePolicy: ScenarioRecord,
): CsvRow[] {
  const capacityModel = asRecord(scenario.capacityModel, 'capacityModel');
  const maintenance = asRecord(scenario.maintenance, 'maintenance');
  const stressModel = asRecord(scenario.stressModel, 'stressModel');
  const rows: CsvRow[] = [];
  const daysToOriginalDue =
    Number(stressModel.operatingDaysLastMaintenanceToOriginalDue) -
    Number(stressModel.operatingDaysLastMaintenanceToPlanStart);

  for (const option of options) {
    const sustainedRateFactor = Number(option.requiredRateFactor);
    const permittedDays = permittedDeferralDays(maintenancePolicy, sustainedRateFactor);
    const requestsDeferral = /defer|postpone/i.test(`${option.name} ${option.summary}`);
    const requestedDeferralDays = requestsDeferral ? Number(maintenance.deferralDays) : 0;
    const producingHoursPerDay = Number(capacityModel.scheduledHoursPerDay) * Number(option.requiredUtilisation);
    const stressPerOperatingDay = round(
      producingHoursPerDay * sustainedRateFactor ** Number(stressModel.rateExponent),
      4,
    );
    const projectedOperatingDays = requestsDeferral
      ? Number(stressModel.operatingDaysPlanStartToDeferredDue)
      : daysToOriginalDue;
    const projectedStressIndex = round(
      Number(stressModel.cumulativeAtPlanStart) + stressPerOperatingDay * projectedOperatingDays,
      4,
    );
    const projectedStressPctOfThreshold = round(
      (projectedStressIndex / Number(stressModel.thresholdStressIndex)) * 100,
      2,
    );
    const withinStressCeiling = projectedStressPctOfThreshold <= Number(stressModel.stressCeilingPct) + 1e-9;
    rows.push({
      optionId: option.optionId,
      policyId: maintenancePolicy.policyId,
      policyVersion: maintenancePolicy.version,
      sustainedRateFactor,
      requiredUtilisation: option.requiredUtilisation,
      requestedDeferralDays,
      permittedDeferralDays: permittedDays,
      projectedStressIndex,
      projectedStressPctOfThreshold,
      stressCeilingPct: stressModel.stressCeilingPct,
      withinStressCeiling,
      policyPass: requestedDeferralDays <= permittedDays && withinStressCeiling,
    });
  }
  return rows;
}

function validateMaintenancePolicyEvaluations(
  scenario: ScenarioRecord,
  evaluations: CsvRow[],
  options: ScenarioRecord[],
): void {
  const maintenance = asRecord(scenario.maintenance, 'maintenance');
  const stressModel = asRecord(scenario.stressModel, 'stressModel');
  const recommended = options.find((option) => option.optionId === scenario.recommendedOptionId);
  assertCondition(Boolean(recommended), 'Recommended production option not found');
  const recommendedEvaluation = evaluations.find((row) => row.optionId === recommended?.optionId);
  assertCondition(Boolean(recommendedEvaluation), 'Recommended production option policy evaluation not found');
  assertCondition(
    recommendedEvaluation.permittedDeferralDays === maintenance.deferralDays,
    `Recommended option permitted deferral mismatch: ${recommendedEvaluation.permittedDeferralDays}`,
  );
  assertCondition(
    Math.abs(Number(recommendedEvaluation.projectedStressPctOfThreshold) - Number(stressModel.projectedStressPctOfThreshold)) <= 0.01,
    `Recommended option stress mismatch: ${recommendedEvaluation.projectedStressPctOfThreshold}`,
  );
  assertCondition(recommendedEvaluation.withinStressCeiling === true, 'Recommended option must be within stress ceiling');

  const policyBlockedOption = options.find((option) => option.policyCompliant === false);
  assertCondition(Boolean(policyBlockedOption), 'Policy-blocked production option not found');
  const blockedEvaluation = evaluations.find((row) => row.optionId === policyBlockedOption?.optionId);
  assertCondition(Boolean(blockedEvaluation), 'Policy-blocked production option evaluation not found');
  assertCondition(blockedEvaluation.permittedDeferralDays === 0, 'Policy-blocked production option must permit zero deferral days');
  assertCondition(blockedEvaluation.policyPass === false, 'Policy-blocked production option must fail policy evaluation');
}

function buildCapacityPlan(scenario: ScenarioRecord, operatingDates: string[], withOutcome: boolean): CsvRow[] {
  const capacityModel = asRecord(scenario.capacityModel, 'capacityModel');
  const maintenance = asRecord(scenario.maintenance, 'maintenance');
  const commitment = asRecord(scenario.commitment, 'commitment');
  const recommendedOption = asArray(scenario.options, 'options').find((option) => option.optionId === scenario.recommendedOptionId);
  assertCondition(Boolean(recommendedOption), 'Recommended production option not found');
  const rows: CsvRow[] = [];

  for (const dateString of operatingDates) {
    const maintenanceDay = isBetweenDate(dateString, String(maintenance.originalStart), String(maintenance.originalEnd));
    rows.push({
      planVariant: 'baseline',
      planDate: dateString,
      lineId: capacityModel.lineId,
      scheduledHours: capacityModel.scheduledHoursPerDay,
      utilisation: capacityModel.baselineUtilisation,
      rateFactor: capacityModel.baselineRateFactor,
      plannedUnits: capacityModel.baselineUnitsPerOperatingDay,
      isMaintenanceDay: maintenanceDay,
      maintenanceWindowId: maintenanceDay ? maintenance.maintenanceWindowId : null,
      optionId: null,
      commitmentId: withOutcome ? commitment.commitmentId : null,
      existingCommittedUnits: capacityModel.existingCommittedUnitsInCampaign,
      campaignCommitmentUnits: commitment.committedUnits,
    });
  }

  for (const dateString of operatingDates) {
    rows.push({
      planVariant: 'approved',
      planDate: dateString,
      lineId: capacityModel.lineId,
      scheduledHours: capacityModel.scheduledHoursPerDay,
      utilisation: capacityModel.planUtilisation,
      rateFactor: capacityModel.planRateFactor,
      plannedUnits: capacityModel.planUnitsPerOperatingDay,
      isMaintenanceDay: false,
      maintenanceWindowId: null,
      optionId: recommendedOption?.optionId,
      commitmentId: withOutcome ? commitment.commitmentId : null,
      existingCommittedUnits: capacityModel.existingCommittedUnitsInCampaign,
      campaignCommitmentUnits: commitment.committedUnits,
    });
  }

  return rows;
}

function validateCapacityPlan(scenario: ScenarioRecord, rows: CsvRow[]): void {
  const expected = asRecord(scenario.capacityModel?.expected, 'capacityModel.expected');
  const recommendedOption = asArray(scenario.options, 'options').find((option) => option.optionId === scenario.recommendedOptionId);
  assertCondition(Boolean(recommendedOption), 'Recommended production option not found');
  const baselineRows = rows.filter((row) => row.planVariant === 'baseline');
  const approvedRows = rows.filter((row) => row.planVariant === 'approved');
  const baselineIncludingMaintenance = sum(baselineRows.map((row) => Number(row.plannedUnits)));
  const baselineExcludingMaintenance = sum(
    baselineRows.filter((row) => row.isMaintenanceDay !== true).map((row) => Number(row.plannedUnits)),
  );
  const approvedTotal = sum(approvedRows.map((row) => Number(row.plannedUnits)));
  assertCondition(
    baselineIncludingMaintenance === expected.capacityWithoutMaintenanceUnits,
    `Baseline capacity without maintenance mismatch: ${baselineIncludingMaintenance}`,
  );
  assertCondition(
    baselineExcludingMaintenance === expected.capacityWithMaintenanceUnits,
    `Baseline capacity with maintenance mismatch: ${baselineExcludingMaintenance}`,
  );
  assertCondition(
    approvedTotal === recommendedOption?.expectedOutputUnits,
    `Approved capacity mismatch: ${approvedTotal}`,
  );
}

function buildProductionOptions(options: ScenarioRecord[], recommendedOptionId: string): CsvRow[] {
  return options.map((option) => ({
    optionId: option.optionId,
    optionName: option.name,
    summary: option.summary,
    requiredRateFactor: option.requiredRateFactor,
    requiredUtilisation: option.requiredUtilisation,
    appliesFromDate: option.appliesFrom ?? null,
    appliesToDate: option.appliesTo ?? null,
    alternateLineId: option.alternateLineId ?? null,
    expectedOutputUnits: option.expectedOutputUnits,
    availableIncrementalUnits: option.availableIncrementalUnits,
    incrementalUnitsDelivered: option.incrementalUnitsDelivered,
    meetsCommitment: option.meetsCommitment,
    shortfallUnits: option.shortfallUnits,
    effectOnExistingOrders: option.effectOnExistingOrders,
    materialsConstraint: option.materialsConstraint,
    riskLevel: option.riskLevel,
    confidence: option.confidence,
    requiredApproverRole: option.requiredApproverRole,
    secondaryApproverRole: option.secondaryApproverRole ?? null,
    policyCompliant: option.policyCompliant,
    recommended: option.optionId === recommendedOptionId,
    rejectionReason: option.rejectionReason ?? null,
    policyBasisJson: JSON.stringify(option.policyBasis ?? []),
  }));
}

function buildGovernedActions(
  scenario: ScenarioRecord,
  commercialPolicy: ScenarioRecord,
  capacityPolicy: ScenarioRecord,
): { governedActions: CsvRow[]; actionReceipts: CsvRow[] } {
  const actions = asArray(scenario.actions, 'actions');
  const governedActions: CsvRow[] = [];
  const actionReceipts: CsvRow[] = [];
  for (const action of actions) {
    let policyId = action.details?.policyId;
    let policyVersion = action.details?.policyVersion;
    if (!policyId && action.details?.commitmentId) {
      policyId = commercialPolicy.policyId;
      policyVersion = commercialPolicy.version;
    }
    if (!policyId && action.details?.optionId && action.details?.lineId) {
      policyId = capacityPolicy.policyId;
      policyVersion = capacityPolicy.version;
    }
    assertCondition(Boolean(policyId) && Boolean(policyVersion), `No policy mapping for action ${action.actionId}`);
    const outcome = `${action.status}:${action.result}`;
    governedActions.push({
      actionId: action.actionId,
      actionType: action.type,
      apiName: action.api,
      requestedAt: action.requestedAt,
      approvedAt: action.approvedAt,
      executedAt: action.executedAt,
      approvedByRole: action.approvedByRole,
      policyId,
      policyVersion,
      receiptId: action.receiptId,
      status: action.status,
      result: action.result,
      detailsJson: JSON.stringify(action.details ?? {}),
    });
    actionReceipts.push({
      receiptId: action.receiptId,
      actionId: action.actionId,
      issuedAt: action.executedAt,
      approverRole: action.approvedByRole,
      policyId,
      policyVersion,
      outcome,
      receiptPayloadJson: JSON.stringify({
        actionId: action.actionId,
        api: action.api,
        result: action.result,
        details: action.details ?? {},
      }),
    });
  }
  return { governedActions, actionReceipts };
}

function maintenanceWindowForDate(windows: CsvRow[], lineId: string, dateString: string): string | null {
  const window = windows.find(
    (row) =>
      row.lineId === lineId &&
      isBetweenDate(dateString, String(row.originalStartDate), String(row.originalEndDate)),
  );
  return typeof window?.maintenanceWindowId === 'string' ? window.maintenanceWindowId : null;
}

function productForLine(
  line: ScenarioRecord,
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  rng: Rng,
): ScenarioRecord {
  const sunCareProducts = products.filter((product) => product.category === heroProduct.category);
  const lineFamilyProducts = products.filter((product) => product.category === line.family);
  const controlledProducts = products.filter((product) => product.handlingClass === 'controlled');
  if (line.preferredForHeroProduct && rng.bool(0.45)) return heroProduct;
  if (line.sunCareQualified && rng.bool(0.72)) return rng.pick(sunCareProducts);
  if (lineFamilyProducts.length > 0 && rng.bool(0.7)) return rng.pick(lineFamilyProducts);
  if (controlledProducts.length > 0 && rng.bool(0.2)) return rng.pick(controlledProducts);
  return rng.pick(products);
}

function buildProductionOrders(
  scenario: ScenarioRecord,
  lines: ScenarioRecord[],
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  maintenanceWindows: CsvRow[],
  operatingDates: string[],
  withOutcome: boolean,
): { rows: CsvRow[]; orderInfos: ProductionOrderInfo[] } {
  const rng = createRng('fabric-sql:production-orders');
  const snapshotDate = asOfDate(scenario);
  const capacityModel = asRecord(scenario.capacityModel, 'capacityModel');
  const commitment = asRecord(scenario.commitment, 'commitment');
  const campaignDates = eachDate(scenario.clock.campaignStart, scenario.clock.campaignEnd)
    .map(toDateString)
    .filter((dateString) => isOperatingDay(parseDate(dateString), scenario.clock.operatingDays));
  const commitmentWeights = campaignDates.map((dateString, index) => {
    const maintenancePenalty = maintenanceWindowForDate(maintenanceWindows, capacityModel.lineId, dateString) ? 0.9 : 1;
    return maintenancePenalty * (1 + (index % 6) * 0.02);
  });
  const commitmentUnitsByDate = new Map(
    campaignDates.map((dateString, index) => [
      dateString,
      allocateIntegers(Number(commitment.committedUnits), commitmentWeights)[index],
    ]),
  );

  const rows: CsvRow[] = [];
  const orderInfos: ProductionOrderInfo[] = [];
  let sequence = 1;
  const nextId = () => `PO-${String(sequence++).padStart(7, '0')}`;

  const lineDayCombos: { dateString: string; line: ScenarioRecord }[] = [];
  for (const dateString of operatingDates) {
    for (const line of lines) lineDayCombos.push({ dateString, line });
  }

  const specialCommitmentRows = campaignDates.length;
  const generalTarget = PRODUCTION_ORDER_TARGET - specialCommitmentRows;
  const minimumPerLineDay = 4;
  const baseRows = minimumPerLineDay * lineDayCombos.length;
  assertCondition(generalTarget >= baseRows, 'Production order target is too small for line-day coverage');
  const generalWeights = lineDayCombos.map(
    ({ line }, index) =>
      Number(line.ratedRateUnitsPerMin) *
      Number(line.scheduledHoursPerDay) *
      (1 + (index % 7) * 0.015),
  );
  const extraRows = allocateIntegers(generalTarget - baseRows, generalWeights);
  let comboIndex = 0;

  for (const { dateString, line } of lineDayCombos) {
    const emitDate = withOutcome || isObservable(scenario, dateString);
    const maintenanceWindowId = maintenanceWindowForDate(maintenanceWindows, String(line.lineId), dateString);
    if (line.lineId === capacityModel.lineId && commitmentUnitsByDate.has(dateString)) {
      const plannedUnits = commitmentUnitsByDate.get(dateString) ?? 0;
      const productionOrderId = nextId();
      if (withOutcome) {
        rows.push({
          productionOrderId,
          lineId: line.lineId,
          productId: heroProduct.productId,
          orderDate: dateString,
          plannedStartDate: dateString,
          plannedEndDate: dateString,
          plannedUnits,
          status: maintenanceWindowId ? 'at_risk_baseline' : 'planned',
          commitmentId: commitment.commitmentId,
          maintenanceWindowId,
        });
      }
      orderInfos.push({ productionOrderId, productId: String(heroProduct.productId), plannedUnits, emit: withOutcome });
    }

    const generalRowsForLineDay = minimumPerLineDay + extraRows[comboIndex];
    comboIndex += 1;
    for (let i = 0; i < generalRowsForLineDay; i++) {
      const product = productForLine(line, products, heroProduct, rng);
      const productionOrderId = nextId();
      const orderCapacity =
        Number(line.ratedRateUnitsPerMin) *
        60 *
        Number(line.scheduledHoursPerDay) *
        Number(line.baselineUtilisation);
      const plannedUnits = Math.max(120, Math.round((orderCapacity / Math.max(1, generalRowsForLineDay)) * rng.float(0.55, 1.28)));
      const row: CsvRow = {
        productionOrderId,
        lineId: line.lineId,
        productId: product.productId,
        orderDate: dateString,
        plannedStartDate: dateString,
        plannedEndDate: dateString,
        plannedUnits,
        status: maintenanceWindowId ? 'maintenance_blocked' : dateString < snapshotDate ? 'completed' : 'planned',
        commitmentId: null,
        maintenanceWindowId,
      };
      if (emitDate) rows.push(row);
      orderInfos.push({ productionOrderId, productId: String(product.productId), plannedUnits, emit: emitDate });
    }
  }

  if (withOutcome) {
    assertCondition(rows.length === PRODUCTION_ORDER_TARGET, `Production order count mismatch: ${rows.length}`);
  } else {
    assertCondition(
      rows.every((row) => isObservable(scenario, String(row.orderDate))),
      'Default production orders must not extend past the as-of date',
    );
  }
  const committedProductionUnits = sum(rows.filter((row) => row.commitmentId === commitment.commitmentId).map((row) => Number(row.plannedUnits)));
  assertCondition(
    withOutcome ? committedProductionUnits === commitment.committedUnits : committedProductionUnits === 0,
    `Commitment production units mismatch: ${committedProductionUnits}`,
  );
  return { rows, orderInfos };
}

function buildMaterialReservations(
  orderInfos: ProductionOrderInfo[],
  products: ScenarioRecord[],
): CsvRow[] {
  const rng = createRng('fabric-sql:material-reservations');
  const productIndexById = new Map(products.map((product, index) => [String(product.productId), index]));
  const materialSkus = [
    { sku: 'MAT-PUMP-CAP', unit: 'each', factor: 1.02 },
    { sku: 'MAT-CARTON', unit: 'each', factor: 1.01 },
    { sku: 'MAT-LABEL', unit: 'each', factor: 1.0 },
    { sku: 'MAT-BULK-CREAM', unit: 'litre', factor: 0.08 },
    { sku: 'MAT-SEAL', unit: 'each', factor: 1.0 },
  ];
  const baseRows = orderInfos.length;
  assertCondition(MATERIAL_RESERVATION_TARGET >= baseRows, 'Material reservation target is too small');
  const extraRows = allocateIntegers(
    MATERIAL_RESERVATION_TARGET - baseRows,
    orderInfos.map((order) => Math.max(1, Math.sqrt(order.plannedUnits))),
  );
  const rows: CsvRow[] = [];
  let sequence = 1;
  for (const [orderIndex, order] of orderInfos.entries()) {
    const reservationCount = 1 + extraRows[orderIndex];
    const productIndex = productIndexById.get(order.productId) ?? 0;
    for (let i = 0; i < reservationCount; i++) {
      const material = materialSkus[(i + productIndex + orderIndex) % materialSkus.length];
      const quantityNoise = clamp(1 + rng.normal(0, 0.015), 0.96, 1.04);
      const row: CsvRow = {
        reservationId: `MR-${String(sequence++).padStart(7, '0')}`,
        productionOrderId: order.productionOrderId,
        materialSku: material.sku,
        requiredQuantity: round(order.plannedUnits * material.factor * quantityNoise, material.unit === 'litre' ? 2 : 0),
        unitOfMeasure: material.unit,
      };
      if (order.emit) rows.push(row);
    }
  }
  if (orderInfos.every((order) => order.emit)) {
    assertCondition(rows.length === MATERIAL_RESERVATION_TARGET, `Material reservation count mismatch: ${rows.length}`);
  }
  return rows;
}

function buildShiftSchedules(
  scenario: ScenarioRecord,
  lines: ScenarioRecord[],
  operatingDates: string[],
  withOutcome: boolean,
): CsvRow[] {
  const capacityModel = asRecord(scenario.capacityModel, 'capacityModel');
  return operatingDates.flatMap((dateString) =>
    lines.map((line) => {
      const useApprovedPlan =
        withOutcome &&
        line.lineId === capacityModel.lineId &&
        isBetweenDate(dateString, String(scenario.clock.campaignStart), String(scenario.clock.campaignEnd));
      return {
        scheduleDate: dateString,
        lineId: line.lineId,
        shiftCount: Number(line.scheduledHoursPerDay) >= 16 ? 2 : 1,
        scheduledHours: line.scheduledHoursPerDay,
        plannedUtilisation: useApprovedPlan ? capacityModel.planUtilisation : line.baselineUtilisation,
      };
    }),
  );
}

async function writeSalesOrderLines(
  results: GenerationResult[],
  scenario: ScenarioRecord,
  regions: ScenarioRecord[],
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  dates: string[],
  varianceDates: string[],
  dailyDemand: Map<string, number>,
  personaNames: string[],
  roleIds: Set<string>,
  withOutcome: boolean,
): Promise<void> {
  const rng = createRng('fabric-sql:sales-order-lines');
  const channels = ['retail', 'ecommerce', 'pharmacy', 'distributor'];
  const combos: {
    dateString: string;
    region: ScenarioRecord;
    product: ScenarioRecord;
    units: number;
  }[] = [];
  for (const dateString of dates) {
    for (const region of regions) {
      for (const product of products) {
        combos.push({
          dateString,
          region,
          product,
          units: dailyDemand.get(rowKey(dateString, region.regionId, product.productId)) ?? 0,
        });
      }
    }
  }
  const minimumRowsPerCombo = 6;
  const baseRows = minimumRowsPerCombo * combos.length;
  assertCondition(SALES_ORDER_LINE_TARGET >= baseRows, 'Sales order target is too small for date-region-product coverage');
  const extras = allocateIntegers(
    SALES_ORDER_LINE_TARGET - baseRows,
    combos.map((combo) => Math.max(1, Math.sqrt(combo.units))),
  );
  const varianceDateSet = new Set(varianceDates);
  const actualHeroUnitsByRegion = new Map(regions.map((region) => [String(region.regionId), 0]));
  const writer = await openCsv('fabric-sql/sales_order_lines.csv', [
    'orderLineId',
    'orderId',
    'lineNumber',
    'orderDate',
    'regionId',
    'productId',
    'units',
    'unitPriceUsd',
    'revenueUsd',
    'channel',
  ]);

  let sequence = 1;
  let maxWrittenDate = '';
  for (const [comboIndex, combo] of combos.entries()) {
    const rowCount = minimumRowsPerCombo + extras[comboIndex];
    const emitDate = withOutcome || isObservable(scenario, combo.dateString);
    if (!emitDate) continue;
    assertCondition(combo.units >= rowCount, `Demand too low to create positive sales lines for ${combo.dateString}`);
    const unitAllocations = allocateIntegers(
      combo.units,
      Array.from({ length: rowCount }, (_, index) => clamp(1 + rng.normal(0, 0.32) + (index % 3) * 0.04, 0.2, 2.2)),
    );
    for (let index = 0; index < rowCount; index++) {
      const units = unitAllocations[index];
      assertCondition(units > 0, `Non-positive sales units for ${combo.dateString}`);
      const orderLineId = `SOL-${String(sequence).padStart(9, '0')}`;
      const row: CsvRow = {
        orderLineId,
        orderId: `SO-${compactDate(combo.dateString)}-${String(sequence).padStart(9, '0')}`,
        lineNumber: 1,
        orderDate: combo.dateString,
        regionId: combo.region.regionId,
        productId: combo.product.productId,
        units,
        unitPriceUsd: combo.product.unitPriceUsd,
        revenueUsd: round(units * Number(combo.product.unitPriceUsd), 2),
        channel: rng.pick(channels),
      };
      await writeCheckedRow(writer, 'sales_order_lines.csv', row, personaNames, roleIds);
      maxWrittenDate = combo.dateString;
      if (combo.product.productId === heroProduct.productId && varianceDateSet.has(combo.dateString)) {
        actualHeroUnitsByRegion.set(
          String(combo.region.regionId),
          (actualHeroUnitsByRegion.get(String(combo.region.regionId)) ?? 0) + units,
        );
      }
      sequence += 1;
    }
  }
  results.push({ file: 'fabric-sql/sales_order_lines.csv', rows: await writer.close() });
  if (withOutcome) {
    assertCondition(sequence - 1 === SALES_ORDER_LINE_TARGET, `Sales row count mismatch: ${sequence - 1}`);
  } else {
    assertCondition(maxWrittenDate <= asOfDate(scenario), `Sales order lines extend past the as-of date: ${maxWrittenDate}`);
  }

  const horizonDays = Number(scenario.forecast.horizonDays);
  for (const region of regions) {
    const forecastUnits = (Number(region.baselineForecastUnits30d) / horizonDays) * varianceDates.length;
    const actualUnits = actualHeroUnitsByRegion.get(String(region.regionId)) ?? 0;
    const variancePct = ((actualUnits - forecastUnits) / forecastUnits) * 100;
    if (Math.abs(variancePct - Number(region.variancePct)) > 0.15) {
      throw new Error(
        `Hero variance mismatch for ${region.regionId}: expected ${region.variancePct}, actual ${round(variancePct, 4)}`,
      );
    }
  }
}

async function writeInventoryPositions(
  results: GenerationResult[],
  scenario: ScenarioRecord,
  regions: ScenarioRecord[],
  products: ScenarioRecord[],
  heroProduct: ScenarioRecord,
  dates: string[],
  dailyDemand: Map<string, number>,
  personaNames: string[],
  roleIds: Set<string>,
  withOutcome: boolean,
): Promise<void> {
  const rng = createRng('fabric-sql:inventory-positions');
  const writer = await openCsv('fabric-sql/inventory_positions.csv', [
    'snapshotDate',
    'regionId',
    'productId',
    'availableUnits',
    'reservedUnits',
    'coverageDays',
  ]);
  let maxWrittenDate = '';
  for (const dateString of dates) {
    if (!withOutcome && !isObservable(scenario, dateString)) continue;
    for (const [regionIndex, region] of regions.entries()) {
      for (const [productIndex, product] of products.entries()) {
        const dailyUnits = dailyDemand.get(rowKey(dateString, region.regionId, product.productId)) ?? 1;
        const signalPressure =
          product.productId === heroProduct.productId && region.signalAffected && dateString >= String(scenario.externalSignal.observationPeriodStart)
            ? 0.78
            : 1;
        const coverageTarget = clamp(
          (18 + ((regionIndex + productIndex) % 8) * 1.4) * signalPressure + rng.normal(0, 0.55),
          8,
          32,
        );
        const netAvailableUnits = Math.max(1, Math.round(dailyUnits * coverageTarget));
        const reservedUnits = Math.round(netAvailableUnits * clamp(0.16 + rng.normal(0, 0.025), 0.08, 0.26));
        const availableUnits = netAvailableUnits + reservedUnits;
        await writeCheckedRow(
          writer,
          'inventory_positions.csv',
          {
            snapshotDate: dateString,
            regionId: region.regionId,
            productId: product.productId,
            availableUnits,
            reservedUnits,
            coverageDays: round((availableUnits - reservedUnits) / Math.max(1, dailyUnits), 2),
          },
          personaNames,
          roleIds,
        );
        maxWrittenDate = dateString;
      }
    }
  }
  if (!withOutcome) {
    assertCondition(maxWrittenDate <= asOfDate(scenario), `Inventory positions extend past the as-of date: ${maxWrittenDate}`);
  }
  results.push({ file: 'fabric-sql/inventory_positions.csv', rows: await writer.close() });
}

function validateForeignKeys(
  rowsByFile: Map<string, CsvRow[]>,
  sets: {
    regionIds: Set<string>;
    productIds: Set<string>;
    launchPlanIds: Set<string>;
    campaignScenarioIds: Set<string>;
    commitmentIds: Set<string>;
    signalIds: Set<string>;
    plantIds: Set<string>;
    lineIds: Set<string>;
    forecastVersionIds: Set<string>;
    optionIds: Set<string>;
    policyKeys: Set<string>;
    maintenanceWindowIds: Set<string>;
    actionIds: Set<string>;
  },
): void {
  for (const row of rowsByFile.get('campaigns.csv') ?? []) {
    assertMember(String(row.regionId), sets.regionIds, 'campaigns.regionId');
    assertMember(String(row.productId), sets.productIds, 'campaigns.productId');
    assertMember(String(row.launchPlanId), sets.launchPlanIds, 'campaigns.launchPlanId');
  }
  for (const row of rowsByFile.get('production_lines.csv') ?? []) assertMember(String(row.plantId), sets.plantIds, 'production_lines.plantId');
  for (const row of rowsByFile.get('signal_region_impact.csv') ?? []) {
    assertMember(String(row.signalId), sets.signalIds, 'signal_region_impact.signalId');
    assertMember(String(row.regionId), sets.regionIds, 'signal_region_impact.regionId');
  }
  for (const row of rowsByFile.get('forecast_assumptions.csv') ?? []) {
    assertMember(String(row.forecastVersionId), sets.forecastVersionIds, 'forecast_assumptions.forecastVersionId');
    assertMember(row.invalidatedBySignalId as string | null, sets.signalIds, 'forecast_assumptions.invalidatedBySignalId');
  }
  for (const row of rowsByFile.get('forecast_lines.csv') ?? []) {
    assertMember(String(row.forecastVersionId), sets.forecastVersionIds, 'forecast_lines.forecastVersionId');
    assertMember(String(row.regionId), sets.regionIds, 'forecast_lines.regionId');
    assertMember(String(row.productId), sets.productIds, 'forecast_lines.productId');
  }
  for (const row of rowsByFile.get('scenario_region_allocation.csv') ?? []) {
    assertMember(String(row.scenarioId), sets.campaignScenarioIds, 'scenario_region_allocation.scenarioId');
    assertMember(String(row.regionId), sets.regionIds, 'scenario_region_allocation.regionId');
  }
  for (const row of rowsByFile.get('campaign_commitments.csv') ?? []) {
    assertMember(String(row.scenarioId), sets.campaignScenarioIds, 'campaign_commitments.scenarioId');
    assertMember(String(row.launchPlanId), sets.launchPlanIds, 'campaign_commitments.launchPlanId');
    assertMember(String(row.productId), sets.productIds, 'campaign_commitments.productId');
    assertMember(String(row.originSignalId), sets.signalIds, 'campaign_commitments.originSignalId');
  }
  for (const row of rowsByFile.get('maintenance_windows.csv') ?? []) assertMember(String(row.lineId), sets.lineIds, 'maintenance_windows.lineId');
  for (const row of rowsByFile.get('production_options.csv') ?? []) assertMember(row.alternateLineId as string | null, sets.lineIds, 'production_options.alternateLineId');
  for (const row of rowsByFile.get('maintenance_policy_evaluations.csv') ?? []) {
    assertMember(String(row.optionId), sets.optionIds, 'maintenance_policy_evaluations.optionId');
    assertMember(`${row.policyId}:${row.policyVersion}`, sets.policyKeys, 'maintenance_policy_evaluations.policyId/policyVersion');
  }
  for (const row of rowsByFile.get('governed_actions.csv') ?? []) {
    assertMember(`${row.policyId}:${row.policyVersion}`, sets.policyKeys, 'governed_actions.policyId/policyVersion');
  }
  for (const row of rowsByFile.get('action_receipts.csv') ?? []) {
    assertMember(String(row.actionId), sets.actionIds, 'action_receipts.actionId');
    assertMember(`${row.policyId}:${row.policyVersion}`, sets.policyKeys, 'action_receipts.policyId/policyVersion');
  }
  for (const row of rowsByFile.get('capacity_plan.csv') ?? []) {
    assertMember(String(row.lineId), sets.lineIds, 'capacity_plan.lineId');
    assertMember(row.maintenanceWindowId as string | null, sets.maintenanceWindowIds, 'capacity_plan.maintenanceWindowId');
    assertMember(row.optionId as string | null, sets.optionIds, 'capacity_plan.optionId');
    assertMember(row.commitmentId as string | null, sets.commitmentIds, 'capacity_plan.commitmentId');
  }
  for (const row of rowsByFile.get('production_orders.csv') ?? []) {
    assertMember(String(row.lineId), sets.lineIds, 'production_orders.lineId');
    assertMember(String(row.productId), sets.productIds, 'production_orders.productId');
    assertMember(row.commitmentId as string | null, sets.commitmentIds, 'production_orders.commitmentId');
    assertMember(row.maintenanceWindowId as string | null, sets.maintenanceWindowIds, 'production_orders.maintenanceWindowId');
  }
}

export async function generateFabricSql(): Promise<GenerationResult[]> {
  const scenario = await loadScenario();
  const withOutcome = includeOutcomeSlice();
  const results: GenerationResult[] = [];
  const rowsByFile = new Map<string, CsvRow[]>();

  const regions = asArray(scenario.regions, 'regions');
  const products = asArray(scenario.products, 'products');
  const personas = asArray(scenario.personas, 'personas');
  const campaigns = asArray(scenario.campaigns, 'campaigns');
  const plants = asArray(scenario.plants, 'plants');
  const lines = asArray(scenario.productionLines, 'productionLines');
  const options = asArray(scenario.options, 'options');
  const policies = asArray(scenario.policies, 'policies');
  const metrics = asArray(scenario.metrics, 'metrics');
  const scenarios = asArray(scenario.scenarios, 'scenarios');
  const launchPlan = asRecord(scenario.launchPlan, 'launchPlan');
  const forecast = asRecord(scenario.forecast, 'forecast');
  const externalSignal = asRecord(scenario.externalSignal, 'externalSignal');
  const commitment = asRecord(scenario.commitment, 'commitment');
  const campaignCommitmentRows: CsvRow[] = withOutcome
    ? [
        {
          commitmentId: commitment.commitmentId,
          scenarioId: commitment.scenarioId,
          launchPlanId: commitment.launchPlanId,
          productId: commitment.productId,
          committedUnits: commitment.committedUnits,
          committedRevenueUsd: commitment.committedRevenueUsd,
          approvedByRole: commitment.approvedByRole,
          approvedAt: commitment.approvedAt,
          status: commitment.status,
          originSignalId: commitment.originSignalId,
          originCaseId: commitment.originCaseId,
        },
      ]
    : [];
  const roleIds = new Set(asArray<string>(scenario.approverRoles, 'approverRoles'));
  const personaNames = personas.map((persona) => String(persona.displayName).toLowerCase());
  const heroProduct = products.find((product) => product.productId === scenario.heroProductId);
  assertCondition(Boolean(heroProduct), 'Hero product not found');

  const regionIds = new Set(regions.map((region) => String(region.regionId)));
  const productIds = new Set(products.map((product) => String(product.productId)));
  const launchPlanIds = new Set([String(launchPlan.launchPlanId)]);
  const plantIds = new Set(plants.map((plant) => String(plant.plantId)));
  const lineIds = new Set(lines.map((line) => String(line.lineId)));
  const signalIds = new Set([String(externalSignal.signalId)]);
  const optionIds = new Set(options.map((option) => String(option.optionId)));
  const campaignScenarioIds = new Set(scenarios.map((scenarioRow) => String(scenarioRow.scenarioId)));
  const commitmentIds = new Set(campaignCommitmentRows.map((row) => String(row.commitmentId)));
  const policyKeys = new Set(policies.map((policy) => `${policy.policyId}:${policy.version}`));

  const maintenancePolicy = policies.find((policy) => Array.isArray(policy.rule?.deferralTable));
  const commercialPolicy = policies.find((policy) => policy.rule?.maxIncrementalBudgetUsdWithoutBoardApproval !== undefined);
  const capacityPolicy = policies.find((policy) => policy.rule?.maxSustainedUtilisation !== undefined);
  assertCondition(Boolean(maintenancePolicy), 'Maintenance deferral policy not found');
  assertCondition(Boolean(commercialPolicy), 'Commercial authority policy not found');
  assertCondition(Boolean(capacityPolicy), 'Capacity utilisation policy not found');

  const allDates = eachDate(scenario.clock.salesHistoryStart, scenario.clock.campaignEnd).map(toDateString);
  const varianceDates = eachDate(scenario.clock.varianceWindowStart, scenario.clock.varianceWindowEnd).map(toDateString);
  const campaignOperatingDates = eachDate(scenario.clock.campaignStart, scenario.clock.campaignEnd)
    .map(toDateString)
    .filter((dateString) => isOperatingDay(parseDate(dateString), scenario.clock.operatingDays));
  assertCondition(
    campaignOperatingDates.length === Number(scenario.clock.campaignOperatingDays),
    `Campaign operating day mismatch: ${campaignOperatingDates.length}`,
  );
  const operatingDates = allDates.filter((dateString) => isOperatingDay(parseDate(dateString), scenario.clock.operatingDays));

  const baselineFallbackVersionId = deriveForecastVersionId(String(forecast.baselineForecastDate), String(heroProduct?.productId));
  const baselineForecastVersionId = getBaselineForecastVersionId(scenario, baselineFallbackVersionId);
  const revisedForecastVersionId = deriveForecastVersionId(String(forecast.revisedForecastDate), String(heroProduct?.productId));
  const forecastVersions: CsvRow[] = [
    {
      forecastVersionId: baselineForecastVersionId,
      versionName: forecast.baselineVersion,
      versionType: 'baseline',
      forecastDate: forecast.baselineForecastDate,
      productId: heroProduct?.productId,
      horizonDays: forecast.horizonDays,
      analysisWindowStartDate: scenario.clock.varianceWindowStart,
      analysisWindowEndDate: scenario.clock.varianceWindowEnd,
    },
    {
      forecastVersionId: revisedForecastVersionId,
      versionName: forecast.revisedVersion,
      versionType: 'revised',
      forecastDate: forecast.revisedForecastDate,
      productId: heroProduct?.productId,
      horizonDays: forecast.horizonDays,
      analysisWindowStartDate: scenario.clock.varianceWindowStart,
      analysisWindowEndDate: scenario.clock.varianceWindowEnd,
    },
  ].filter((version) => withOutcome || isObservable(scenario, String(version.forecastDate)));
  const forecastVersionIds = new Set(forecastVersions.map((row) => String(row.forecastVersionId)));

  const maintenanceWindows = buildMaintenanceWindows(scenario, lines, scenario.clock.operatingDays);
  const maintenanceWindowIds = new Set(maintenanceWindows.map((row) => String(row.maintenanceWindowId)));
  const affectedRegions = regions.filter((region) => region.signalAffected === true);
  const totalAffectedIncrementalUnits = sum(affectedRegions.map((region) => Number(region.incrementalUnits)));
  assertCondition(totalAffectedIncrementalUnits === Number(scenario.opportunity.incrementalUnits), 'Affected regional incremental units do not match opportunity');

  const tables: { fileName: string; columns: string[]; rows: CsvRow[] }[] = [];
  tables.push({
    fileName: 'regions.csv',
    columns: ['regionId', 'regionName', 'marketCode', 'signalAffected', 'baselineForecastUnits30d', 'variancePct', 'incrementalUnits'],
    rows: regions.map((region) => ({
      regionId: region.regionId,
      regionName: region.name,
      marketCode: region.marketCode,
      signalAffected: region.signalAffected,
      baselineForecastUnits30d: region.baselineForecastUnits30d,
      variancePct: region.variancePct,
      incrementalUnits: region.incrementalUnits,
    })),
  });
  tables.push({
    fileName: 'products.csv',
    columns: ['productId', 'productName', 'category', 'handlingClass', 'unitPriceUsd', 'hero'],
    rows: products.map((product) => ({
      productId: product.productId,
      productName: product.name,
      category: product.category,
      handlingClass: product.handlingClass,
      unitPriceUsd: product.unitPriceUsd,
      hero: product.hero,
    })),
  });
  tables.push({
    fileName: 'launch_plans.csv',
    columns: ['launchPlanId', 'planName', 'status', 'startsOn', 'endsOn'],
    rows: [
      {
        launchPlanId: launchPlan.launchPlanId,
        planName: launchPlan.name,
        status: launchPlan.status,
        startsOn: launchPlan.startsOn,
        endsOn: launchPlan.endsOn,
      },
    ],
  });
  tables.push({
    fileName: 'plants.csv',
    columns: ['plantId', 'plantName', 'regionCode'],
    rows: plants.map((plant) => ({
      plantId: plant.plantId,
      plantName: plant.name,
      regionCode: plant.regionCode,
    })),
  });
  tables.push({
    fileName: 'personas.csv',
    columns: ['personaId', 'displayName', 'title', 'roleId'],
    rows: personas.map((persona) => ({
      personaId: persona.personaId,
      displayName: persona.displayName,
      title: persona.title,
      roleId: persona.roleId,
    })),
  });
  tables.push({
    fileName: 'external_signals.csv',
    columns: [
      'signalId',
      'signalName',
      'signalType',
      'provenance',
      'sourceLabel',
      'observationPeriodStart',
      'observationPeriodEnd',
      'persistenceThrough',
      'persistenceProbability',
      'confidence',
      'seaSurfaceAnomalyC',
    ],
    rows: [
      {
        signalId: externalSignal.signalId,
        signalName: externalSignal.name,
        signalType: externalSignal.signalType,
        provenance: externalSignal.provenance,
        sourceLabel: externalSignal.sourceLabel,
        observationPeriodStart: externalSignal.observationPeriodStart,
        observationPeriodEnd: externalSignal.observationPeriodEnd,
        persistenceThrough: externalSignal.persistenceThrough,
        persistenceProbability: externalSignal.persistenceProbability,
        confidence: externalSignal.confidence,
        seaSurfaceAnomalyC: externalSignal.seaSurfaceAnomalyC,
      },
    ],
  });
  tables.push({
    fileName: 'approved_policies.csv',
    columns: ['policyId', 'policyVersion', 'policyName', 'status', 'effectiveFrom', 'ruleJson'],
    rows: policies.map((policy) => ({
      policyId: policy.policyId,
      policyVersion: policy.version,
      policyName: policy.name,
      status: policy.status,
      effectiveFrom: policy.effectiveFrom,
      ruleJson: JSON.stringify(policy.rule),
    })),
  });
  tables.push({
    fileName: 'metric_definitions.csv',
    columns: ['metricId', 'metricVersion', 'metricName', 'status', 'definitionJson'],
    rows: metrics.map((metric) => ({
      metricId: metric.metricId,
      metricVersion: metric.version,
      metricName: metric.name,
      status: metric.status,
      definitionJson: JSON.stringify({ expression: metric.expression }),
    })),
  });
  tables.push({
    fileName: 'campaigns.csv',
    columns: ['campaignId', 'launchPlanId', 'regionId', 'productId', 'campaignName', 'channel', 'status', 'baseBudgetUsd', 'incrementalBudgetUsd'],
    rows: campaigns.map((campaign) => ({
      campaignId: campaign.campaignId,
      launchPlanId: launchPlan.launchPlanId,
      regionId: campaign.regionId,
      productId: heroProduct?.productId,
      campaignName: campaign.name,
      channel: campaign.channel,
      status: launchPlan.status,
      baseBudgetUsd: campaign.baseBudgetUsd,
      incrementalBudgetUsd: withOutcome ? campaign.incrementalBudgetUsd : 0,
    })),
  });
  tables.push({
    fileName: 'production_lines.csv',
    columns: [
      'lineId',
      'plantId',
      'lineName',
      'family',
      'ratedRateUnitsPerMin',
      'scheduledHoursPerDay',
      'baselineUtilisation',
      'status',
      'sunCareQualified',
      'preferredForHeroProduct',
      'alternateLineForHeroProduct',
      'requiresQualification',
    ],
    rows: lines.map((line) => ({
      lineId: line.lineId,
      plantId: line.plantId,
      lineName: line.name,
      family: line.family,
      ratedRateUnitsPerMin: line.ratedRateUnitsPerMin,
      scheduledHoursPerDay: line.scheduledHoursPerDay,
      baselineUtilisation: line.baselineUtilisation,
      status: line.status,
      sunCareQualified: line.sunCareQualified,
      preferredForHeroProduct: line.preferredForHeroProduct ?? false,
      alternateLineForHeroProduct: line.alternateLineForHeroProduct ?? false,
      requiresQualification: line.requiresQualification ?? false,
    })),
  });
  tables.push({
    fileName: 'signal_region_impact.csv',
    columns: ['signalId', 'regionId', 'impactWeight', 'variancePct', 'incrementalUnits'],
    rows: affectedRegions.map((region) => ({
      signalId: externalSignal.signalId,
      regionId: region.regionId,
      impactWeight: round(Number(region.incrementalUnits) / totalAffectedIncrementalUnits, 6),
      variancePct: region.variancePct,
      incrementalUnits: region.incrementalUnits,
    })),
  });
  tables.push({
    fileName: 'forecast_versions.csv',
    columns: ['forecastVersionId', 'versionName', 'versionType', 'forecastDate', 'productId', 'horizonDays', 'analysisWindowStartDate', 'analysisWindowEndDate'],
    rows: forecastVersions,
  });
  tables.push({
    fileName: 'forecast_assumptions.csv',
    columns: ['assumptionId', 'forecastVersionId', 'statement', 'heldAfterSignal', 'invalidatedBySignalId'],
    rows: asArray(forecast.assumptions, 'forecast.assumptions').map((assumption) => ({
      assumptionId: assumption.assumptionId,
      forecastVersionId: baselineForecastVersionId,
      statement: assumption.statement,
      heldAfterSignal: assumption.heldAfterSignal,
      invalidatedBySignalId: assumption.invalidatedBySignalId,
    })),
  });
  tables.push({
    fileName: 'forecast_lines.csv',
    columns: ['forecastVersionId', 'regionId', 'productId', 'forecastUnits', 'horizonDays'],
    rows: buildForecastLines(scenario, regions, products, heroProduct as ScenarioRecord, forecastVersions),
  });
  tables.push({
    fileName: 'campaign_scenarios.csv',
    columns: [
      'scenarioId',
      'scenarioName',
      'incrementalBudgetUsd',
      'incrementalUnits',
      'incrementalRevenueUsd',
      'confidence',
      'supplyFeasible',
      'recommended',
      'approved',
      'campaignStartsOn',
      'campaignEndsOn',
      'forecastHorizonEndsOn',
      'blockedByPolicyId',
      'blockedByPolicyVersion',
      'rationale',
    ],
    rows: scenarios.map((scenarioRow) => ({
      scenarioId: scenarioRow.scenarioId,
      scenarioName: scenarioRow.name,
      incrementalBudgetUsd: scenarioRow.incrementalBudgetUsd,
      incrementalUnits: scenarioRow.incrementalUnits,
      incrementalRevenueUsd: scenarioRow.incrementalRevenueUsd,
      confidence: scenarioRow.confidence,
      supplyFeasible: scenarioRow.supplyFeasible,
      recommended: scenarioRow.recommended,
      approved: withOutcome && scenarioRow.scenarioId === scenario.approvedScenarioId,
      // The campaign window and the forecast horizon are carried on the scenario
      // so the horizon-honesty point is answerable from data rather than only
      // from the agent's instructions: the 30-day forecast ends before the
      // campaign does, and the seasonal outlook carries the remainder.
      campaignStartsOn: String(scenario.clock.campaignStart),
      campaignEndsOn: String(scenario.clock.campaignEnd),
      forecastHorizonEndsOn: String(scenario.weather?.forecast?.decisionDayHorizonEnd ?? ''),
      blockedByPolicyId: scenarioRow.blockedByPolicyId ?? null,
      blockedByPolicyVersion: scenarioRow.blockedByPolicyVersion ?? null,
      rationale: scenarioRow.rationale,
    })),
  });
  tables.push({
    fileName: 'scenario_region_allocation.csv',
    columns: ['scenarioId', 'regionId', 'allocationUnits', 'allocationRevenueUsd', 'allocationBudgetUsd', 'impactWeight'],
    rows: buildScenarioRegionAllocations(scenarios, affectedRegions, Number(scenario.unitPriceUsd)),
  });
  tables.push({
    fileName: 'campaign_commitments.csv',
    columns: [
      'commitmentId',
      'scenarioId',
      'launchPlanId',
      'productId',
      'committedUnits',
      'committedRevenueUsd',
      'approvedByRole',
      'approvedAt',
      'status',
      'originSignalId',
      'originCaseId',
    ],
    rows: campaignCommitmentRows,
  });
  tables.push({
    fileName: 'maintenance_windows.csv',
    columns: [
      'maintenanceWindowId',
      'lineId',
      'maintenanceType',
      'originalStartDate',
      'originalEndDate',
      'durationDays',
      'operatingDaysLost',
      'deferredStartDate',
      'deferredEndDate',
      'deferralDays',
      'lastMajorMaintenanceDate',
      'insideCampaignPeriod',
      'deferredOutsideCampaignPeriod',
    ],
    rows: maintenanceWindows,
  });
  const maintenancePolicyEvaluations = buildMaintenancePolicyEvaluations(scenario, options, maintenancePolicy as ScenarioRecord);
  validateMaintenancePolicyEvaluations(scenario, maintenancePolicyEvaluations, options);
  tables.push({
    fileName: 'maintenance_policy_evaluations.csv',
    columns: [
      'optionId',
      'policyId',
      'policyVersion',
      'sustainedRateFactor',
      'requiredUtilisation',
      'requestedDeferralDays',
      'permittedDeferralDays',
      'projectedStressIndex',
      'projectedStressPctOfThreshold',
      'stressCeilingPct',
      'withinStressCeiling',
      'policyPass',
    ],
    rows: maintenancePolicyEvaluations,
  });
  tables.push({
    fileName: 'production_options.csv',
    columns: [
      'optionId',
      'optionName',
      'summary',
      'requiredRateFactor',
      'requiredUtilisation',
      'appliesFromDate',
      'appliesToDate',
      'alternateLineId',
      'expectedOutputUnits',
      'availableIncrementalUnits',
      'incrementalUnitsDelivered',
      'meetsCommitment',
      'shortfallUnits',
      'effectOnExistingOrders',
      'materialsConstraint',
      'riskLevel',
      'confidence',
      'requiredApproverRole',
      'secondaryApproverRole',
      'policyCompliant',
      'recommended',
      'rejectionReason',
      'policyBasisJson',
    ],
    rows: buildProductionOptions(options, String(scenario.recommendedOptionId)),
  });
  const { governedActions, actionReceipts } = withOutcome
    ? buildGovernedActions(scenario, commercialPolicy as ScenarioRecord, capacityPolicy as ScenarioRecord)
    : { governedActions: [], actionReceipts: [] };
  const actionIds = new Set(governedActions.map((row) => String(row.actionId)));
  tables.push({
    fileName: 'governed_actions.csv',
    columns: ['actionId', 'actionType', 'apiName', 'requestedAt', 'approvedAt', 'executedAt', 'approvedByRole', 'policyId', 'policyVersion', 'receiptId', 'status', 'result', 'detailsJson'],
    rows: governedActions,
  });
  tables.push({
    fileName: 'action_receipts.csv',
    columns: ['receiptId', 'actionId', 'issuedAt', 'approverRole', 'policyId', 'policyVersion', 'outcome', 'receiptPayloadJson'],
    rows: actionReceipts,
  });
  const capacityPlan = buildCapacityPlan(scenario, campaignOperatingDates, withOutcome);
  validateCapacityPlan(scenario, capacityPlan);
  tables.push({
    fileName: 'capacity_plan.csv',
    columns: [
      'planVariant',
      'planDate',
      'lineId',
      'scheduledHours',
      'utilisation',
      'rateFactor',
      'plannedUnits',
      'isMaintenanceDay',
      'maintenanceWindowId',
      'optionId',
      'commitmentId',
      'existingCommittedUnits',
      'campaignCommitmentUnits',
    ],
    rows: capacityPlan,
  });

  for (const table of tables) {
    rowsByFile.set(table.fileName, table.rows);
    await writeTable(results, table.fileName, table.columns, table.rows, personaNames, roleIds);
  }

  validateForeignKeys(rowsByFile, {
    regionIds,
    productIds,
    launchPlanIds,
    campaignScenarioIds,
    commitmentIds,
    signalIds,
    plantIds,
    lineIds,
    forecastVersionIds,
    optionIds,
    policyKeys,
    maintenanceWindowIds,
    actionIds,
  });

  const dailyDemand = buildDailyDemand(scenario, regions, products, heroProduct as ScenarioRecord, allDates, varianceDates);
  await writeSalesOrderLines(
    results,
    scenario,
    regions,
    products,
    heroProduct as ScenarioRecord,
    allDates,
    varianceDates,
    dailyDemand,
    personaNames,
    roleIds,
    withOutcome,
  );
  await writeInventoryPositions(
    results,
    scenario,
    regions,
    products,
    heroProduct as ScenarioRecord,
    allDates,
    dailyDemand,
    personaNames,
    roleIds,
    withOutcome,
  );

  const { rows: productionOrders, orderInfos } = buildProductionOrders(
    scenario,
    lines,
    products,
    heroProduct as ScenarioRecord,
    maintenanceWindows,
    operatingDates,
    withOutcome,
  );
  const productionOrderIds = new Set(productionOrders.map((row) => String(row.productionOrderId)));
  for (const row of productionOrders) {
    assertMember(String(row.lineId), lineIds, 'production_orders.lineId');
    assertMember(String(row.productId), productIds, 'production_orders.productId');
    assertMember(row.commitmentId as string | null, commitmentIds, 'production_orders.commitmentId');
    assertMember(row.maintenanceWindowId as string | null, maintenanceWindowIds, 'production_orders.maintenanceWindowId');
  }
  await writeTable(
    results,
    'production_orders.csv',
    ['productionOrderId', 'lineId', 'productId', 'orderDate', 'plannedStartDate', 'plannedEndDate', 'plannedUnits', 'status', 'commitmentId', 'maintenanceWindowId'],
    productionOrders,
    personaNames,
    roleIds,
  );

  const materialReservations = buildMaterialReservations(orderInfos, products);
  for (const row of materialReservations) assertMember(String(row.productionOrderId), productionOrderIds, 'material_reservations.productionOrderId');
  await writeTable(
    results,
    'material_reservations.csv',
    ['reservationId', 'productionOrderId', 'materialSku', 'requiredQuantity', 'unitOfMeasure'],
    materialReservations,
    personaNames,
    roleIds,
  );

  await writeTable(
    results,
    'shift_schedules.csv',
    ['scheduleDate', 'lineId', 'shiftCount', 'scheduledHours', 'plannedUtilisation'],
    buildShiftSchedules(scenario, lines, operatingDates, withOutcome),
    personaNames,
    roleIds,
  );

  logResults('Fabric SQL', results);
  return results;
}
