# Caldova LTG243 shared Fabric dataset

This directory contains the deterministic synthetic Caldova dataset used by the
LTG243 Fabric IQ and Fabric Data Agent demonstration. It is the same governed
Fabric fixture used by the related BRK390 session, but LTG243 follows only the
Hydration Sunscreen question, ontology, grounded answer, and source-inspection
path. The dataset is driven by the frozen scenario in
`data/scenario.json`; generated records, expected answers, receipts, and
demo values derive from that file.

All records are synthetic and fictional. Caldova is not a real company, and this
package contains no real sales, climate, clinical, customer, patient, employee,
or other person-level business data.

> [!IMPORTANT]
> `create-data.sh` and `create-data.ps1` deploy the dataset and LTG243 items to
> Microsoft Fabric. Fabric SQL Database is created as a Fabric item; no separate
> Azure SQL server or application host is required. LTG243 does not use the
> optional `--with-cosmos` path.

## Operational status

| Area | Verified state |
| --- | --- |
| Validator | `cd data && node tools/validate.ts` reports `322 passed, 0 failed`. It streams CSV/JSONL, transparently reads `.gz`, checks structure, referential integrity, narrative invariants, payload cleanliness, evaluation consistency, ontology bindings, Direct Lake semantic model metadata, decision-memory tables, agent evidence projections, the data agent definition, and manifest path-set consistency, and exits non-zero on failure. |
| Manifest | `cd data && node tools/manifest.ts --check` reports `PASS manifest.json matches 94 files on disk.` `data/manifest.json` records 94 deployable files and 8,416,152 payload bytes, about 8.0 MiB. |
| As-of snapshot | The default payload is a snapshot as of `clock.asOf = 2026-08-03`. Observed facts, transactions, telemetry, executed actions, receipts, recorded outcomes, and resolved-case facts do not appear after that date. |
| Reproducibility | Manifest path-set validation passes for the current 94-file payload set generated from `schemaVersion` `3.0.0` and `generatorSeed` `20270607`. |
| Lakehouse analytics | Deployment loads 42 Fabric SQL payload tables and 11 Eventhouse CSV tables as 53 analytical Delta tables, plus 7 `dash_`-prefixed dashboard tables and 5 narrative evidence tables, for Fabric IQ ontology bindings, the Direct Lake semantic model, and the data agent. |
| Stored payload footprint | The committed manifest payload is 8,416,152 bytes. A local `data/` directory can be much larger after expansion because `.staging/` holds uncompressed deployment copies. |

## Default snapshot and optional outcome

The default dataset represents the Caldova estate **as it stands on `clock.asOf`**, currently **2026-08-03**. This keeps the campaign decision open for the demo: the data can show the demand signal, recommended scenario, policy constraints, capacity conflict, and proposed operating plan, but it must not pre-answer the presenter decision.

The rule is based on the kind of fact, not only on the date:

| Kind | Examples | Default-slice rule |
| --- | --- | --- |
| **Observed fact** | sales, telemetry, inventory, weather observations, executed actions, receipts, recorded outcomes, resolved cases | Cannot exist after `asOf`. Truncated or withheld. |
| **Forward artefact** | launch plans, campaign windows, maintenance schedules, production options, capacity plans, forecasts issued on or before `asOf` | May legitimately extend beyond `asOf`. Not truncated by target date. |

That distinction matters most for weather forecasts. The decision-day issue is `2026-08-03`; its 30 lead days target `2026-08-04` through `2026-09-02`, even though the dataset is still an as-of snapshot. Filtering the rolling forecast archive by target date would remove the very forward evidence Act 1 is supposed to reason from. Filter by issue date.

In the default committed payload:

| Surface | Default state |
| --- | --- |
| `campaign_scenarios.csv` | `SCN-2026-HS-B` is recommended, but no scenario is approved. |
| `campaign_commitments.csv` | Empty; `CMT-2026-HS-001` is an outcome-slice commitment, not a default fact. |
| `campaigns.csv` | All six `incrementalBudgetUsd` values are `0`. |
| `governed_actions.csv` and `fabric-sql/action_receipts.csv` | Empty. `data/receipts/action-receipts.json` still contains eight historical background receipts for already-resolved historical cases. |
| `decision_cases.csv` and `decision-cases.jsonl` | `CASE-2026-HS-001` is `open`, with no `resolvedAt`, no governed actions, no correction, and no outcomes. |
| Historical decision cases | The eight background cases remain `resolved`; they pre-date the snapshot and support retrieval/memory examples. |

How the story turned out is available only in the opt-in reveal slice:

```bash
cd data
node tools/generate.ts --with-outcome
```

or:

```bash
cd data
CALDOVA_WITH_OUTCOME=1 node tools/generate.ts
```

The outcome slice restores the approved commitment, executed governed actions and receipts, the resolved hero case, its correction, and the recorded outcomes: 104,300 incremental units delivered against 100,000 planned, and $834,400 revenue realised against $800,000 planned. The deployment scripts do not expose a separate `--with-outcome` flag; set `CALDOVA_WITH_OUTCOME=1` before deployment if you intentionally use `--regenerate` to produce the reveal slice.

## Story encoded by the data

The table below describes the **Fabric dataset walkthroughs**, including legacy
production and retrieval examples. Session ordering is defined in
[session order and demo numbering](../docs/session-order.md): Demos 2–4 are all
in Act 2; Act 3 is the later workforce decision. The standalone Act 2 variant has
its own fixtures. Demo 4's session recording stops at retention, even though this
dataset also contains retrieval probes and optional generated outcomes.

