IF OBJECT_ID(N'dbo.regions', N'U') IS NULL
CREATE TABLE dbo.regions (
    regionId varchar(30) NOT NULL,
    regionName varchar(100) NOT NULL,
    marketCode varchar(30) NOT NULL,
    signalAffected bit NOT NULL,
    baselineForecastUnits30d int NOT NULL,
    variancePct decimal(6,2) NOT NULL,
    incrementalUnits int NOT NULL,
    CONSTRAINT PK_regions PRIMARY KEY (regionId)
);

IF OBJECT_ID(N'dbo.products', N'U') IS NULL
CREATE TABLE dbo.products (
    productId varchar(30) NOT NULL,
    productName varchar(120) NOT NULL,
    category varchar(60) NOT NULL,
    handlingClass varchar(30) NOT NULL,
    unitPriceUsd decimal(10,2) NOT NULL,
    hero bit NOT NULL,
    CONSTRAINT PK_products PRIMARY KEY (productId)
);

IF OBJECT_ID(N'dbo.launch_plans', N'U') IS NULL
CREATE TABLE dbo.launch_plans (
    launchPlanId varchar(30) NOT NULL,
    planName varchar(120) NOT NULL,
    status varchar(30) NOT NULL,
    startsOn date NOT NULL,
    endsOn date NOT NULL,
    CONSTRAINT PK_launch_plans PRIMARY KEY (launchPlanId)
);

IF OBJECT_ID(N'dbo.plants', N'U') IS NULL
CREATE TABLE dbo.plants (
    plantId varchar(30) NOT NULL,
    plantName varchar(120) NOT NULL,
    regionCode varchar(30) NOT NULL,
    CONSTRAINT PK_plants PRIMARY KEY (plantId)
);

IF OBJECT_ID(N'dbo.personas', N'U') IS NULL
CREATE TABLE dbo.personas (
    personaId varchar(30) NOT NULL,
    displayName varchar(120) NOT NULL,
    title varchar(120) NOT NULL,
    roleId varchar(50) NOT NULL,
    CONSTRAINT PK_personas PRIMARY KEY (personaId)
);

IF OBJECT_ID(N'dbo.external_signals', N'U') IS NULL
CREATE TABLE dbo.external_signals (
    signalId varchar(40) NOT NULL,
    signalName varchar(120) NOT NULL,
    signalType varchar(40) NOT NULL,
    provenance varchar(40) NOT NULL,
    sourceLabel varchar(600) NOT NULL,
    observationPeriodStart date NOT NULL,
    observationPeriodEnd date NOT NULL,
    persistenceThrough date NOT NULL,
    persistenceProbability decimal(5,2) NOT NULL,
    confidence decimal(5,2) NOT NULL,
    seaSurfaceAnomalyC decimal(5,2) NOT NULL,
    CONSTRAINT PK_external_signals PRIMARY KEY (signalId)
);

