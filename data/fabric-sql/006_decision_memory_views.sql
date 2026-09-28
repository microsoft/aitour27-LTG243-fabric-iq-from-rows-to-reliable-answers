CREATE OR ALTER VIEW dbo.vw_decision_case_summary AS
WITH trigger_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS triggerCount
    FROM dbo.decision_case_triggers
    GROUP BY caseId
),
campaign_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS campaignCount
    FROM dbo.decision_case_campaigns
    GROUP BY caseId
),
policy_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS policyCount
    FROM dbo.decision_case_policies
    GROUP BY caseId
),
correction_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS correctionCount
    FROM dbo.decision_corrections
    GROUP BY caseId
),
action_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS actionCount
    FROM dbo.decision_case_actions
    GROUP BY caseId
),
outcome_counts AS (
    SELECT
        caseId,
        COUNT_BIG(*) AS outcomeCount
    FROM dbo.decision_outcomes
    GROUP BY caseId
)
SELECT
    dc.caseId,
    dc.title,
    dc.scopeKey,
    dc.status,
    dc.concernsProductId,
    dc.openedAt,
    dc.resolvedAt,
    CASE WHEN dc.resolvedAt IS NULL THEN NULL ELSE DATEDIFF(day, dc.openedAt, dc.resolvedAt) END AS durationDays,
    COALESCE(tc.triggerCount, 0) AS triggerCount,
    COALESCE(cac.campaignCount, 0) AS campaignCount,
    COALESCE(pc.policyCount, 0) AS policyCount,
    COALESCE(cc.correctionCount, 0) AS correctionCount,
    COALESCE(ac.actionCount, 0) AS actionCount,
    COALESCE(oc.outcomeCount, 0) AS outcomeCount
FROM dbo.decision_cases AS dc
LEFT JOIN trigger_counts AS tc
    ON tc.caseId = dc.caseId
LEFT JOIN campaign_counts AS cac
    ON cac.caseId = dc.caseId
LEFT JOIN policy_counts AS pc
    ON pc.caseId = dc.caseId
LEFT JOIN correction_counts AS cc
    ON cc.caseId = dc.caseId
LEFT JOIN action_counts AS ac
    ON ac.caseId = dc.caseId
LEFT JOIN outcome_counts AS oc
    ON oc.caseId = dc.caseId;

GO

CREATE OR ALTER VIEW dbo.vw_decision_case_lifecycle AS
WITH lifecycle_events AS (
    SELECT
        dcs.caseId,
        dcs.changedAt AS eventTimestamp,
        CAST(dcs.sequence AS int) AS sortOrder,
        CAST('state_changed' AS varchar(40)) AS eventType,
        dcs.actorRole,
        CAST('decision-case' AS varchar(40)) AS entityType,
        dcs.caseId AS entityId,
        CAST(NULL AS varchar(50)) AS receiptId,
        dcs.state,
        CAST(NULL AS varchar(50)) AS actionType,
        CAST(NULL AS varchar(40)) AS outcomeId,
        CAST(NULL AS varchar(80)) AS metricName,
        CAST(NULL AS decimal(18,2)) AS metricValue,
        CAST(NULL AS decimal(18,2)) AS plannedValue,
        CAST(NULL AS varchar(120)) AS resultCode,
        CAST(CONCAT('Decision case state changed to ', dcs.state, '.') AS varchar(700)) AS description
    FROM dbo.decision_case_states AS dcs
    WHERE dcs.caseId = 'CASE-2026-HS-001'
    UNION ALL
    SELECT
        dc.caseId,
        dc.approvedAt,
        1500,
        'correction_approved',
        dc.approvedByRole,
        'correction',
        dc.correctionId,
        NULL,
        dc.status,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        dc.statement
    FROM dbo.decision_corrections AS dc
    WHERE dc.caseId = 'CASE-2026-HS-001'
    UNION ALL
    SELECT
        dca.caseId,
        ga.executedAt,
        2000,
        'action_executed',
        ga.approvedByRole,
        'governed-action',
        ga.actionId,
        dca.receiptId,
        ga.status,
        ga.actionType,
        NULL,
        NULL,
        NULL,
        NULL,
        ga.result,
        CAST(CONCAT(ga.actionType, ' executed through ', ga.apiName, '; receipt ', dca.receiptId, '.') AS varchar(700))
    FROM dbo.decision_case_actions AS dca
    INNER JOIN dbo.governed_actions AS ga
        ON ga.actionId = dca.actionId
    WHERE dca.caseId = 'CASE-2026-HS-001'
    UNION ALL
    SELECT
        dca.caseId,
        ar.issuedAt,
        2100,
        'receipt_issued',
        ar.approverRole,
        'action-receipt',
        ar.receiptId,
        ar.receiptId,
        ar.outcome,
        ga.actionType,
        NULL,
        NULL,
        NULL,
        NULL,
        ar.outcome,
        CAST(CONCAT('Receipt ', ar.receiptId, ' issued for action ', ar.actionId, ' under ', ar.policyId, ' v', ar.policyVersion, '.') AS varchar(700))
    FROM dbo.decision_case_actions AS dca
    INNER JOIN dbo.action_receipts AS ar
        ON ar.receiptId = dca.receiptId
    INNER JOIN dbo.governed_actions AS ga
        ON ga.actionId = ar.actionId
    WHERE dca.caseId = 'CASE-2026-HS-001'
    UNION ALL
    SELECT
        dout.caseId,
        dout.recordedAt,
        3000,
        'outcome_recorded',
        'ROLE-KNOWLEDGE-STEWARD',
        'outcome',
        dout.outcomeId,
        NULL,
        NULL,
        NULL,
        dout.outcomeId,
        dout.metricName,
        dout.metricValue,
        dout.plannedValue,
        dout.resultCode,
        CAST(CONCAT(dout.metricName, ' recorded as ', CAST(dout.metricValue AS varchar(40)), ' against planned ', CAST(dout.plannedValue AS varchar(40)), '.') AS varchar(700))
    FROM dbo.decision_outcomes AS dout
    WHERE dout.caseId = 'CASE-2026-HS-001'
)
SELECT
    ROW_NUMBER() OVER (ORDER BY eventTimestamp, sortOrder, entityId) AS lifecycleSequence,
    caseId,
    eventTimestamp,
    eventType,
    actorRole,
    entityType,
    entityId,
    receiptId,
    state,
    actionType,
    outcomeId,
    metricName,
    metricValue,
    plannedValue,
    resultCode,
    description