| Demo | Data support | Stage-critical values |
| --- | --- | --- |
| **Demo 1: Commercial command centre** | Hydration Sunscreen (`PROD-HS-100`) runs above forecast in four of six regions. The external signal (`SIG-ENSO-2026-07`) is attributed in the payload to Meridian Climate Services (`WX-MCS-001`, short name `MCS`) and backed by approved demand-response model `WXMODEL-UPLIFT-001`: `upliftPct = 8.0 * uvIndexAnomaly + 3.4 * temperatureMeanAnomalyC`. The coefficients are global, so regional uplift differences come from regional weather differences. `weather-demand-reconciliation.csv` shows modelled uplift equal to actual sales variance with `difference_pct = 0` in all six regions. Evidence uses two tiers: the `2026-08-03` 30-day forecast covers `2026-08-04` through `2026-09-02`, while the ENSO seasonal outlook at 78% persistence carries the claim through `2026-11-26`. | 4 affected regions; 100,000 incremental units; $800,000 opportunity at $8/unit; baseline forecast `2026.07.20-1`; affected variances and modelled weather uplift: Coastal 31.4%, Southern 26.8%, Island 22.5%, Delta 18.9%; controls: Northern 1.2%, Central -0.8%; variance window `2026-06-22` through `2026-08-02`; decision-day forecast issue `2026-08-03`; 30-day horizon end `2026-09-02`; campaign `2026-08-17` through `2026-10-02`; seasonal persistence through `2026-11-26` at 78%. |
| **Demo 2: Recommendation to commitment** | Three campaign scenarios are generated: hold current plan (`SCN-2026-HS-A`), targeted uplift (`SCN-2026-HS-B`), and aggressive push (`SCN-2026-HS-C`). In the default slice, `SCN-2026-HS-B` is recommended but **not approved**; the decision is still to be taken. The aggressive scenario remains blocked by commercial policy. | Scenario under review `SCN-2026-HS-B`; 100,000 candidate incremental units; $800,000 candidate revenue; $180,000 candidate incremental budget; aggressive $420,000 scenario blocked by `POL-COMMERCIAL-004:1.0` because the delegated limit is $250,000; no default `campaign_commitments`, governed actions, or campaign receipt. |
| **Demo 3: Production conflict** | The recommended campaign volume lands on line `PKG-02`, where the five-day maintenance window `MW-PKG-02-2026-09` removes enough capacity to create a conflict. Options compare prebuild, alternate-line production, invalid full-rate deferral, and the recommended reduced-rate/high-utilisation plan. | Capacity without maintenance: 708,480 units; capacity with maintenance: 622,080 units; existing committed units: 580,000; headroom with maintenance: 42,080 units; required incremental units: 100,000; exact shortfall: 57,920 units. Recommended `OPT-4` uses 90% rate and 90% utilisation, permits a 28-day deferral, projects 111.26% of the stress threshold, and remains within the 115% policy ceiling. |
| **Demo 4: Decision memory** | A `DecisionCase` records trigger, evidence, policies, candidate scenarios, recommended production option, and retrieval chunks. In the default slice, `CASE-2026-HS-001` is open and has no governed actions, receipts, correction, or outcomes. The outcome slice resolves the case and adds how it turned out. A future advisory (`SIG-ENSO-2027-04`) should retrieve the 2026 case and reuse the approved reasoning when the reveal slice is used. | Default decision case `CASE-2026-HS-001` is open; case campaign bridge links four signal-affected campaigns; future retrieval signal `SIG-ENSO-2027-04`; reveal-slice correction `CORR-2026-001`; reveal-slice demand outcome `OUT-DEMAND-001` delivered 104,300 units against 100,000 planned; reveal-slice revenue outcome `OUT-REVENUE-002` realised $834,400 against $800,000 planned; maintenance outcome retains 111.26% stress threshold. |

## Layout and Fabric targets

| Path | Contents | Fabric target |
| --- | --- | --- |
| `scenario.json` | Source scenario: IDs, dates, policies, region variance, capacity math, receipts, expected outcomes, generator seed, `clock.asOf`, `synthetic: true`, `fictional: true`, and weather settings. Schema version: `3.0.0`. | Generator input; copied to staging, not loaded as a grounded table by the scripts. |
| `manifest.json` | SHA-256, byte size, metadata, and local integrity information for 91 deployable files. | Local integrity record. |
| `package.json` | Node package metadata and npm scripts for generation, validation, manifest refresh, and the combined workflow. | Local tooling only. |
| `fabric-sql/` | Fabric SQL schema, stage views, and relational CSV payloads for regions, products, campaigns, policies, forecasts, production capacity, orders, reservations, decision memory, weather, and ontology bridge tables. | Fabric SQL Database, which uses the Azure SQL Database engine hosted as a Fabric item. The CSV payloads are also loaded into the Lakehouse analytical Delta layer. |
| `fabric-sql/003_weather_schema.sql`, `fabric-sql/004_weather_views.sql` | Weather relational schema and views for stations, day-of-year climate normals, weather events, elasticity parameters, and weather demand response. | Fabric SQL Database deployment scripts; discovered automatically by numeric filename prefix. |
| `fabric-sql/weather_stations.csv`, `fabric-sql/climate_normals.csv`, `fabric-sql/weather_events.csv`, `fabric-sql/weather_demand_response.csv`, `fabric-sql/weather_elasticity_params.csv` | Six stations, 2,196 climate-normal rows, 131 weather events, 948 demand-response rows, and one approved elasticity model. | Fabric SQL Database tables. |
| `fabric-sql/005_decision_memory_schema.sql`, `fabric-sql/006_decision_memory_views.sql` | Decision-memory relational schema and views for queryable cases, lifecycle, and reuse evidence. | Fabric SQL Database deployment scripts; discovered automatically by numeric filename prefix. |
| `fabric-sql/decision_cases.csv`, `fabric-sql/decision_case_states.csv`, `fabric-sql/decision_case_triggers.csv`, `fabric-sql/decision_case_policies.csv`, `fabric-sql/decision_case_campaigns.csv`, `fabric-sql/decision_corrections.csv`, `fabric-sql/decision_outcomes.csv`, `fabric-sql/decision_case_actions.csv` | Default slice: nine cases, 34 state rows, 10 triggers, 11 policy links, four campaign links, zero correction rows, eight historical outcome rows, and zero action links. `decision_case_campaigns` is a many-to-many bridge; `CASE-2026-HS-001` links to the four signal-affected campaigns. | Fabric SQL Database tables, also loaded as Lakehouse analytical Delta tables for ontology and semantic-model binding. |
| `fabric-sql/007_bridge_schema.sql`, `fabric-sql/campaign_forecast_links.csv` | Materialised Campaign-to-DemandForecast bridge with six rows. It resolves `campaigns` -> `forecast_lines` -> `forecast_versions` on region and product against baseline forecast version `FC-2026-0720-HS`. | Fabric SQL Database table, also loaded as a Lakehouse analytical Delta table for the `Campaign` to `DemandForecast` ontology relationship. |
| `eventhouse/` | KQL table definitions, CSV ingestion mappings, stage queries, and time-series CSV payloads for sales, forecast snapshots, campaign signals, line telemetry, climate observations, weather observations and forecasts, inventory snapshots, and state transitions. | Eventhouse/KQL database, with source files uploaded through Lakehouse staging. |
| `eventhouse/004_weather_tables.kql`, `eventhouse/005_weather_mappings.kql`, `eventhouse/006_weather_stage_queries.kql` | Weather KQL tables, CSV mappings, and presenter reference queries. The deployment applies table and mapping files, not stage-query files. | Eventhouse/KQL database for tables and mappings; stage queries are operator reference only. |
| `eventhouse/WeatherObservationsDaily.csv`, `eventhouse/WeatherObservationsHourly.csv`, `eventhouse/WeatherForecastDaily.csv.gz`, `eventhouse/WeatherEvents.csv` | Default slice: 948 daily observations, 6,192 hourly observations, 12,240 rolling 30-day forecast rows issued on or before `2026-08-03`, and 131 weather events from the Meridian Climate Services-attributed feed. | Eventhouse/KQL tables staged through Lakehouse. |
| `lakehouse/dashboard/` | Dashboard-friendly CSVs for campaign performance, forecast assumptions, regional variance, hero-product demand trend, weather anomaly, forecast outlook, and demand reconciliation. | Lakehouse files and Lakehouse dashboard tables. |
| `lakehouse/evidence/` | CSV projections of climate advisories, forecast briefings, briefing-region rows, signal evidence trace, and provider metadata. | Lakehouse files and Lakehouse evidence tables for data-agent grounding. |
| `lakehouse/external-signals/` | JSONL advisories, forecast briefings, weather events, weather provider metadata, and evidence-trace records for external signals. | Lakehouse/OneLake files. |
| `lakehouse/decision-cases/` | JSONL decision case documents and timeline events. Default slice: nine cases and five timeline rows, with `CASE-2026-HS-001` open. | Lakehouse/OneLake files. With `--with-cosmos` and `fabio 0.71.0` or later, these documents are also imported into Cosmos DB containers. |
| `lakehouse/retrieval/` | Retrieval corpus and retrieval probes used by Demo 4 evaluation. Current default corpus: 351 chunks and 5 probes. | Lakehouse/OneLake files. |
| `evaluation/` | Four demo questions and four expected-result objects. | Lakehouse/OneLake files under `Files/evaluation`. |
| `receipts/` | Default slice: eight historical background decision-case receipts. Canonical hero-case receipts are reveal-slice records only. | Lakehouse/OneLake files under `Files/receipts`. |
| `tools/` | TypeScript generator, validator, expander, manifest writer/checker, and shared deterministic generation libraries. | Local tooling only. |
| `.staging/` | Ignored deployment staging directory created by `tools/expand.ts`. It contains uncompressed copies for `fabio` and can be large. | Local expanded copy consumed by `fabio`. |

