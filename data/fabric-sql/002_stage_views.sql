CREATE OR ALTER VIEW dbo.vw_forecast_variance AS
WITH baseline_forecast AS (
    SELECT
        fl.regionId,
        fl.productId,
        CAST(ROUND(
            CAST(fl.forecastUnits AS decimal(18,4))
            * CAST(DATEDIFF(day, fv.analysisWindowStartDate, fv.analysisWindowEndDate) + 1 AS decimal(18,4))
            / CAST(fl.horizonDays AS decimal(18,4)),
            0
        ) AS int) AS forecastUnits,
        fv.analysisWindowStartDate,
        fv.analysisWindowEndDate
    FROM dbo.forecast_lines AS fl
    INNER JOIN dbo.forecast_versions AS fv
        ON fv.forecastVersionId = fl.forecastVersionId
    WHERE fv.versionType = 'baseline'
),
actuals AS (
    SELECT
        sol.regionId,
        sol.productId,
        SUM(sol.units) AS actualUnits
    FROM dbo.sales_order_lines AS sol
    INNER JOIN dbo.forecast_versions AS fv
        ON fv.versionType = 'baseline'
        AND sol.orderDate >= fv.analysisWindowStartDate
        AND sol.orderDate <= fv.analysisWindowEndDate
    GROUP BY sol.regionId, sol.productId
)
SELECT
    r.regionId,
    r.regionName,
    p.productId,
    p.productName,
    bf.forecastUnits,
    COALESCE(a.actualUnits, 0) AS actualUnits,
    CAST(ROUND((COALESCE(a.actualUnits, 0) - bf.forecastUnits) * 100.0 / NULLIF(bf.forecastUnits, 0), 2) AS decimal(9,2)) AS variancePct,
    r.signalAffected
FROM baseline_forecast AS bf
INNER JOIN dbo.regions AS r
    ON r.regionId = bf.regionId
INNER JOIN dbo.products AS p
    ON p.productId = bf.productId
LEFT JOIN actuals AS a
    ON a.regionId = bf.regionId
    AND a.productId = bf.productId;

GO

CREATE OR ALTER VIEW dbo.vw_signal_evidence_chain AS
WITH affected_regions AS (
    SELECT
        sri.signalId,
        STRING_AGG(CAST(sri.regionId AS varchar(30)), ',') WITHIN GROUP (ORDER BY sri.regionId) AS affectedRegionIds,
        COUNT_BIG(*) AS affectedRegionCount
    FROM dbo.signal_region_impact AS sri
    GROUP BY sri.signalId
),
active_campaigns AS (
    SELECT
        c.productId,
        STRING_AGG(CAST(c.campaignId AS varchar(50)), ',') WITHIN GROUP (ORDER BY c.campaignId) AS campaignIds,
        COUNT_BIG(*) AS campaignCount
    FROM dbo.campaigns AS c
    INNER JOIN dbo.regions AS r
        ON r.regionId = c.regionId
        AND r.signalAffected = 1
    WHERE c.status = 'active'
    GROUP BY c.productId
),
invalidated_assumptions AS (
    SELECT
        fa.forecastVersionId,
        STRING_AGG(CAST(fa.assumptionId AS varchar(30)), ',') WITHIN GROUP (ORDER BY fa.assumptionId) AS assumptionIds,
        COUNT_BIG(*) AS assumptionCount
    FROM dbo.forecast_assumptions AS fa
    WHERE fa.heldAfterSignal = 0
    GROUP BY fa.forecastVersionId
),
baseline_version AS (
    SELECT TOP (1) forecastVersionId
    FROM dbo.forecast_versions
    WHERE versionType = 'baseline'
    ORDER BY forecastDate
),
hero_product AS (
    SELECT TOP (1) productId
    FROM dbo.products
    WHERE hero = 1
    ORDER BY productId
)
SELECT
    CAST(1 AS int) AS hopStep,
    CAST('signal_affects_region' AS varchar(80)) AS relation,
    CAST('external_signal' AS varchar(40)) AS fromEntityType,
    es.signalId AS fromEntityId,
    CAST('affected_regions' AS varchar(40)) AS toEntityType,
    ar.affectedRegionIds AS toEntityIds,
    CONCAT(CAST(ar.affectedRegionCount AS varchar(20)), ' signal-affected regions') AS evidenceSummary