FROM lifecycle_events;

GO

CREATE OR ALTER VIEW dbo.vw_decision_case_reuse AS
WITH policy_summary AS (
    SELECT
        dcp.caseId,
        STRING_AGG(CAST(CONCAT(dcp.policyId, ' v', dcp.policyVersion) AS varchar(80)), ', ') WITHIN GROUP (ORDER BY dcp.policyId, dcp.policyVersion) AS appliedPolicies
    FROM dbo.decision_case_policies AS dcp
    GROUP BY dcp.caseId
),
correction_summary AS (
    SELECT
        dc.caseId,
        STRING_AGG(CAST(CONCAT(dc.correctionId, ': ', dc.statement) AS varchar(800)), ' | ') WITHIN GROUP (ORDER BY dc.correctionId) AS approvedCorrections
    FROM dbo.decision_corrections AS dc
    WHERE dc.status = 'approved'
    GROUP BY dc.caseId
)
SELECT
    dc.caseId,
    dc.title,
    dc.scopeKey,
    dc.status,
    dc.openedAt,
    dc.resolvedAt,
    dc.concernsProductId,
    p.productName,
    p.category,
    dc.originSignalId,
    es.signalName,
    es.signalType,
    es.persistenceThrough,
    es.persistenceProbability,
    dcc.campaignId,
    dcc.relationshipType AS campaignRelationshipType,
    c.campaignName,
    c.regionId AS campaignRegionId,
    dc.lineId,
    pl.lineName,
    dc.commitmentId,
    ps.appliedPolicies,
    cs.approvedCorrections,
    dout.outcomeId,
    dout.metricName,
    dout.metricValue,
    dout.plannedValue,
    dout.resultCode,
    dout.recordedAt,
    CAST(CONCAT(dc.title, ' | ', COALESCE(ps.appliedPolicies, ''), ' | ', COALESCE(cs.approvedCorrections, '')) AS varchar(1200)) AS reuseEvidence
FROM dbo.decision_cases AS dc
INNER JOIN dbo.products AS p
    ON p.productId = dc.concernsProductId
LEFT JOIN dbo.external_signals AS es
    ON es.signalId = dc.originSignalId
LEFT JOIN dbo.decision_case_campaigns AS dcc
    ON dcc.caseId = dc.caseId
LEFT JOIN dbo.campaigns AS c
    ON c.campaignId = dcc.campaignId
LEFT JOIN dbo.production_lines AS pl
    ON pl.lineId = dc.lineId
LEFT JOIN policy_summary AS ps
    ON ps.caseId = dc.caseId
LEFT JOIN correction_summary AS cs
    ON cs.caseId = dc.caseId
LEFT JOIN dbo.decision_outcomes AS dout
    ON dout.caseId = dc.caseId;
GO