Fabric items created or used by deployment:

| Item | Default name | Created by default | Notes |
| --- | --- | --- | --- |
| Lakehouse | `CaldovaAnalytics` | Yes | Receives staged files, Eventhouse source CSVs, evaluation files, receipts, dashboard tables, and evidence tables. |
| Eventhouse | `CaldovaSignals` | Yes | Hosts the KQL database item. |
| KQL database | `CaldovaSignals` | Yes | Receives Eventhouse tables and CSV ingestion. |
| Fabric SQL Database | `CaldovaOperations` | Yes | Uses the Azure SQL Database engine hosted as a Fabric item; relational CSVs load via `fabio sql-database import`. |
| Cosmos DB for NoSQL database | `CaldovaDecisionMemory` | No; opt in with `--with-cosmos` | With `fabio 0.71.0` or later, provisions the Fabric-native Cosmos DB database item, creates the `decision-cases` and `decision-timeline` containers, and imports the decision-case documents. |
| Fabric IQ ontology | `CaldovaBusinessMeaning` | Attempted unless `--skip-fabric-items` is used | Deploys 26 entity types and 59 relationship types, then binds in one call using 26 entity bindings and 49 relationship contextualizations. `build-ontology.ts` maps `Int64` to `Double` because the Ontology API has no integer type. |
| Semantic model | `CaldovaLaunchModel` | Attempted unless `--skip-fabric-items` is used | Direct Lake, generated as TMDL by `build-semantic-model.ts` from `src/fabric/semantic-model-source/model.bim`: 46 tables, 82 measures, 71 relationships. Synonyms are not deployed; see the item README. |
| Data agent | `CaldovaAnalyst` | Attempted unless `--skip-fabric-items` is used | Preview Fabric data agent configured from `src/fabric/CaldovaLaunch.DataAgent/`. It attaches the semantic model, KQL database, and Lakehouse; the ontology is consumed as a peer surface, not as a data-agent datasource. |

### Lakehouse analytical Delta layer

Deployment loads the analytical CSV payloads into the Lakehouse as Delta tables in addition to their primary Fabric SQL Database and Eventhouse targets. The current payload set produces 53 analytical Delta tables: 42 from `fabric-sql/` and 11 from `eventhouse/`.

This layer exists because the Fabric IQ ontology and Direct Lake semantic model bind to Lakehouse tables. `src/fabric/CaldovaLaunch.Ontology` defines 26 entity types and 59 relationship types, with `bindings.json` mapping 26 entity bindings and 49 relationship contextualizations to generated tables. `src/fabric/CaldovaLaunch.SemanticModel` defines a Direct Lake semantic model with 46 tables, 82 measures, and 71 relationships, including descriptions for agent grounding. These Fabric item definitions live outside `data/`, so they are not part of the data inventory or manifest. Both deploy successfully; the only outstanding limitation is that TMDL cannot currently carry linguistic metadata (synonyms), so cultures are opt-in via `--with-cultures` and are not deployed.

### Narrative evidence tables

`lakehouse/evidence/` holds eight small CSV tables. Five are projections of documents that otherwise exist as JSON or JSONL:

| Table | Rows | Projects |
| --- | ---: | --- |
| `climate_advisories` | 6 | `external-signals/climate-advisories.jsonl` |
| `forecast_briefings` | 11 | `external-signals/forecast-briefings.jsonl` |
| `forecast_briefing_regions` | 66 | briefing x region detail, 11 x 6 |
| `signal_evidence_trace` | 5 | `external-signals/signal-evidence-trace.jsonl` |
| `weather_provider` | 1 | `external-signals/weather-provider.json` |

They exist because a data agent grounds on tabular sources and `fabio lakehouse load-table` accepts only Csv and Parquet. Without them the agent could quote the uplift percentage but could not cite the El Nino advisory, state its 0.78 persistence probability, walk the five-hop evidence chain, or cite the Meridian Climate Services attribution.

The JSONL remains the authored document form. The validator asserts the two never drift: row counts and ids must align, the advisory's persistence and horizon must match `scenario.json`, its affected regions must match the scenario signal split, and evidence-chain hops must stay contiguous.

### Single-query demo summaries

The remaining three tables exist for a different reason: **latency**. The data agent is cut off server-side at roughly 100 seconds, and each demo question originally spanned four or five tables across three sources, which exceeded that budget and failed with an HTTP 500. These tables perform the join once, at generation time, so each question is answerable in a single query:

| Table | Rows | Answers |
| --- | ---: | --- |
| `demand_signal_explanation` | 6 | Act 1: variance, modelled weather uplift, UV and temperature anomaly, the advisory and its provider, persistence probability, and the forecast horizon against the campaign window. One row per region, including the two control regions that separate signal from noise. |
| `campaign_decision_status` | 3 | Act 2: which scenario is recommended, whether any is approved, and the commitment, governed-action and receipt counts that show the decision is still open. |
| `capacity_conflict_summary` | 4 | Fabric walkthrough 3 (production conflict): shortfall, headroom, the maintenance window and its deferral, and projected stress against the policy ceiling. One row per production option. This is not the session's Act 3 workforce demonstration. |

