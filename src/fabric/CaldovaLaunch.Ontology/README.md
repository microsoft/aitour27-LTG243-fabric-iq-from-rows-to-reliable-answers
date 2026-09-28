# CaldovaLaunch ontology

> [!IMPORTANT]
> Deployment status: this expanded-JSON ontology deploys to Fabric after
> normalizing unsupported integer value types and adding the schema declarations
> emitted by fabio's ontology converter.

Fabric IQ ontology for the Caldova launch scenario. It models the approved business vocabulary that connects external weather signals to Caldova regions, products, campaigns, demand forecasts, supply capacity, governed actions and decision memory.

## Item layout

This directory is an expanded Fabric ontology item:

```text
.platform
definition.json
EntityTypes/<numericId>/definition.json
RelationshipTypes/<numericId>/definition.json
bindings.json
```

Entity type, property, time-series property and relationship type IDs are globally unique sequential numeric strings beginning at `9390000000001`. Directory names for entity and relationship types match the `id` in each `definition.json`.

## Deployment finding and deploy command

The Fabric Ontology API accepts this expanded-JSON layout. The deployment
blocker was the `valueType` contract: ontology properties can use `String`,
`Boolean`, `Double`, `DateTime` and `Float`, but the service rejects integer
property types.

| valueType | Result |
|---|---|
| `String` | accepted |
| `Boolean` | accepted |
| `Double` | accepted |
| `DateTime` | accepted |
| `Float` | accepted |
| `Int64` | rejected |
| `Integer`, `Int`, `Long`, `Int32`, `Number`, `Decimal` | rejected |

`data/tools/build-ontology.ts` applies the deployable representation:

```bash
node data/tools/build-ontology.ts
node data/tools/build-ontology.ts --check
```

It maps every `Int64` in `properties` and `timeseriesProperties` to `Double`.
That is lossless for this dataset: the largest generated integer value is
260,000, and IEEE-754 doubles represent every integer exactly up to 2^53.

One additional live validator constraint applies to entity identifiers:
`entityIdParts` can reference only string-like key properties. Date fields that
are part of composite entity IDs remain the same property IDs and names, but are
typed as `String` so the item can deploy. Non-key date properties continue to use
`DateTime`.

The deployable shape was verified with fabio 0.71.0:

```bash
fabio ontology create \
  --workspace <workspace-id> \
  --name CaldovaBusinessMeaning \
  --dir src/fabric/CaldovaLaunch.Ontology \
  -o json

fabio ontology list-entity-types \
  --workspace <workspace-id> \
  --id <ontology-id> \
  -o json
```

The verified definition contains 26 entity types.

After creating the ontology, bind it to data sources:

```bash
node data/tools/build-ontology.ts \
  --eventhouse <EVENTHOUSE_ID> \
  --cluster-uri <KUSTO_CLUSTER_URI> \
  --database <KQL_DATABASE> \
  --bindings-output /tmp/caldova-ontology-bindings.json

fabio ontology bind \
  --workspace <WORKSPACE_ID> \
  --id <ONTOLOGY_ID> \
  --lakehouse <LAKEHOUSE_ID> \
  --bindings /tmp/caldova-ontology-bindings.json
```

`bindings.json` uses the map shape shown by `fabio context describe ontology import`
and `fabio context examples ontology` under
`binding_example.bindings_file`: top-level `source`, `entities`,
`relationships`, entity `table`/`columns`, optional entity `bindings[]`, and
relationship `sourceColumns`/`targetColumns`.

> [!IMPORTANT]
> fabio documents the binding-map example but does not publish a standalone JSON
> schema. The Lakehouse bindings use the default `--lakehouse` source. Kusto /
> Eventhouse time-series bindings must carry their own source block because
> `--lakehouse` and `--eventhouse` are mutually exclusive:
> `"source": { "type": "KustoTable", "itemId": "...", "clusterUri": "...", "databaseName": "..." }`.
> `build-ontology.ts` keeps those workspace-specific values parameterized as
> `__EVENTHOUSE_ID__`, `__KUSTO_CLUSTER_URI__`, and `__KQL_DATABASE__`; pass
> `--eventhouse`, `--cluster-uri`, and `--database` to emit a deploy-ready copy.

Verified against the daily Fabric ring on 2026-09-03 with fabio 0.71.0:

```bash
node data/tools/build-ontology.ts \
  --eventhouse <eventhouse-id> \
  --cluster-uri <kusto-cluster-uri> \
  --database CaldovaSignals \
  --bindings-output /tmp/caldova-ontology-bindings.json

fabio ontology bind \
  --workspace <workspace-id> \
  --id <ontology-id> \
  --lakehouse <lakehouse-id> \
  --bindings /tmp/caldova-ontology-bindings.json \
  -o json
```

The bind completed in one call with `entity_bindings: 26` and
`contextualizations: 49`. Reading the stored definition afterwards showed 30
DataBinding parts and 49 Contextualization parts.

> [!WARNING]
> Most contextualizations map to real generated key columns. `bindings.json`
> omits relationships that cannot be represented by fabio 0.71.0's binding map
> as a single Lakehouse contextualization table containing the source and target
> entity identifier columns. The map supports multi-column keys for composite
> `entityIdParts`; it does not express Kusto relationship contextualizations,
> multi-table joins, computed predicates or JSON extraction.

## Relationship binding notes

`weather_forecast_for_region` is intentionally not contextualized by
`bindings.json`. The only physical table with the required forecast rows is the
Eventhouse `WeatherForecastDaily` table, and Fabric currently rejects Kusto
relationship contextualizations with:

```text
Relationship contextualizations require a LakehouseTable source.
```

