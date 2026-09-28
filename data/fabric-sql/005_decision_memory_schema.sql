IF OBJECT_ID(N'dbo.decision_cases', N'U') IS NULL
CREATE TABLE dbo.decision_cases (
    caseId varchar(40) NOT NULL,
    title varchar(300) NOT NULL,
    scopeKey varchar(120) NOT NULL,
    status varchar(30) NOT NULL,
    concernsProductId varchar(30) NOT NULL,
    openedAt datetime2(0) NOT NULL,
    resolvedAt datetime2(0) NULL,
    originSignalId varchar(40) NULL,
    lineId varchar(30) NULL,
    commitmentId varchar(40) NULL,
    CONSTRAINT PK_decision_cases PRIMARY KEY (caseId),
    CONSTRAINT FK_decision_cases_products FOREIGN KEY (concernsProductId) REFERENCES dbo.products(productId),
    CONSTRAINT FK_decision_cases_signals FOREIGN KEY (originSignalId) REFERENCES dbo.external_signals(signalId),
    CONSTRAINT FK_decision_cases_lines FOREIGN KEY (lineId) REFERENCES dbo.production_lines(lineId),
    CONSTRAINT FK_decision_cases_commitments FOREIGN KEY (commitmentId) REFERENCES dbo.campaign_commitments(commitmentId)
);

IF OBJECT_ID(N'dbo.decision_case_campaigns', N'U') IS NULL
CREATE TABLE dbo.decision_case_campaigns (
    caseId varchar(40) NOT NULL,
    campaignId varchar(50) NOT NULL,
    regionId varchar(30) NOT NULL,
    relationshipType varchar(40) NOT NULL,
    CONSTRAINT PK_decision_case_campaigns PRIMARY KEY (caseId, campaignId, relationshipType),
    CONSTRAINT FK_decision_case_campaigns_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId),
    CONSTRAINT FK_decision_case_campaigns_campaigns FOREIGN KEY (campaignId) REFERENCES dbo.campaigns(campaignId),
    CONSTRAINT FK_decision_case_campaigns_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId)
);

IF OBJECT_ID(N'dbo.decision_case_states', N'U') IS NULL
CREATE TABLE dbo.decision_case_states (
    caseId varchar(40) NOT NULL,
    sequence int NOT NULL,
    state varchar(40) NOT NULL,
    changedAt datetime2(0) NOT NULL,
    actorRole varchar(50) NOT NULL,
    CONSTRAINT PK_decision_case_states PRIMARY KEY (caseId, sequence),
    CONSTRAINT FK_decision_case_states_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId)
);

IF OBJECT_ID(N'dbo.decision_case_triggers', N'U') IS NULL
CREATE TABLE dbo.decision_case_triggers (
    caseId varchar(40) NOT NULL,
    triggerType varchar(50) NOT NULL,
    triggerId varchar(60) NOT NULL,
    CONSTRAINT PK_decision_case_triggers PRIMARY KEY (caseId, triggerType, triggerId),
    CONSTRAINT FK_decision_case_triggers_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId)
);

IF OBJECT_ID(N'dbo.decision_case_policies', N'U') IS NULL
CREATE TABLE dbo.decision_case_policies (
    caseId varchar(40) NOT NULL,
    policyId varchar(40) NOT NULL,
    policyVersion varchar(20) NOT NULL,
    CONSTRAINT PK_decision_case_policies PRIMARY KEY (caseId, policyId, policyVersion),
    CONSTRAINT FK_decision_case_policies_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId),
    CONSTRAINT FK_decision_case_policies_policies FOREIGN KEY (policyId, policyVersion) REFERENCES dbo.approved_policies(policyId, policyVersion)
);

IF OBJECT_ID(N'dbo.decision_corrections', N'U') IS NULL
CREATE TABLE dbo.decision_corrections (
    correctionId varchar(40) NOT NULL,
    caseId varchar(40) NOT NULL,
    statement varchar(700) NOT NULL,
    scopeKey varchar(120) NOT NULL,
    proposedByRole varchar(50) NOT NULL,
    proposedAt datetime2(0) NOT NULL,
    approvedByRole varchar(50) NOT NULL,
    approvedAt datetime2(0) NOT NULL,
    status varchar(30) NOT NULL,
    CONSTRAINT PK_decision_corrections PRIMARY KEY (correctionId),
    CONSTRAINT FK_decision_corrections_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId)
);

IF OBJECT_ID(N'dbo.decision_outcomes', N'U') IS NULL
CREATE TABLE dbo.decision_outcomes (
    outcomeId varchar(40) NOT NULL,
    caseId varchar(40) NOT NULL,
    metricName varchar(80) NOT NULL,
    metricValue decimal(18,2) NOT NULL,
    plannedValue decimal(18,2) NOT NULL,
    resultCode varchar(120) NOT NULL,
    recordedAt datetime2(0) NOT NULL,
    CONSTRAINT PK_decision_outcomes PRIMARY KEY (outcomeId),
    CONSTRAINT FK_decision_outcomes_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId)
);

IF OBJECT_ID(N'dbo.decision_case_actions', N'U') IS NULL
CREATE TABLE dbo.decision_case_actions (
    caseId varchar(40) NOT NULL,
    actionId varchar(40) NOT NULL,
    receiptId varchar(50) NOT NULL,
    CONSTRAINT PK_decision_case_actions PRIMARY KEY (caseId, actionId),
    CONSTRAINT FK_decision_case_actions_cases FOREIGN KEY (caseId) REFERENCES dbo.decision_cases(caseId),
    CONSTRAINT FK_decision_case_actions_actions FOREIGN KEY (actionId) REFERENCES dbo.governed_actions(actionId),
    CONSTRAINT FK_decision_case_actions_receipts FOREIGN KEY (receiptId) REFERENCES dbo.action_receipts(receiptId)
);