Every value in them is derived from the same scenario as the rest of the
dataset. The validator checks the 57,920 shortfall, 28-day deferral, 111.26%
stress, 0.78 persistence, and the forecast horizon. They are convenience
projections, not a second source of truth.

`campaign_forecast_links` is a deliberate materialised bridge for the Act 1 evidence chain. The physical relationship from `Campaign` to `DemandForecast` spans `campaigns` -> `forecast_lines` -> `forecast_versions`, joined by region and product against the baseline forecast version. The Fabric ontology binding map can bind a contextualization table, but it cannot express that three-table derived join directly, so the bridge stores the six resolved campaign-to-forecast links.

### Stage views and reference queries

Fabric SQL stage views:

| View | Purpose |
| --- | --- |
| `dbo.vw_forecast_variance` | Regional forecast-vs-actual variance for the hero product and other products. |
| `dbo.vw_signal_evidence_chain` | Five-hop evidence trace for Demo 1. |
| `dbo.vw_campaign_scenarios` | Commercial scenario comparison for Demo 2. |
| `dbo.vw_capacity_conflict` | Capacity with and without maintenance, headroom, shortfall, and recommended plan units. |
| `dbo.vw_production_options` | Production options with policy evaluation fields. |
| `dbo.vw_impact_chain` | Maintenance-window impact resolved to line, orders, commitment, and revenue at risk. |
| `dbo.vw_decision_actions` | Governed actions joined to receipts and policies; empty for the open hero case in the default slice. |
| `dbo.vw_weather_anomaly_by_region` | Mean observed UV and temperature anomalies by region over the baseline variance window. |
| `dbo.vw_weather_demand_reconciliation` | Weather-model uplift compared with actual hero-product sales variance by region. |
| `dbo.vw_weather_events_relevant` | Weather events joined to regions and campaigns, with hero-product relevance labels. |
| `dbo.vw_weather_station_coverage` | Weather station metadata joined to region labels and signal-affected flags. |
| `dbo.vw_decision_case_summary` | Decision cases with trigger, campaign, policy, action, and outcome counts. |
| `dbo.vw_decision_case_lifecycle` | Ordered lifecycle rows for each decision case, including triggers, states, policies, actions, corrections, and outcomes where present. |
| `dbo.vw_decision_case_reuse` | Reuse-oriented decision-memory facts for future retrieval and reasoning. |

Fabric SQL bridge tables:

| Table | Purpose |
| --- | --- |
| `dbo.campaign_forecast_links` | Materialised bridge from campaigns to baseline demand forecasts for ontology binding and Act 1 evidence traversal. |

Eventhouse stage-query files are presenter references and are deliberately skipped by deployment:

| File | Presenter reference queries |
| --- | --- |
| `eventhouse/003_stage_queries.kql` | Regional forecast variance, climate anomaly separation, campaign performance, PKG-02 operating/stress behaviour, and state transitions for `CASE-2026-HS-001`. |
| `eventhouse/006_weather_stage_queries.kql` | Observed UV/temperature anomaly by region, decision-day forecast fan chart, forecast revision history, elasticity reconciliation to sales variance, and weather-event relevance discrimination. |

## Meridian weather data and attribution

> [!WARNING]
> Meridian Climate Services is a fictional attribution in a synthetic dataset. Do not present the observations, forecasts, events, or seasonal outlook as real meteorological data or as sourced from a public weather agency.

The `weather` block in `scenario.json` defines the provider, variables, climatology, observation windows, forecast archive, seasonal outlook, event catalogue, demand-response model, and per-region intensities.

| Item | Verified value |
| --- | --- |
| Provider | `WX-MCS-001`, "Meridian Climate Services", short name `MCS`, provenance `external`, daily refresh at `05:00:00` UTC. |
| Climatology | 10-year day-of-year normals for `2015-01-01` through `2024-12-31`; emitted as 2,196 rows in `fabric-sql/climate_normals.csv`. |
| Daily observations | 948 rows in `eventhouse/WeatherObservationsDaily.csv`: 6 regions x 158 days, `2026-02-27` through `2026-08-03`. The default slice is truncated at `clock.asOf`. |
| Hourly observations | 6,192 rows in `eventhouse/WeatherObservationsHourly.csv`: 6 regions x 43 days x 24 hours, `2026-06-22T00:00:00Z` through `2026-08-03T23:00:00Z`. The hourly series has diurnal cycles; all verified night rows have `uvIndex = 0`. |
| Forecast archive | 12,240 rows in `eventhouse/WeatherForecastDaily.csv.gz`: daily issues from `2026-05-28` through `2026-08-03`, 6 regions, lead days 1..30, target dates through `2026-09-02`. Temperature and UV p10/p50/p90 bands satisfy `p10 <= p50 <= p90` for all rows. |
| Events | 131 rows in `WeatherEvents.csv`, `weather_events.csv`, and `weather-events.jsonl`, covering all eight configured event types: `air_quality`, `cold_snap`, `enso_phase`, `heatwave`, `marine_heatwave`, `rain_storm`, `tropical_storm_watch`, and `uv_alert`. |
| Seasonal outlook | ENSO persistence through `2026-11-26` with probability 0.78. |

Daily weather observations include temperature min/max/mean, feels-like, heat index, UV index and alert level, humidity, precipitation, rain-day flag, cloud cover, sunshine hours, wind, sea-surface temperature, pressure, and anomalies versus climatology. Anomaly fields are `temperatureMeanAnomalyC`, `uvIndexAnomaly`, `humidityAnomalyPct`, `precipitationAnomalyMm`, `sunshineAnomalyHours`, and `seaSurfaceAnomalyC`.

`REG-CENTRAL` is landlocked. Its sea-surface fields are intentionally empty in station and daily observation data, not zero.

### Forecast and seasonal evidence horizon

The decision-day forecast issue is `2026-08-03`. With lead days 1..30, it covers target dates `2026-08-04` through `2026-09-02`. The campaign runs through `2026-10-02`, so the decision-day 30-day forecast must not be described as covering the full campaign.

Use two evidence tiers:

| Horizon | Evidence | Correct use |
| --- | --- | --- |
| Days 1-30 after decision day | Meridian Climate Services-attributed forecast with p10/p50/p90 bands. | Answers whether the anomaly is still present in the next few weeks. |
| Through `2026-11-26` | ENSO seasonal outlook with 78% persistence. | Answers whether the condition is expected to hold across and beyond the campaign. |
| Full campaign archive | Rolling daily forecast issues through `2026-08-03` in the default slice; later issues appear only when the outcome slice is generated. | Covers the campaign as issue dates roll forward, not from the single `2026-08-03` issue. |