IF OBJECT_ID(N'dbo.approved_policies', N'U') IS NULL
CREATE TABLE dbo.approved_policies (
    policyId varchar(40) NOT NULL,
    policyVersion varchar(20) NOT NULL,
    policyName varchar(160) NOT NULL,
    status varchar(30) NOT NULL,
    effectiveFrom datetime2(0) NOT NULL,
    ruleJson varchar(2000) NOT NULL,
    CONSTRAINT PK_approved_policies PRIMARY KEY (policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.metric_definitions', N'U') IS NULL
CREATE TABLE dbo.metric_definitions (
    metricId varchar(50) NOT NULL,
    metricVersion varchar(20) NOT NULL,
    metricName varchar(160) NOT NULL,
    status varchar(30) NOT NULL,
    definitionJson varchar(1000) NOT NULL,
    CONSTRAINT PK_metric_definitions PRIMARY KEY (metricId, metricVersion)
);

IF OBJECT_ID(N'dbo.campaigns', N'U') IS NULL
CREATE TABLE dbo.campaigns (
    campaignId varchar(50) NOT NULL,
    launchPlanId varchar(30) NOT NULL,
    regionId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    campaignName varchar(160) NOT NULL,
    channel varchar(30) NOT NULL,
    status varchar(30) NOT NULL,
    baseBudgetUsd decimal(12,2) NOT NULL,
    incrementalBudgetUsd decimal(12,2) NOT NULL,
    CONSTRAINT PK_campaigns PRIMARY KEY (campaignId),
    CONSTRAINT FK_campaigns_launch_plans FOREIGN KEY (launchPlanId) REFERENCES dbo.launch_plans(launchPlanId),
    CONSTRAINT FK_campaigns_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_campaigns_products FOREIGN KEY (productId) REFERENCES dbo.products(productId)
);

IF OBJECT_ID(N'dbo.production_lines', N'U') IS NULL
CREATE TABLE dbo.production_lines (
    lineId varchar(30) NOT NULL,
    plantId varchar(30) NOT NULL,
    lineName varchar(120) NOT NULL,
    family varchar(60) NOT NULL,
    ratedRateUnitsPerMin int NOT NULL,
    scheduledHoursPerDay int NOT NULL,
    baselineUtilisation decimal(6,4) NOT NULL,
    status varchar(30) NOT NULL,
    sunCareQualified bit NOT NULL,
    preferredForHeroProduct bit NOT NULL,
    alternateLineForHeroProduct bit NOT NULL,
    requiresQualification bit NOT NULL,
    CONSTRAINT PK_production_lines PRIMARY KEY (lineId),
    CONSTRAINT FK_production_lines_plants FOREIGN KEY (plantId) REFERENCES dbo.plants(plantId)
);

IF OBJECT_ID(N'dbo.signal_region_impact', N'U') IS NULL
CREATE TABLE dbo.signal_region_impact (
    signalId varchar(40) NOT NULL,
    regionId varchar(30) NOT NULL,
    impactWeight decimal(9,6) NOT NULL,
    variancePct decimal(6,2) NOT NULL,
    incrementalUnits int NOT NULL,
    CONSTRAINT PK_signal_region_impact PRIMARY KEY (signalId, regionId),
    CONSTRAINT FK_signal_region_impact_signals FOREIGN KEY (signalId) REFERENCES dbo.external_signals(signalId),
    CONSTRAINT FK_signal_region_impact_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId)
);

IF OBJECT_ID(N'dbo.forecast_versions', N'U') IS NULL
CREATE TABLE dbo.forecast_versions (
    forecastVersionId varchar(40) NOT NULL,
    versionName varchar(40) NOT NULL,
    versionType varchar(20) NOT NULL,
    forecastDate date NOT NULL,
    productId varchar(30) NOT NULL,
    horizonDays int NOT NULL,
    analysisWindowStartDate date NOT NULL,
    analysisWindowEndDate date NOT NULL,
    CONSTRAINT PK_forecast_versions PRIMARY KEY (forecastVersionId),
    CONSTRAINT FK_forecast_versions_products FOREIGN KEY (productId) REFERENCES dbo.products(productId)
);

IF OBJECT_ID(N'dbo.forecast_assumptions', N'U') IS NULL
CREATE TABLE dbo.forecast_assumptions (
    assumptionId varchar(30) NOT NULL,
    forecastVersionId varchar(40) NOT NULL,
    statement varchar(600) NOT NULL,
    heldAfterSignal bit NOT NULL,
    invalidatedBySignalId varchar(40) NULL,
    CONSTRAINT PK_forecast_assumptions PRIMARY KEY (assumptionId),
    CONSTRAINT FK_forecast_assumptions_versions FOREIGN KEY (forecastVersionId) REFERENCES dbo.forecast_versions(forecastVersionId),
    CONSTRAINT FK_forecast_assumptions_signals FOREIGN KEY (invalidatedBySignalId) REFERENCES dbo.external_signals(signalId)
);

IF OBJECT_ID(N'dbo.forecast_lines', N'U') IS NULL
CREATE TABLE dbo.forecast_lines (
    forecastVersionId varchar(40) NOT NULL,
    regionId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    forecastUnits int NOT NULL,
    horizonDays int NOT NULL,
    CONSTRAINT PK_forecast_lines PRIMARY KEY (forecastVersionId, regionId, productId),
    CONSTRAINT FK_forecast_lines_versions FOREIGN KEY (forecastVersionId) REFERENCES dbo.forecast_versions(forecastVersionId),
    CONSTRAINT FK_forecast_lines_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_forecast_lines_products FOREIGN KEY (productId) REFERENCES dbo.products(productId)
);

IF OBJECT_ID(N'dbo.campaign_scenarios', N'U') IS NULL
CREATE TABLE dbo.campaign_scenarios (
    scenarioId varchar(40) NOT NULL,
    scenarioName varchar(180) NOT NULL,
    incrementalBudgetUsd decimal(12,2) NOT NULL,
    incrementalUnits int NOT NULL,
    incrementalRevenueUsd decimal(12,2) NOT NULL,
    confidence decimal(5,2) NOT NULL,
    supplyFeasible bit NOT NULL,
    recommended bit NOT NULL,
    approved bit NOT NULL,
    campaignStartsOn date NOT NULL,
    campaignEndsOn date NOT NULL,
    forecastHorizonEndsOn date NOT NULL,
    blockedByPolicyId varchar(40) NULL,
    blockedByPolicyVersion varchar(20) NULL,
    rationale varchar(1200) NOT NULL,
    CONSTRAINT PK_campaign_scenarios PRIMARY KEY (scenarioId),
    CONSTRAINT FK_campaign_scenarios_blocking_policy FOREIGN KEY (blockedByPolicyId, blockedByPolicyVersion) REFERENCES dbo.approved_policies(policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.scenario_region_allocation', N'U') IS NULL
CREATE TABLE dbo.scenario_region_allocation (
    scenarioId varchar(40) NOT NULL,
    regionId varchar(30) NOT NULL,
    allocationUnits int NOT NULL,
    allocationRevenueUsd decimal(12,2) NOT NULL,
    allocationBudgetUsd decimal(12,2) NOT NULL,
    impactWeight decimal(9,6) NOT NULL,
    CONSTRAINT PK_scenario_region_allocation PRIMARY KEY (scenarioId, regionId),
    CONSTRAINT FK_scenario_region_allocation_scenarios FOREIGN KEY (scenarioId) REFERENCES dbo.campaign_scenarios(scenarioId),
    CONSTRAINT FK_scenario_region_allocation_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId)
);

IF OBJECT_ID(N'dbo.campaign_commitments', N'U') IS NULL
CREATE TABLE dbo.campaign_commitments (
    commitmentId varchar(40) NOT NULL,
    scenarioId varchar(40) NOT NULL,
    launchPlanId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    committedUnits int NOT NULL,
    committedRevenueUsd decimal(12,2) NOT NULL,
    approvedByRole varchar(50) NOT NULL,
    approvedAt datetime2(0) NOT NULL,
    status varchar(30) NOT NULL,
    originSignalId varchar(40) NOT NULL,
    originCaseId varchar(40) NOT NULL,
    CONSTRAINT PK_campaign_commitments PRIMARY KEY (commitmentId),
    CONSTRAINT FK_campaign_commitments_scenarios FOREIGN KEY (scenarioId) REFERENCES dbo.campaign_scenarios(scenarioId),
    CONSTRAINT FK_campaign_commitments_launch_plans FOREIGN KEY (launchPlanId) REFERENCES dbo.launch_plans(launchPlanId),
    CONSTRAINT FK_campaign_commitments_products FOREIGN KEY (productId) REFERENCES dbo.products(productId),
    CONSTRAINT FK_campaign_commitments_signals FOREIGN KEY (originSignalId) REFERENCES dbo.external_signals(signalId)
);

IF OBJECT_ID(N'dbo.maintenance_windows', N'U') IS NULL
CREATE TABLE dbo.maintenance_windows (
    maintenanceWindowId varchar(40) NOT NULL,
    lineId varchar(30) NOT NULL,
    maintenanceType varchar(40) NOT NULL,
    originalStartDate date NOT NULL,
    originalEndDate date NOT NULL,
    durationDays int NOT NULL,
    operatingDaysLost int NOT NULL,
    deferredStartDate date NOT NULL,
    deferredEndDate date NOT NULL,
    deferralDays int NOT NULL,
    lastMajorMaintenanceDate date NOT NULL,
    insideCampaignPeriod bit NOT NULL,
    deferredOutsideCampaignPeriod bit NOT NULL,
    CONSTRAINT PK_maintenance_windows PRIMARY KEY (maintenanceWindowId),
    CONSTRAINT FK_maintenance_windows_lines FOREIGN KEY (lineId) REFERENCES dbo.production_lines(lineId)
);

IF OBJECT_ID(N'dbo.production_options', N'U') IS NULL
CREATE TABLE dbo.production_options (
    optionId varchar(30) NOT NULL,
    optionName varchar(180) NOT NULL,
    summary varchar(1000) NOT NULL,
    requiredRateFactor decimal(6,4) NOT NULL,
    requiredUtilisation decimal(6,4) NOT NULL,
    appliesFromDate date NULL,
    appliesToDate date NULL,
    alternateLineId varchar(30) NULL,
    expectedOutputUnits int NOT NULL,
    availableIncrementalUnits int NOT NULL,
    incrementalUnitsDelivered int NOT NULL,
    meetsCommitment bit NOT NULL,
    shortfallUnits int NOT NULL,
    effectOnExistingOrders varchar(300) NOT NULL,
    materialsConstraint varchar(500) NOT NULL,
    riskLevel varchar(30) NOT NULL,
    confidence decimal(5,2) NOT NULL,
    requiredApproverRole varchar(50) NOT NULL,
    secondaryApproverRole varchar(50) NULL,
    policyCompliant bit NOT NULL,
    recommended bit NOT NULL,
    rejectionReason varchar(700) NULL,
    policyBasisJson varchar(500) NOT NULL,
    CONSTRAINT PK_production_options PRIMARY KEY (optionId),
    CONSTRAINT FK_production_options_alternate_line FOREIGN KEY (alternateLineId) REFERENCES dbo.production_lines(lineId)
);

IF OBJECT_ID(N'dbo.maintenance_policy_evaluations', N'U') IS NULL
CREATE TABLE dbo.maintenance_policy_evaluations (
    optionId varchar(30) NOT NULL,
    policyId varchar(40) NOT NULL,
    policyVersion varchar(20) NOT NULL,
    sustainedRateFactor decimal(6,4) NOT NULL,
    requiredUtilisation decimal(6,4) NOT NULL,
    requestedDeferralDays int NOT NULL,
    permittedDeferralDays int NOT NULL,
    projectedStressIndex decimal(12,4) NOT NULL,
    projectedStressPctOfThreshold decimal(7,2) NOT NULL,
    stressCeilingPct decimal(7,2) NOT NULL,
    withinStressCeiling bit NOT NULL,
    policyPass bit NOT NULL,
    CONSTRAINT PK_maintenance_policy_evaluations PRIMARY KEY (optionId, policyId, policyVersion),
    CONSTRAINT FK_maintenance_policy_evaluations_options FOREIGN KEY (optionId) REFERENCES dbo.production_options(optionId),
    CONSTRAINT FK_maintenance_policy_evaluations_policies FOREIGN KEY (policyId, policyVersion) REFERENCES dbo.approved_policies(policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.governed_actions', N'U') IS NULL
CREATE TABLE dbo.governed_actions (
    actionId varchar(40) NOT NULL,
    actionType varchar(50) NOT NULL,
    apiName varchar(80) NOT NULL,
    requestedAt datetime2(0) NOT NULL,
    approvedAt datetime2(0) NOT NULL,
    executedAt datetime2(0) NOT NULL,
    approvedByRole varchar(50) NOT NULL,
    policyId varchar(40) NOT NULL,
    policyVersion varchar(20) NOT NULL,
    receiptId varchar(50) NOT NULL,
    status varchar(30) NOT NULL,
    result varchar(30) NOT NULL,
    detailsJson varchar(1000) NOT NULL,
    CONSTRAINT PK_governed_actions PRIMARY KEY (actionId),
    CONSTRAINT UQ_governed_actions_receipt UNIQUE (receiptId),
    CONSTRAINT FK_governed_actions_policies FOREIGN KEY (policyId, policyVersion) REFERENCES dbo.approved_policies(policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.action_receipts', N'U') IS NULL
CREATE TABLE dbo.action_receipts (
    receiptId varchar(50) NOT NULL,
    actionId varchar(40) NOT NULL,
    issuedAt datetime2(0) NOT NULL,
    approverRole varchar(50) NOT NULL,
    policyId varchar(40) NOT NULL,
    policyVersion varchar(20) NOT NULL,
    outcome varchar(80) NOT NULL,
    receiptPayloadJson varchar(1200) NOT NULL,
    CONSTRAINT PK_action_receipts PRIMARY KEY (receiptId),
    CONSTRAINT FK_action_receipts_actions FOREIGN KEY (actionId) REFERENCES dbo.governed_actions(actionId),
    CONSTRAINT FK_action_receipts_policies FOREIGN KEY (policyId, policyVersion) REFERENCES dbo.approved_policies(policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.capacity_plan', N'U') IS NULL
CREATE TABLE dbo.capacity_plan (
    planVariant varchar(20) NOT NULL,
    planDate date NOT NULL,
    lineId varchar(30) NOT NULL,
    scheduledHours decimal(6,2) NOT NULL,
    utilisation decimal(6,4) NOT NULL,
    rateFactor decimal(6,4) NOT NULL,
    plannedUnits int NOT NULL,
    isMaintenanceDay bit NOT NULL,
    maintenanceWindowId varchar(40) NULL,
    optionId varchar(30) NULL,
    -- Nullable because the capacity plan exists as a proposal before any campaign
    -- commitment is approved. It only points at a commitment once the decision
    -- has been taken.
    commitmentId varchar(40) NULL,
    existingCommittedUnits int NOT NULL,
    campaignCommitmentUnits int NOT NULL,
    CONSTRAINT PK_capacity_plan PRIMARY KEY (planVariant, planDate, lineId),
    CONSTRAINT FK_capacity_plan_lines FOREIGN KEY (lineId) REFERENCES dbo.production_lines(lineId),
    CONSTRAINT FK_capacity_plan_windows FOREIGN KEY (maintenanceWindowId) REFERENCES dbo.maintenance_windows(maintenanceWindowId),
    CONSTRAINT FK_capacity_plan_options FOREIGN KEY (optionId) REFERENCES dbo.production_options(optionId),
    CONSTRAINT FK_capacity_plan_commitments FOREIGN KEY (commitmentId) REFERENCES dbo.campaign_commitments(commitmentId)
);

IF OBJECT_ID(N'dbo.sales_order_lines', N'U') IS NULL
CREATE TABLE dbo.sales_order_lines (
    orderLineId varchar(30) NOT NULL,
    orderId varchar(40) NOT NULL,
    lineNumber int NOT NULL,
    orderDate date NOT NULL,
    regionId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    units int NOT NULL,
    unitPriceUsd decimal(10,2) NOT NULL,
    revenueUsd decimal(12,2) NOT NULL,
    channel varchar(30) NOT NULL,
    CONSTRAINT PK_sales_order_lines PRIMARY KEY (orderLineId),
    CONSTRAINT FK_sales_order_lines_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_sales_order_lines_products FOREIGN KEY (productId) REFERENCES dbo.products(productId)
);

IF OBJECT_ID(N'dbo.inventory_positions', N'U') IS NULL
CREATE TABLE dbo.inventory_positions (
    snapshotDate date NOT NULL,
    regionId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    availableUnits int NOT NULL,
    reservedUnits int NOT NULL,
    coverageDays decimal(8,2) NOT NULL,
    CONSTRAINT PK_inventory_positions PRIMARY KEY (snapshotDate, regionId, productId),
    CONSTRAINT FK_inventory_positions_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_inventory_positions_products FOREIGN KEY (productId) REFERENCES dbo.products(productId)
);

IF OBJECT_ID(N'dbo.production_orders', N'U') IS NULL
CREATE TABLE dbo.production_orders (
    productionOrderId varchar(30) NOT NULL,
    lineId varchar(30) NOT NULL,
    productId varchar(30) NOT NULL,
    orderDate date NOT NULL,
    plannedStartDate date NOT NULL,
    plannedEndDate date NOT NULL,
    plannedUnits int NOT NULL,
    status varchar(40) NOT NULL,
    commitmentId varchar(40) NULL,
    maintenanceWindowId varchar(40) NULL,
    CONSTRAINT PK_production_orders PRIMARY KEY (productionOrderId),
    CONSTRAINT FK_production_orders_lines FOREIGN KEY (lineId) REFERENCES dbo.production_lines(lineId),
    CONSTRAINT FK_production_orders_products FOREIGN KEY (productId) REFERENCES dbo.products(productId),
    CONSTRAINT FK_production_orders_commitments FOREIGN KEY (commitmentId) REFERENCES dbo.campaign_commitments(commitmentId),
    CONSTRAINT FK_production_orders_windows FOREIGN KEY (maintenanceWindowId) REFERENCES dbo.maintenance_windows(maintenanceWindowId)
);

IF OBJECT_ID(N'dbo.material_reservations', N'U') IS NULL
CREATE TABLE dbo.material_reservations (
    reservationId varchar(30) NOT NULL,
    productionOrderId varchar(30) NOT NULL,
    materialSku varchar(40) NOT NULL,
    requiredQuantity decimal(12,2) NOT NULL,
    unitOfMeasure varchar(20) NOT NULL,
    CONSTRAINT PK_material_reservations PRIMARY KEY (reservationId),
    CONSTRAINT FK_material_reservations_orders FOREIGN KEY (productionOrderId) REFERENCES dbo.production_orders(productionOrderId)
);

IF OBJECT_ID(N'dbo.shift_schedules', N'U') IS NULL
CREATE TABLE dbo.shift_schedules (
    scheduleDate date NOT NULL,
    lineId varchar(30) NOT NULL,
    shiftCount int NOT NULL,
    scheduledHours decimal(6,2) NOT NULL,
    plannedUtilisation decimal(6,4) NOT NULL,
    CONSTRAINT PK_shift_schedules PRIMARY KEY (scheduleDate, lineId),
    CONSTRAINT FK_shift_schedules_lines FOREIGN KEY (lineId) REFERENCES dbo.production_lines(lineId)
);