FROM dbo.external_signals AS es
INNER JOIN affected_regions AS ar
    ON ar.signalId = es.signalId
UNION ALL
SELECT
    2,
    'region_sells_product',
    'affected_regions',
    ar.affectedRegionIds,
    'product',
    hp.productId,
    'Hero product sold in every affected region'
FROM affected_regions AS ar
CROSS JOIN hero_product AS hp
UNION ALL
SELECT
    3,
    'product_promoted_by_active_campaign',
    'product',
    hp.productId,
    'campaigns',
    ac.campaignIds,
    CONCAT(CAST(ac.campaignCount AS varchar(20)), ' active campaigns promote the hero product')
FROM hero_product AS hp
INNER JOIN active_campaigns AS ac
    ON ac.productId = hp.productId
UNION ALL
SELECT
    4,
    'campaign_built_on_forecast_version',
    'campaigns',
    ac.campaignIds,
    'forecast_version',
    bv.forecastVersionId,
    'Campaign plan is tied to the baseline forecast version'
FROM active_campaigns AS ac
CROSS JOIN baseline_version AS bv
CROSS JOIN hero_product AS hp
WHERE ac.productId = hp.productId
UNION ALL
SELECT
    5,
    'forecast_assumption_invalidated',
    'forecast_version',
    bv.forecastVersionId,
    'forecast_assumptions',
    ia.assumptionIds,
    CONCAT(CAST(ia.assumptionCount AS varchar(20)), ' assumptions invalidated by the external signal')
FROM baseline_version AS bv
INNER JOIN invalidated_assumptions AS ia
    ON ia.forecastVersionId = bv.forecastVersionId;

GO

CREATE OR ALTER VIEW dbo.vw_campaign_scenarios AS
SELECT
    cs.scenarioId,
    cs.scenarioName,
    cs.incrementalUnits,
    cs.incrementalRevenueUsd,
    cs.incrementalBudgetUsd,
    cs.confidence,
    CASE WHEN cs.supplyFeasible = 1 THEN 'feasible' ELSE 'not_feasible' END AS feasibility,
    cs.approved,
    cs.recommended,
    cs.blockedByPolicyId,
    cs.blockedByPolicyVersion,
    cs.rationale
FROM dbo.campaign_scenarios AS cs;

GO

CREATE OR ALTER VIEW dbo.vw_capacity_conflict AS
WITH baseline AS (
    SELECT
        lineId,
        SUM(plannedUnits) AS capacityWithoutMaintenanceUnits,
        SUM(CASE WHEN isMaintenanceDay = 1 THEN 0 ELSE plannedUnits END) AS capacityWithMaintenanceUnits,
        MAX(existingCommittedUnits) AS existingCommittedUnits,
        MAX(campaignCommitmentUnits) AS requiredIncrementalUnits
    FROM dbo.capacity_plan
    WHERE planVariant = 'baseline'
    GROUP BY lineId
),
approved AS (
    SELECT
        lineId,
        SUM(plannedUnits) AS approvedPlanUnits
    FROM dbo.capacity_plan
    WHERE planVariant = 'approved'
    GROUP BY lineId
)
SELECT
    b.lineId,
    b.capacityWithoutMaintenanceUnits,
    b.capacityWithMaintenanceUnits,
    b.existingCommittedUnits,
    b.capacityWithoutMaintenanceUnits - b.existingCommittedUnits AS headroomWithoutMaintenanceUnits,
    b.capacityWithMaintenanceUnits - b.existingCommittedUnits AS headroomWithMaintenanceUnits,
    b.requiredIncrementalUnits,
    CASE
        WHEN b.requiredIncrementalUnits - (b.capacityWithMaintenanceUnits - b.existingCommittedUnits) > 0
            THEN b.requiredIncrementalUnits - (b.capacityWithMaintenanceUnits - b.existingCommittedUnits)
        ELSE 0
    END AS shortfallUnits,
    a.approvedPlanUnits,
    a.approvedPlanUnits - b.existingCommittedUnits AS approvedHeadroomUnits