Decision-day forecast behaviour for `uvIndexAnomaly_p50`:

| Region | Affected | `uvIndexAnomaly_p50` across `2026-08-04`..`2026-09-02` |
| --- | --- | ---: |
| `REG-COASTAL` | yes | +2.12 to +2.58 |
| `REG-SOUTH` | yes | +1.80 to +2.09 |
| `REG-DELTA` | yes | +1.35 to +1.53 |
| `REG-ISLAND` | yes | +1.75 to +1.99 |
| `REG-NORTH` | control | +0.08 to +0.11 |
| `REG-CENTRAL` | control | -0.07 to -0.04 |

Affected regions stay positive for the whole 30-day decision horizon. The two controls sit near zero, which shows the signal is regional rather than global.

### Demand-response model

The causal link in Demo 1 is the approved, versioned model `WXMODEL-UPLIFT-001`:

```text
upliftPct = 8.0 * uvIndexAnomaly + 3.4 * temperatureMeanAnomalyC
```

`betaUv = 8.0` means percentage-point uplift per UV-index point above normal. `betaTempC = 3.4` means percentage-point uplift per degree Celsius above normal. The coefficients are global (`coefficientsAreGlobal = true`), so all differences by region come from regional UV and temperature anomalies, not from region-specific coefficients.

The weather was calibrated so this model reproduces the already-frozen hero-product sales variance exactly over the `2026-06-22`..`2026-08-02` variance window:

| Region | Modelled weather uplift | Actual sales variance | Difference |
| --- | ---: | ---: | ---: |
| `REG-COASTAL` | 31.4% | 31.4% | 0 |
| `REG-SOUTH` | 26.8% | 26.8% | 0 |
| `REG-DELTA` | 18.9% | 18.9% | 0 |
| `REG-ISLAND` | 22.5% | 22.5% | 0 |
| `REG-NORTH` | 1.2% | 1.2% | 0 |
| `REG-CENTRAL` | -0.8% | -0.8% | 0 |

This is the evidence that turns the Act 1 claim from asserted correlation into a demonstrated causal chain: regional weather anomaly -> global demand-response model -> region-level uplift -> actual sales variance.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 24 or later | Required because the tooling runs `.ts` files directly with native TypeScript type stripping. There is no build step and no TypeScript compiler is required. This checkout was verified with Node.js `v24.16.0`. |
| `fabio` CLI | Required for deployment to Fabric. Use `fabio 0.71.0` or later so `--with-cosmos` can create containers and load Cosmos DB documents. |
| Microsoft Fabric workspace | Use an existing workspace ID or display name, or provide a capacity ID so the script can create a workspace when needed. |
| Fabric permissions | The operator must be able to create/read Fabric items and load data into Lakehouse, Eventhouse/KQL database, Fabric SQL Database, semantic model, ontology, and data agent items. `--with-cosmos` also requires permission and tenant availability to create a Fabric-native Cosmos DB database item, containers, and documents. |
| PowerShell 7+ | Required only for the PowerShell deployment entry point. |

The scripts also read `FABIO_WORKSPACE` and `FABIO_CAPACITY` as defaults for the workspace and capacity values.

## Compression and staging

Large CSV support is implemented in `tools/lib/packing.ts`. The generator compresses every payload file at or above 1 MiB to `.gz` because the repository does not use Git LFS and raw time-series files are large. Fabio deployment expects uncompressed CSV files, so deployment runs `tools/expand.ts` to gunzip committed payloads into `data/.staging/` before import.

The six payloads currently stored gzipped in Git are:

| Logical payload | Stored file |
| --- | --- |
| `eventhouse/CampaignSignals.csv` | `eventhouse/CampaignSignals.csv.gz` |
| `eventhouse/ForecastActualDaily.csv` | `eventhouse/ForecastActualDaily.csv.gz` |
| `eventhouse/LineSignals.csv` | `eventhouse/LineSignals.csv.gz` |
| `eventhouse/SalesObservations.csv` | `eventhouse/SalesObservations.csv.gz` |
| `eventhouse/WeatherForecastDaily.csv` | `eventhouse/WeatherForecastDaily.csv.gz` |
| `fabric-sql/sales_order_lines.csv` | `fabric-sql/sales_order_lines.csv.gz` |

`tools/expand.ts` handles both compressed and plain payloads:

- `.gz` payloads are decompressed into the staging directory with the `.gz` suffix removed.
- Plain payload files are copied unchanged.
- `--clean` removes the staging directory before expansion.

## Usage

Run these commands from `data/` unless noted otherwise.

### Generate payloads

Do not regenerate during normal deployment unless you intentionally changed `scenario.json`.

Default as-of slice:

```bash
node tools/generate.ts
```

Outcome reveal slice:

```bash
node tools/generate.ts --with-outcome
```

The generator cleans generated payloads, recreates Fabric SQL, Eventhouse, Lakehouse, evaluation, and receipt files, then compresses payloads at or above 1 MiB by default.

To leave every generated file uncompressed:

```bash
node tools/generate.ts --no-pack
```

### Validate payloads

```bash
node tools/validate.ts
```

The validator streams CSV/JSONL data, transparently reads gzipped payloads, validates structure and primary keys, checks foreign keys and cross-file references, verifies narrative invariants, enforces payload cleanliness, checks evaluation expectations and retrieval probes, validates ontology bindings, validates Direct Lake semantic model metadata, checks decision-memory relational consistency, and confirms the manifest path set. The validated default-slice result is `322 passed, 0 failed`; any failed check exits non-zero.

### Refresh and check the manifest

Write `data/manifest.json`:

```bash
node tools/manifest.ts
```

Verify that `data/manifest.json` still matches the payload files on disk:

```bash
node tools/manifest.ts --check
```

The manifest records 91 deployable files, SHA-256 hashes, byte sizes, generator seed, schema version, and local dataset metadata.

### Expand payloads for deployment

Default staging path:

```bash
node tools/expand.ts
```

Clean and expand into an explicit staging directory:

```bash
node tools/expand.ts --out .staging --clean
```

From the repository root, use:

```bash
node data/tools/expand.ts --out data/.staging --clean
```

### Deploy to Microsoft Fabric

From the repository root:

```bash
./create-data.sh --workspace <id-or-name>
```

PowerShell uses the same Unix-style flags because `create-data.ps1` parses `$args` directly:

```powershell
pwsh ./create-data.ps1 --workspace <id-or-name>
```

Use `--workspace`; PowerShell-style `-Workspace` is not accepted by the script.

Common deployment options for both scripts:

