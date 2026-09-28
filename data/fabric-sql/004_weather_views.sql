CREATE OR ALTER VIEW dbo.vw_weather_anomaly_by_region AS
WITH baseline_window AS (
    SELECT TOP (1)
        analysisWindowStartDate,
        analysisWindowEndDate
    FROM dbo.forecast_versions
    WHERE versionType = 'baseline'
    ORDER BY forecastDate
)
SELECT
    r.regionId,
    r.regionName,
    r.signalAffected,
    CAST(ROUND(AVG(CAST(wdr.uvIndexAnomaly AS decimal(18,4))), 4) AS decimal(9,4)) AS meanUvIndexAnomaly,
    CAST(ROUND(AVG(CAST(wdr.temperatureMeanAnomalyC AS decimal(18,4))), 4) AS decimal(9,4)) AS meanTemperatureMeanAnomalyC,
    COUNT_BIG(wdr.observationDate) AS observationDays,
    MAX(wdr.provenance) AS provenance
FROM dbo.regions AS r
CROSS JOIN baseline_window AS bw
LEFT JOIN dbo.weather_demand_response AS wdr
    ON wdr.regionId = r.regionId
    AND wdr.observationDate >= bw.analysisWindowStartDate
    AND wdr.observationDate <= bw.analysisWindowEndDate
GROUP BY
    r.regionId,
    r.regionName,
    r.signalAffected;

GO

CREATE OR ALTER VIEW dbo.vw_weather_demand_reconciliation AS
WITH baseline_window AS (
    SELECT TOP (1)
        forecastVersionId,
        analysisWindowStartDate,
        analysisWindowEndDate
    FROM dbo.forecast_versions
    WHERE versionType = 'baseline'
    ORDER BY forecastDate
),
hero_product AS (
    SELECT TOP (1)
        productId
    FROM dbo.products
    WHERE hero = 1
    ORDER BY productId
),
baseline_forecast AS (
    SELECT
        fl.regionId,
        fl.productId,
        CAST(ROUND(
            CAST(fl.forecastUnits AS decimal(18,4))
            * CAST(DATEDIFF(day, bw.analysisWindowStartDate, bw.analysisWindowEndDate) + 1 AS decimal(18,4))
            / CAST(fl.horizonDays AS decimal(18,4)),
            0
        ) AS int) AS forecastUnits
    FROM dbo.forecast_lines AS fl
    INNER JOIN baseline_window AS bw
        ON bw.forecastVersionId = fl.forecastVersionId
    INNER JOIN hero_product AS hp
        ON hp.productId = fl.productId
),
actuals AS (
    SELECT
        sol.regionId,
        sol.productId,
        SUM(sol.units) AS actualUnits
    FROM dbo.sales_order_lines AS sol
    CROSS JOIN baseline_window AS bw
    INNER JOIN hero_product AS hp
        ON hp.productId = sol.productId
    WHERE sol.orderDate >= bw.analysisWindowStartDate
        AND sol.orderDate <= bw.analysisWindowEndDate
    GROUP BY sol.regionId, sol.productId
),
actual_variance AS (
    SELECT
        bf.regionId,
        bf.productId,
        bf.forecastUnits,
        COALESCE(a.actualUnits, 0) AS actualUnits,
        CAST(ROUND((COALESCE(a.actualUnits, 0) - bf.forecastUnits) * 100.0 / NULLIF(bf.forecastUnits, 0), 2) AS decimal(9,2)) AS actualVariancePct
    FROM baseline_forecast AS bf
    LEFT JOIN actuals AS a
        ON a.regionId = bf.regionId
        AND a.productId = bf.productId
),
modelled AS (
    SELECT
        wdr.regionId,
        wdr.modelId,
        wdr.modelVersion,
        CAST(ROUND(AVG(CAST(wdr.modelledUpliftPct AS decimal(18,4))), 4) AS decimal(9,4)) AS meanModelledUpliftPct,
        MAX(wdr.provenance) AS provenance
    FROM dbo.weather_demand_response AS wdr
    CROSS JOIN baseline_window AS bw
    WHERE wdr.observationDate >= bw.analysisWindowStartDate
        AND wdr.observationDate <= bw.analysisWindowEndDate
    GROUP BY
        wdr.regionId,
        wdr.modelId,
        wdr.modelVersion
)
SELECT
    r.regionId,
    r.regionName,
    r.signalAffected,
    m.modelId,
    m.modelVersion,
    m.meanModelledUpliftPct,
    av.actualVariancePct,
    CAST(ROUND(m.meanModelledUpliftPct - av.actualVariancePct, 4) AS decimal(9,4)) AS upliftVarianceDifferencePct,
    av.forecastUnits,
    av.actualUnits,
    m.provenance,
    wep.sourceLabel
FROM modelled AS m
INNER JOIN dbo.regions AS r
    ON r.regionId = m.regionId
INNER JOIN actual_variance AS av
    ON av.regionId = m.regionId
INNER JOIN dbo.weather_elasticity_params AS wep
    ON wep.modelId = m.modelId
    AND wep.modelVersion = m.modelVersion;

GO

CREATE OR ALTER VIEW dbo.vw_weather_events_relevant AS
SELECT
    we.eventId,
    we.eventType,
    we.severity,
    we.startDate,
    we.endDate,
    we.durationDays,
    we.peakValue,
    we.peakMetric,
    we.signalId,
    we.relevantToHeroProduct,
    CASE WHEN we.relevantToHeroProduct = 1 THEN 'hero_product_relevant' ELSE 'irrelevant_context' END AS eventRelevance,
    we.headline,
    r.regionId,
    r.regionName,
    r.signalAffected,
    c.campaignId,
    c.campaignName,
    c.channel,
    c.status AS campaignStatus
FROM dbo.weather_events AS we
INNER JOIN dbo.regions AS r
    ON r.regionId = we.regionId
LEFT JOIN dbo.campaigns AS c
    ON c.regionId = we.regionId;

GO

CREATE OR ALTER VIEW dbo.vw_weather_station_coverage AS
SELECT
    ws.stationId,
    ws.stationName,
    ws.providerId,
    ws.isCoastal,
    ws.annualMeanTempC,
    ws.annualMeanUvIndex,
    ws.annualMeanHumidityPct,
    ws.annualMeanPressureHpa,
    ws.baseSeaSurfaceTemperatureC,
    ws.annualRainfallMm,
    ws.provenance,
    r.regionId,
    r.regionName,
    r.marketCode,
    r.signalAffected
FROM dbo.weather_stations AS ws
INNER JOIN dbo.regions AS r
    ON r.regionId = ws.regionId;
GO
