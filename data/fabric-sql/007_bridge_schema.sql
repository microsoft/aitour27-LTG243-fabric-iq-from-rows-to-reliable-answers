-- Materialised bridge tables for ontology relationships whose physical join
-- spans more than two tables and therefore cannot be expressed in the Fabric
-- ontology binding map.

IF OBJECT_ID(N'dbo.campaign_forecast_links', N'U') IS NULL
CREATE TABLE dbo.campaign_forecast_links (
  campaignId varchar(50) NOT NULL,
  forecastVersionId varchar(40) NOT NULL,
  regionId varchar(30) NOT NULL,
  productId varchar(30) NOT NULL,
  forecastUnits int NOT NULL,
  horizonDays int NOT NULL,
  versionType varchar(30) NOT NULL,
  signalAffected bit NOT NULL,
  CONSTRAINT PK_campaign_forecast_links PRIMARY KEY (campaignId, forecastVersionId),
  CONSTRAINT FK_campaign_forecast_links_campaign FOREIGN KEY (campaignId) REFERENCES dbo.campaigns (campaignId),
  CONSTRAINT FK_campaign_forecast_links_region FOREIGN KEY (regionId) REFERENCES dbo.regions (regionId),
  CONSTRAINT FK_campaign_forecast_links_product FOREIGN KEY (productId) REFERENCES dbo.products (productId)
);