| Option | Meaning |
| --- | --- |
| `--workspace <value>` | Fabric workspace ID or display name. Defaults to `FABIO_WORKSPACE`. Required if the environment variable is not set. |
| `--capacity <value>` | Fabric capacity ID used only if the script creates a workspace. Defaults to `FABIO_CAPACITY`. |
| `--prefix <value>` | Item name prefix. Defaults to `Caldova`, creating `CaldovaAnalytics`, `CaldovaSignals`, `CaldovaOperations`, `CaldovaDecisionMemory`, `CaldovaBusinessMeaning`, `CaldovaLaunchModel`, and `CaldovaAnalyst`. |
| `--staging <dir>` | Uncompressed staging directory. Defaults to `data/.staging`. |
| `--dry-run` | Runs local preparation and prints planned `fabio` commands without remote calls. |
| `--skip-generate` | Uses committed files as-is. This is the default. |
| `--regenerate` | Runs `node data/tools/generate.ts` before manifest checking, validation, expansion, and deployment. |
| `--overwrite` | Allows replacing or reloading existing target data. Without this flag, the scripts protect non-empty SQL/KQL tables and existing Lakehouse dashboard tables. |
| `--verify-only` | Runs post-load verification against existing Fabric items without local generation, manifest validation, payload validation, expansion, or loading. |
| `--with-cosmos` | Also provisions a Fabric-native Cosmos DB for NoSQL database item named `<prefix>DecisionMemory`. This is opt-in because Cosmos DB in Fabric may not be enabled in every tenant. With `fabio 0.71.0` or later, the scripts create the `decision-cases` and `decision-timeline` containers and import the decision-case documents. |
| `--skip-fabric-items` | Skips ontology, semantic model, and data agent deployment/verification while still loading the data stores. |
| `--evaluate-agent` | Runs the published data-agent evaluation questions after deployment. |
| `-h`, `--help` | Shows script usage. |

Dry-run examples:

```bash
./create-data.sh --workspace <id-or-name> --dry-run
```

```powershell
pwsh ./create-data.ps1 --workspace <id-or-name> --dry-run
```

Both dry-run entry points exit 0 and print the same deployment plan and summary.

Cosmos opt-in dry-run:

```bash
./create-data.sh --workspace <id-or-name> --with-cosmos --dry-run
```

With `--with-cosmos`, the summary includes `Cosmos DB database: CaldovaDecisionMemory (<CaldovaDecisionMemory-id>)`; with `fabio 0.71.0` or later, the deployment also creates the decision-case containers and imports the documents into Cosmos DB.

Overwrite examples:

```bash
./create-data.sh --workspace <id-or-name> --overwrite
```

```powershell
pwsh ./create-data.ps1 --workspace <id-or-name> --overwrite
```

## NPM scripts

`data/package.json` exposes these scripts:

| Script | Command | Use |
| --- | --- | --- |
| `npm run generate` | `node tools/generate.ts` | Regenerate all payloads and gzip large files. |
| `npm run validate` | `node tools/validate.ts` | Run all dataset checks. |
| `npm run manifest` | `node tools/manifest.ts` | Rewrite `data/manifest.json`. |
| `npm run all` | `node tools/generate.ts && node tools/validate.ts && node tools/manifest.ts` | Regenerate, validate, and refresh the manifest. |

## Record inventory

Current generated default-slice record totals:

| Target group | Records |
| --- | ---: |
| Fabric SQL Database | 223,634 |
| Eventhouse/KQL | 472,063 |
| Lakehouse/OneLake, evaluation, and receipts | 1,762 |
| **Total** | **697,459** |

Sizes below are manifest byte counts from the committed payload state. Row counts for `.csv.gz` files are logical uncompressed CSV rows excluding the header. JSON counts are logical top-level records, for example four demo expected-result objects in `expected-results.json`.