The `WeatherForecast` entity still has a Kusto TimeSeries binding to
`WeatherForecastDaily` with `timestampColumn: "issueTimestamp"`, but the binding
can map only the entity key properties (`issueDate`, `targetDate`, `regionId`,
`providerId`) because Fabric rejects non-key static properties inside TimeSeries
bindings. The same rule means the `WeatherEvent` Eventhouse binding maps
`eventId` only; static weather event details remain bound from the Lakehouse
`dbo.weather_events` table.

`built_on_forecast` is physically bound through the materialized Lakehouse bridge table `dbo.campaign_forecast_links`, using `campaignId -> forecastVersionId`. This closes the Act 1 `Campaign -> DemandForecast` hop against real data.

The Act 1 evidence chain is now fully backed by generated tables:

| Hop | Relationship | Binding table | Key mapping |
|---|---|---|---|
| `ExternalSignal -> Region` | `affects_region` | `dbo.signal_region_impact` | `signalId -> regionId` |
| `Region -> Product` | `sells_product` | `dbo.forecast_lines` | `regionId -> productId` |
| `Product -> Campaign` | `promoted_by_active_campaign` | `dbo.campaigns` | `productId -> campaignId` |
| `Campaign -> DemandForecast` | `built_on_forecast` | `dbo.campaign_forecast_links` | `campaignId -> forecastVersionId` |
| `DemandForecast -> ForecastAssumption` | `has_assumption` | `dbo.forecast_assumptions` | `forecastVersionId -> assumptionId` |

`correction_updates_assumption` is also defensible as a derived bridge from the correction's decision case and origin signal, but it is not a single contextualization table:

```sql
SELECT DISTINCT
    dc.correctionId,
    fa.assumptionId
FROM dbo.decision_corrections AS dc
INNER JOIN dbo.decision_cases AS dcase
    ON dcase.caseId = dc.caseId
INNER JOIN dbo.forecast_assumptions AS fa
    ON fa.invalidatedBySignalId = dcase.originSignalId
WHERE dc.scopeKey = 'forecast-assumptions/sun-care'
  AND fa.heldAfterSignal = 0;
```

Direct decision-memory relationships use `decision_cases`, `decision_case_campaigns`, `decision_case_policies`, `decision_corrections`, `decision_outcomes` and `decision_case_actions`. Other omitted relationships have source data but need a materialized bridge, a cross-source bridge, a Kusto relationship contextualization, or JSON extraction that the fabio 0.71.0 map does not express: `weather_forecast_for_region`, `weather_model_explains_signal`, `station_reports_weather_forecast`, `action_executes_option`, `action_issues_commitment`, `action_produces_outcome` and `policy_authorizes_commitment`.

Relationships that genuinely still lack a defensible generated-data bridge are `outcome_measured_by_metric` and `metric_governs_forecast`. `outcome_measured_by_metric` does not join because `decision_outcomes.metricName` values such as `incrementalUnitsDelivered` and `stressPctOfThresholdAtMaintenance` do not match `metric_definitions.metricName` values such as `Forecast variance percent` or `Cumulative equipment stress index`. `metric_governs_forecast` has no generated forecast table column that references `metricId`, `metricVersion` or `metricName`.

## Entity backing tables

| Entity type | Physical backing |
|---|---|
| `LaunchPlan` | Lakehouse `dbo.launch_plans` |
| `Campaign` | Lakehouse `dbo.campaigns`; Eventhouse `CampaignSignals` for time-series campaign measures |
| `Product` | Lakehouse `dbo.products` |
| `Region` | Lakehouse `dbo.regions` |
| `DemandForecast` | Lakehouse `dbo.forecast_versions` |
| `ForecastAssumption` | Lakehouse `dbo.forecast_assumptions` |
| `CampaignScenario` | Lakehouse `dbo.campaign_scenarios` |
| `CampaignCommitment` | Lakehouse `dbo.campaign_commitments` |
| `InventoryPosition` | Lakehouse `dbo.inventory_positions` |
| `Plant` | Lakehouse `dbo.plants` |
| `ProductionLine` | Lakehouse `dbo.production_lines`; Eventhouse `LineSignals` for line-rate/stress time series |
| `ProductionOrder` | Lakehouse `dbo.production_orders` |
| `MaintenanceWindow` | Lakehouse `dbo.maintenance_windows` |
| `ProductionOption` | Lakehouse `dbo.production_options` |
| `ExternalSignal` | Lakehouse `dbo.external_signals` |
| `WeatherStation` | Lakehouse `dbo.weather_stations`; Eventhouse `WeatherObservationsDaily` for daily weather time series |
| `WeatherForecast` | Eventhouse `WeatherForecastDaily` for key-level time-series binding |
| `WeatherEvent` | Lakehouse `dbo.weather_events`; Eventhouse `WeatherEvents` for key-level time-series binding |
| `WeatherDemandModel` | Lakehouse `dbo.weather_elasticity_params` |
| `ApprovedPolicy` | Lakehouse `dbo.approved_policies` |
| `MetricDefinition` | Lakehouse `dbo.metric_definitions` |
| `DecisionCase` | Lakehouse `dbo.decision_cases` |
| `Correction` | Lakehouse `dbo.decision_corrections` |
| `Action` | Lakehouse `dbo.governed_actions` |
| `Outcome` | Lakehouse `dbo.decision_outcomes` |
| `Persona` | Lakehouse `dbo.personas`, keyed by `roleId` for approval relationships |

## Relationship bridge tables

| Relationship | Physical backing |
|---|---|
| `built_on_forecast` | Lakehouse `dbo.campaign_forecast_links` |
