IF OBJECT_ID(N'dbo.weather_stations', N'U') IS NULL
CREATE TABLE dbo.weather_stations (
    stationId varchar(40) NOT NULL,
    regionId varchar(30) NOT NULL,
    stationName varchar(160) NOT NULL,
    providerId varchar(40) NOT NULL,
    annualMeanTempC decimal(6,2) NOT NULL,
    annualMeanUvIndex decimal(6,2) NOT NULL,
    annualMeanHumidityPct decimal(6,2) NOT NULL,
    annualMeanPressureHpa decimal(7,2) NOT NULL,
    baseSeaSurfaceTemperatureC decimal(6,2) NULL,
    annualRainfallMm decimal(8,2) NOT NULL,
    isCoastal bit NOT NULL,
    provenance varchar(40) NOT NULL,
    CONSTRAINT PK_weather_stations PRIMARY KEY (stationId),
    CONSTRAINT FK_weather_stations_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId)
);

IF OBJECT_ID(N'dbo.climate_normals', N'U') IS NULL
CREATE TABLE dbo.climate_normals (
    regionId varchar(30) NOT NULL,
    dayOfYear int NOT NULL,
    temperatureMeanNormalC decimal(7,3) NOT NULL,
    uvIndexNormal decimal(7,3) NOT NULL,
    humidityNormalPct decimal(6,2) NOT NULL,
    precipitationNormalMm decimal(7,2) NOT NULL,
    sunshineNormalHours decimal(5,2) NOT NULL,
    baselinePeriodStart date NOT NULL,
    baselinePeriodEnd date NOT NULL,
    baselineLabel varchar(160) NOT NULL,
    provenance varchar(40) NOT NULL,
    CONSTRAINT PK_climate_normals PRIMARY KEY (regionId, dayOfYear),
    CONSTRAINT FK_climate_normals_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId)
);

IF OBJECT_ID(N'dbo.weather_events', N'U') IS NULL
CREATE TABLE dbo.weather_events (
    eventId varchar(60) NOT NULL,
    eventType varchar(60) NOT NULL,
    regionId varchar(30) NOT NULL,
    severity varchar(30) NOT NULL,
    startDate date NOT NULL,
    endDate date NOT NULL,
    durationDays int NOT NULL,
    peakValue decimal(12,4) NOT NULL,
    peakMetric varchar(60) NOT NULL,
    signalId varchar(40) NULL,
    relevantToHeroProduct bit NOT NULL,
    headline varchar(300) NOT NULL,
    provenance varchar(40) NOT NULL,
    CONSTRAINT PK_weather_events PRIMARY KEY (eventId),
    CONSTRAINT FK_weather_events_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_weather_events_signals FOREIGN KEY (signalId) REFERENCES dbo.external_signals(signalId)
);

IF OBJECT_ID(N'dbo.weather_elasticity_params', N'U') IS NULL
CREATE TABLE dbo.weather_elasticity_params (
    modelId varchar(60) NOT NULL,
    modelVersion varchar(20) NOT NULL,
    status varchar(30) NOT NULL,
    stewardRole varchar(50) NOT NULL,
    formula varchar(300) NOT NULL,
    betaUv decimal(8,4) NOT NULL,
    betaTempC decimal(8,4) NOT NULL,
    unitNote varchar(400) NOT NULL,
    coefficientsAreGlobal bit NOT NULL,
    tolerancePct decimal(6,2) NOT NULL,
    effectiveFrom date NOT NULL,
    provenance varchar(40) NOT NULL,
    sourceLabel varchar(600) NOT NULL,
    CONSTRAINT PK_weather_elasticity_params PRIMARY KEY (modelId, modelVersion)
);

IF OBJECT_ID(N'dbo.weather_demand_response', N'U') IS NULL
CREATE TABLE dbo.weather_demand_response (
    regionId varchar(30) NOT NULL,
    observationDate date NOT NULL,
    uvIndexAnomaly decimal(8,4) NOT NULL,
    temperatureMeanAnomalyC decimal(8,4) NOT NULL,
    betaUv decimal(8,4) NOT NULL,
    betaTempC decimal(8,4) NOT NULL,
    modelledUpliftPct decimal(9,4) NOT NULL,
    modelId varchar(60) NOT NULL,
    modelVersion varchar(20) NOT NULL,
    provenance varchar(40) NOT NULL,
    CONSTRAINT PK_weather_demand_response PRIMARY KEY (regionId, observationDate),
    CONSTRAINT FK_weather_demand_response_regions FOREIGN KEY (regionId) REFERENCES dbo.regions(regionId),
    CONSTRAINT FK_weather_demand_response_params FOREIGN KEY (modelId, modelVersion) REFERENCES dbo.weather_elasticity_params(modelId, modelVersion)
);