FROM baseline AS b
INNER JOIN approved AS a
    ON a.lineId = b.lineId;

GO

CREATE OR ALTER VIEW dbo.vw_production_options AS
SELECT
    po.optionId,
    po.optionName,
    po.requiredRateFactor,
    po.requiredUtilisation,
    po.expectedOutputUnits,
    po.effectOnExistingOrders,
    po.riskLevel,
    po.confidence,
    po.requiredApproverRole,
    po.secondaryApproverRole,
    po.policyCompliant,
    po.recommended,
    mpe.permittedDeferralDays,
    mpe.projectedStressPctOfThreshold,
    mpe.stressCeilingPct,
    mpe.policyPass,
    po.rejectionReason
FROM dbo.production_options AS po
LEFT JOIN dbo.maintenance_policy_evaluations AS mpe
    ON mpe.optionId = po.optionId;

GO

CREATE OR ALTER VIEW dbo.vw_impact_chain AS
WITH conflict AS (
    SELECT
        lineId,
        CASE
            WHEN MAX(campaignCommitmentUnits) - (SUM(CASE WHEN planVariant = 'baseline' AND isMaintenanceDay = 0 THEN plannedUnits ELSE 0 END) - MAX(existingCommittedUnits)) > 0
                THEN MAX(campaignCommitmentUnits) - (SUM(CASE WHEN planVariant = 'baseline' AND isMaintenanceDay = 0 THEN plannedUnits ELSE 0 END) - MAX(existingCommittedUnits))
            ELSE 0
        END AS shortfallUnits
    FROM dbo.capacity_plan
    GROUP BY lineId
)
SELECT
    mw.maintenanceWindowId,
    mw.originalStartDate,
    mw.originalEndDate,
    mw.deferredStartDate,
    mw.deferredEndDate,
    pl.lineId,
    pl.lineName,
    COUNT(po.productionOrderId) AS impactedProductionOrders,
    COALESCE(SUM(po.plannedUnits), 0) AS plannedUnitsInWindow,
    cc.commitmentId,
    cc.committedUnits,
    c.shortfallUnits,
    CAST(c.shortfallUnits * p.unitPriceUsd AS decimal(12,2)) AS revenueAtRiskUsd
FROM dbo.maintenance_windows AS mw
INNER JOIN dbo.production_lines AS pl
    ON pl.lineId = mw.lineId
INNER JOIN conflict AS c
    ON c.lineId = mw.lineId
INNER JOIN dbo.campaign_commitments AS cc
    ON cc.productId IS NOT NULL
INNER JOIN dbo.products AS p
    ON p.productId = cc.productId
LEFT JOIN dbo.production_orders AS po
    ON po.lineId = mw.lineId
    AND po.commitmentId = cc.commitmentId
    AND po.plannedStartDate >= mw.originalStartDate
    AND po.plannedStartDate <= mw.originalEndDate
WHERE mw.insideCampaignPeriod = 1
GROUP BY
    mw.maintenanceWindowId,
    mw.originalStartDate,
    mw.originalEndDate,
    mw.deferredStartDate,
    mw.deferredEndDate,
    pl.lineId,
    pl.lineName,
    cc.commitmentId,
    cc.committedUnits,
    c.shortfallUnits,
    p.unitPriceUsd;

GO

CREATE OR ALTER VIEW dbo.vw_decision_actions AS
SELECT
    ga.actionId,
    ga.actionType,
    ga.apiName,
    ga.requestedAt,
    ga.approvedAt,
    ga.executedAt,
    ga.approvedByRole AS approverRole,
    ar.receiptId,
    ga.policyId,
    ga.policyVersion,
    ap.policyName,
    ar.outcome,
    ga.status,
    ga.result
FROM dbo.governed_actions AS ga
INNER JOIN dbo.action_receipts AS ar
    ON ar.actionId = ga.actionId
INNER JOIN dbo.approved_policies AS ap
    ON ap.policyId = ga.policyId
    AND ap.policyVersion = ga.policyVersion;
GO