| Target | File | Records | Bytes |
| --- | --- | ---: | ---: |
| Fabric SQL Database | `data/fabric-sql/action_receipts.csv` | 0 | 91 |
| Fabric SQL Database | `data/fabric-sql/approved_policies.csv` | 4 | 1,178 |
| Fabric SQL Database | `data/fabric-sql/campaign_commitments.csv` | 0 | 143 |
| Fabric SQL Database | `data/fabric-sql/campaign_forecast_links.csv` | 6 | 615 |
| Fabric SQL Database | `data/fabric-sql/campaign_scenarios.csv` | 3 | 1,027 |
| Fabric SQL Database | `data/fabric-sql/campaigns.csv` | 6 | 721 |
| Fabric SQL Database | `data/fabric-sql/capacity_plan.csv` | 82 | 5,923 |
| Fabric SQL Database | `data/fabric-sql/climate_normals.csv` | 2,196 | 212,893 |
| Fabric SQL Database | `data/fabric-sql/decision_case_actions.csv` | 0 | 26 |
| Fabric SQL Database | `data/fabric-sql/decision_case_campaigns.csv` | 4 | 312 |
| Fabric SQL Database | `data/fabric-sql/decision_case_policies.csv` | 11 | 445 |
| Fabric SQL Database | `data/fabric-sql/decision_case_states.csv` | 34 | 2,579 |
| Fabric SQL Database | `data/fabric-sql/decision_case_triggers.csv` | 10 | 556 |
| Fabric SQL Database | `data/fabric-sql/decision_cases.csv` | 9 | 1,812 |
| Fabric SQL Database | `data/fabric-sql/decision_corrections.csv` | 0 | 98 |
| Fabric SQL Database | `data/fabric-sql/decision_outcomes.csv` | 8 | 1,087 |
| Fabric SQL Database | `data/fabric-sql/external_signals.csv` | 1 | 331 |
| Fabric SQL Database | `data/fabric-sql/forecast_assumptions.csv` | 5 | 544 |
| Fabric SQL Database | `data/fabric-sql/forecast_lines.csv` | 72 | 3,495 |
| Fabric SQL Database | `data/fabric-sql/forecast_versions.csv` | 2 | 294 |
| Fabric SQL Database | `data/fabric-sql/governed_actions.csv` | 0 | 136 |
| Fabric SQL Database | `data/fabric-sql/inventory_positions.csv` | 5,580 | 280,935 |
| Fabric SQL Database | `data/fabric-sql/launch_plans.csv` | 1 | 107 |
| Fabric SQL Database | `data/fabric-sql/maintenance_policy_evaluations.csv` | 4 | 477 |
| Fabric SQL Database | `data/fabric-sql/maintenance_windows.csv` | 6 | 900 |
| Fabric SQL Database | `data/fabric-sql/material_reservations.csv` | 17,887 | 778,313 |
| Fabric SQL Database | `data/fabric-sql/metric_definitions.csv` | 4 | 583 |
| Fabric SQL Database | `data/fabric-sql/personas.csv` | 3 | 251 |
| Fabric SQL Database | `data/fabric-sql/plants.csv` | 2 | 112 |
| Fabric SQL Database | `data/fabric-sql/production_lines.csv` | 6 | 700 |
| Fabric SQL Database | `data/fabric-sql/production_options.csv` | 4 | 2,367 |
| Fabric SQL Database | `data/fabric-sql/production_orders.csv` | 8,601 | 685,403 |
| Fabric SQL Database | `data/fabric-sql/products.csv` | 6 | 419 |
| Fabric SQL Database | `data/fabric-sql/regions.csv` | 6 | 420 |
| Fabric SQL Database | `data/fabric-sql/sales_order_lines.csv.gz` | 186,859 | 1,700,576 |
| Fabric SQL Database | `data/fabric-sql/scenario_region_allocation.csv` | 12 | 652 |
| Fabric SQL Database | `data/fabric-sql/shift_schedules.csv` | 1,110 | 30,220 |
| Fabric SQL Database | `data/fabric-sql/signal_region_impact.csv` | 4 | 234 |
| Fabric SQL Database | `data/fabric-sql/weather_demand_response.csv` | 948 | 75,321 |
| Fabric SQL Database | `data/fabric-sql/weather_elasticity_params.csv` | 1 | 491 |
| Fabric SQL Database | `data/fabric-sql/weather_events.csv` | 131 | 23,801 |
| Fabric SQL Database | `data/fabric-sql/weather_stations.csv` | 6 | 763 |
| Eventhouse/KQL | `data/eventhouse/CampaignSignals.csv.gz` | 22,320 | 61,109 |
| Eventhouse/KQL | `data/eventhouse/ClimateSignalObservations.csv` | 570 | 41,436 |
| Eventhouse/KQL | `data/eventhouse/ForecastActualDaily.csv.gz` | 22,320 | 187,269 |
| Eventhouse/KQL | `data/eventhouse/InventorySnapshots.csv` | 5,580 | 335,157 |
| Eventhouse/KQL | `data/eventhouse/LineSignals.csv.gz` | 267,840 | 1,255,078 |
| Eventhouse/KQL | `data/eventhouse/PlanStateTransitions.csv` | 2 | 280 |
| Eventhouse/KQL | `data/eventhouse/SalesObservations.csv.gz` | 133,920 | 830,913 |
| Eventhouse/KQL | `data/eventhouse/WeatherEvents.csv` | 131 | 24,074 |
| Eventhouse/KQL | `data/eventhouse/WeatherForecastDaily.csv.gz` | 12,240 | 296,084 |
| Eventhouse/KQL | `data/eventhouse/WeatherObservationsDaily.csv` | 948 | 177,048 |
| Eventhouse/KQL | `data/eventhouse/WeatherObservationsHourly.csv` | 6,192 | 606,999 |
| Lakehouse/OneLake | `data/evaluation/expected-results.json` | 4 | 9,035 |
| Lakehouse/OneLake | `data/evaluation/questions.json` | 4 | 3,638 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/campaign-performance.csv` | 6 | 1,000 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/forecast-assumptions.csv` | 5 | 580 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/forecast-variance-by-region.csv` | 6 | 577 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/hero-demand-trend.csv` | 924 | 77,204 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/weather-anomaly-by-region.csv` | 6 | 1,177 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/weather-demand-reconciliation.csv` | 6 | 954 |
| Lakehouse/OneLake | `data/lakehouse/dashboard/weather-forecast-outlook.csv` | 180 | 29,289 |
| Lakehouse/OneLake | `data/lakehouse/decision-cases/decision-case-timeline.jsonl` | 5 | 1,724 |
| Lakehouse/OneLake | `data/lakehouse/decision-cases/decision-cases.jsonl` | 9 | 22,909 |
| Lakehouse/OneLake | `data/lakehouse/evidence/climate_advisories.csv` | 6 | 3,118 |
| Lakehouse/OneLake | `data/lakehouse/evidence/forecast_briefing_regions.csv` | 66 | 5,077 |
| Lakehouse/OneLake | `data/lakehouse/evidence/forecast_briefings.csv` | 11 | 7,410 |
| Lakehouse/OneLake | `data/lakehouse/evidence/signal_evidence_trace.csv` | 5 | 3,378 |
| Lakehouse/OneLake | `data/lakehouse/evidence/weather_provider.csv` | 1 | 266 |
| Lakehouse/OneLake | `data/lakehouse/external-signals/climate-advisories.jsonl` | 6 | 4,643 |
| Lakehouse/OneLake | `data/lakehouse/external-signals/forecast-briefings.jsonl` | 11 | 34,454 |
| Lakehouse/OneLake | `data/lakehouse/external-signals/signal-evidence-trace.jsonl` | 5 | 3,474 |
| Lakehouse/OneLake | `data/lakehouse/external-signals/weather-events.jsonl` | 131 | 117,230 |
| Lakehouse/OneLake | `data/lakehouse/external-signals/weather-provider.json` | 1 | 3,126 |
| Lakehouse/OneLake | `data/lakehouse/retrieval/retrieval-corpus.jsonl` | 351 | 199,435 |
| Lakehouse/OneLake | `data/lakehouse/retrieval/retrieval-probes.jsonl` | 5 | 1,637 |
| Lakehouse/OneLake | `data/receipts/action-receipts.json` | 8 | 6,333 |

## Determinism and integrity

The generator reads `scenario.json` and uses `generatorSeed: 20270607` to seed deterministic pseudo-random streams. Writers emit stable CSV, JSON, and JSONL with LF line endings and trailing newlines so regeneration is byte-reproducible across supported platforms.

`tools/manifest.ts` records dataset metadata plus SHA-256 and byte size for every deployable payload file. Use it whenever payload files change:

```bash
node tools/manifest.ts
node tools/manifest.ts --check
```

`--check` compares current files to `data/manifest.json` and reports added, changed, or removed payloads. The validator also checks that the manifest path set matches the files on disk.

## Changing the scenario

Treat `scenario.json` as the single source of truth.

1. Edit `data/scenario.json`.
2. Bump `schemaVersion`.
3. Regenerate payloads:

   ```bash
   node tools/generate.ts
   ```

4. Validate:

   ```bash
   node tools/validate.ts
   ```

5. Refresh and check the manifest:

   ```bash
   node tools/manifest.ts
   node tools/manifest.ts --check
   ```

Demo numbers appear in `.prep/deck.md`, `.prep/act1.md`, and the presenter talk
track. If you change values such as the $800,000 opportunity, 100,000-unit
recommended campaign volume, 57,920-unit shortfall, 28-day deferral, 111.26%
stress result, or the 2026-08-03 snapshot date, update the deck narrative and
demo prompts at the same time.

## Stage-critical IDs

| Category | IDs | Notes |
| --- | --- | --- |
| Hero product | `PROD-HS-100` | Hydration Sunscreen. Unit price: $8.00. |
| Affected regions | `REG-COASTAL`, `REG-SOUTH`, `REG-DELTA`, `REG-ISLAND` | Four of six regions above forecast and affected by the advisory. |
| Control regions | `REG-NORTH`, `REG-CENTRAL` | Unaffected regions used as controls. |
| External signal | `SIG-ENSO-2026-07` | Persistent El Nino advisory from Meridian Climate Services attribution in the payload. |
| Weather provider | `WX-MCS-001` | Meridian Climate Services (`MCS`), provenance `external`, daily issue time `05:00:00` UTC. Documentation discloses this is generated demo data; payload rows do not carry disclosure labels. |
| Weather demand model | `WXMODEL-UPLIFT-001` | Approved v1.0 global model: `upliftPct = 8.0 * uvIndexAnomaly + 3.4 * temperatureMeanAnomalyC`. |
| Weather decision horizon | Issue `2026-08-03`; target dates `2026-08-04` through `2026-09-02`; lead days 1..30 | Near-term forecast horizon only. It does not cover the full campaign ending `2026-10-02`. |
| Weather seasonal outlook | `SIG-ENSO-2026-07`; persistence through `2026-11-26`; probability 0.78 | ENSO outlook carries the Act 1 persistence claim across the campaign after the 30-day forecast ends. |
| Future retrieval signal | `SIG-ENSO-2027-04` | Future probe that should retrieve `CASE-2026-HS-001`. |
| Launch plan | `LP-2026-SUN` | Sun Care Season 2026; `2026-04-27` through `2026-11-26`. |
| Forecast versions | Baseline `2026.07.20-1`, revised `2026.08.03-2`; baseline evidence entity `FC-2026-0720-HS` | Baseline forecast assumptions `ASM-001` and `ASM-002` are invalidated by the signal. |
| Campaign forecast bridge | `campaign_forecast_links`; baseline forecast entity `FC-2026-0720-HS` | Six materialised campaign-to-baseline-forecast links used by the Act 1 ontology relationship. |
| Campaign IDs | `CMP-2026-COASTAL-FIELD`, `CMP-2026-SOUTH-DIGITAL`, `CMP-2026-DELTA-DIGITAL`, `CMP-2026-ISLAND-PARTNER`, `CMP-2026-NORTH-DIGITAL`, `CMP-2026-CENTRAL-PARTNER` | Four affected-region campaigns plus two controls. |
| Decision-case campaign bridge | `decision_case_campaigns`; `CASE-2026-HS-001` -> `CMP-2026-COASTAL-FIELD`, `CMP-2026-SOUTH-DIGITAL`, `CMP-2026-DELTA-DIGITAL`, `CMP-2026-ISLAND-PARTNER` | Many-to-many case-to-campaign relationship for the four signal-affected regions. |
| Campaign scenarios | `SCN-2026-HS-A`, `SCN-2026-HS-B`, `SCN-2026-HS-C` | `SCN-2026-HS-B` is recommended but not approved by default; `SCN-2026-HS-C` is blocked by commercial policy. |
| Commitment | `CMT-2026-HS-001` | Outcome-slice commitment for 100,000 units and $800,000 revenue. No default `campaign_commitments` row exists. |
| Plants | `PLANT-01`, `PLANT-02` | Northgate and Coastway packaging plants. |
| Production line | `PKG-02` | Preferred Sun Care line for Hydration Sunscreen and the conflict line. |
| Maintenance window | `MW-PKG-02-2026-09` | Original dates `2026-09-07` to `2026-09-11`; deferred to `2026-10-05` to `2026-10-09` in the recommended plan and outcome slice. |
| Production options | `OPT-1`, `OPT-2`, `OPT-3`, `OPT-4` | `OPT-4` is recommended; `OPT-3` is blocked because full-rate deferral permits zero days. |
| Policies | `POL-SUPPLY-001:1.0`, `POL-MAINT-002:2.1`, `POL-CAPACITY-003:1.3`, `POL-COMMERCIAL-004:1.0` | Maintenance deferral, capacity, supply, and commercial approval guardrails. |
| Governed actions | `ACT-CAMPAIGN-001`, `ACT-PROD-002`, `ACT-MAINT-003` | Outcome-slice campaign commitment, production plan change, and maintenance deferral for `CASE-2026-HS-001`. Default governed-action tables are empty. |
| Canonical receipts | `RCPT-CMP-2026-0807-001`, `RCPT-PRD-2026-0810-002`, `RCPT-MNT-2026-0810-003` | Outcome-slice receipts proving the three governed actions for `CASE-2026-HS-001`; the default `receipts/action-receipts.json` contains eight historical background receipts. |
| Decision case | `CASE-2026-HS-001` | Main decision-memory record; open in the default slice and resolved only in the outcome slice. |
| Decision-memory relational tables | `decision_cases`, `decision_case_states`, `decision_case_triggers`, `decision_case_policies`, `decision_case_campaigns`, `decision_corrections`, `decision_outcomes`, `decision_case_actions` | Queryable Fabric SQL decision memory backing the ontology and semantic model paths. |
| Correction | `CORR-2026-001` | Outcome-slice correction adding an ENSO persistence check for future Sun Care forecasts in coastal and southern regions. |
| Outcomes | `OUT-DEMAND-001`, `OUT-REVENUE-002`, `OUT-MAINT-003`, `OUT-SERVICE-004` | Outcome-slice demand met, revenue realised, stress within ceiling, and no existing commitments missed. |

## Safety

- Use empty demonstration resources and least-privilege identities only.
- Never put credentials, tenant identifiers, or customer evidence on screen.
- Approval fields use role identifiers such as `ROLE-COMMERCIAL-APPROVER`. Persona names are fictional characters and appear only where labelled.
- Never present a recommendation as an approved decision. In the default dataset, nothing is approved and no commitment exists, so an agent that claims one exists is wrong and can be shown to be wrong.
- Never present the Meridian Climate Services-attributed El Nino advisory as a real climate forecast or public-agency feed. The dataset is synthetic; the payload attribution is realistic only to keep grounded demo answers from quoting disclosure text.

### Disclosure is delivered out of band, not inside the payload

The payload keeps `provenance` (`external` / `internal`), which is a genuine enterprise lineage concept, and realistic attribution: the weather feed is **Meridian Climate Services** (`WX-MCS-001`, short name `MCS`). It deliberately does not keep synthetic-disclosure fields or provider names that say "synthetic".

This does not license presenting the data as real. The obligation is unchanged; only its delivery moved. Say plainly on stage that Caldova is fictional and the data is generated for a Microsoft AI Tour session. Do not describe the El Nino advisory as a real climate forecast.
