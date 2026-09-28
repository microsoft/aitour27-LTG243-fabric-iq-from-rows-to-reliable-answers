# CaldovaLaunch semantic model

This folder contains the generated Power BI semantic model item for the shared LTG243
Caldova launch demos. The authored source of truth is
`src/fabric/semantic-model-source/model.bim` (TMSL JSON), outside this item
folder because Fabric rejects an item that contains both TMSL and TMDL with
`You cannot have both TMDL and TMSL formats in the same PBIP`.
`data/tools/build-semantic-model.ts` projects that source into the `definition/`
TMDL folder that Fabric requires for Direct Lake deployment.

`definition/` and `definition.pbism` are **generated and not tracked in git**.
The converter deletes and re-emits the whole folder on every run, and
`create-data.sh` runs it before every deployment, so the tree is always rebuilt
rather than reviewed. Only `.platform` and this README are authored. Review
model changes in `model.bim`, which is the tracked source of truth.

## Storage mode

The authored `src/fabric/semantic-model-source/model.bim` defines Direct Lake
over the Caldova Lakehouse Delta tables. Each table partition uses
`mode: directLake` and `source.entityName` equal to the Lakehouse table name.
The generated TMDL uses the required `definition/expressions.tmdl`
`DatabaseQuery` M expression:

```tmdl
expression DatabaseQuery =
		let
		    database = Sql.Database("<SQL_ENDPOINT_HOST>", "<SQL_ENDPOINT_ID>")
		in
		    database
```

Generate with workspace-specific endpoint values:

```bash
node data/tools/build-semantic-model.ts \
  --sql-endpoint-host "<sql-endpoint-host>" \
  --sql-endpoint-id "<sql-endpoint-id>"
```

If either argument is omitted, the converter emits
`__SQL_ENDPOINT_HOST__` / `__SQL_ENDPOINT_ID__` placeholders and prints a
warning. Replace those placeholders before deployment. `create-data.sh` supplies
both arguments from the resolved Lakehouse SQL endpoint, so a normal deployment
never sees the placeholders.

## Included Lakehouse tables

The authored `model.bim` includes **46 Direct Lake tables**, **82 measures** and
**71 relationships**. The decision-memory additions are `decision_cases`,
`decision_case_states`, `decision_case_triggers`, `decision_case_policies`,
`decision_case_campaigns`, `decision_corrections`, `decision_outcomes`, and
`decision_case_actions`. They make the Fabric decision-memory walkthrough answerable from the semantic model by
grounding past decisions, approvals, lessons learned, receipts and outcomes.
`decision_case_campaigns` is a bridge table, because the 2027 Hydration
Sunscreen case concerns four signal-affected campaigns rather than one, and it
carries the `Campaigns Affected By Decision Case` measure.

`regions,products,campaigns,launch_plans,forecast_versions,forecast_lines,forecast_assumptions,campaign_scenarios,campaign_commitments,scenario_region_allocation,inventory_positions,plants,production_lines,production_orders,maintenance_windows,maintenance_policy_evaluations,production_options,capacity_plan,approved_policies,metric_definitions,governed_actions,action_receipts,external_signals,signal_region_impact,weather_stations,weather_events,weather_demand_response,weather_elasticity_params,sales_order_lines,WeatherObservationsDaily,WeatherForecastDaily,ForecastActualDaily,CampaignSignals,ClimateSignalObservations,InventorySnapshots,LineSignals,PlanStateTransitions,WeatherEvents,decision_cases,decision_case_states,decision_case_triggers,decision_case_policies,decision_corrections,decision_outcomes,decision_case_actions`

These tables cover the four demo questions: Hydration Sunscreen demand, weather uplift and persistence, campaign investment, governed approvals, maintenance/capacity trade-offs, receipts, decision memory, approved corrections, and operational telemetry.

The generated TMDL definition deploys. The verified live model preserves the 46
tables, 82 measures, 71 relationships, and table/column/measure descriptions
from the authored source. DAX against that model returns the demo contract
values: shortfall 57,920 units, permitted deferral 28 days, projected stress
111.26%, opportunity 100,000 units / $800,000, and affected regional variances
31.4 / 26.8 / 22.5 / 18.9 with controls at 1.2 / -0.8.

## Generated TMDL layout

The generated definition has the Fabric Direct Lake layout verified from a
working tenant model. None of it is tracked in git:

```text
definition.pbism
definition/database.tmdl
definition/model.tmdl
definition/expressions.tmdl
definition/relationships.tmdl
definition/tables/<TableName>.tmdl
```

`definition/relationships.tmdl` is used because TMDL defines one canonical root
file for all model relationships. The converter carries over all authored table
and column descriptions, measures with DAX expressions, format strings and
display folders, relationship inactive state and bidirectional filtering.

Synonyms are not deployed. TMDL rejects the JSON `linguisticMetadata` payload:
without `contentType` it assumes XML and reports that the payload `does not
comply with the Xml content-type`, while `contentType` itself is refused as an
unsupported property. Cultures are opt-in via `--with-cultures` and are
currently omitted. Descriptions still deploy and are the primary
agent-grounding surface.

One redundant dimension-to-dimension relationship, `forecast_versions` ->
`products`, is deactivated because Power BI permits only one active filter path.

Validate the generated definition before deployment:

```bash
fabio item validate-definition \
  --type SemanticModel \
  --dir src/fabric/CaldovaLaunch.SemanticModel \
  --strict
```

## Deployment command

Create the semantic model from the generated TMDL definition:

```bash
SQL_ENDPOINT_HOST="<sql-endpoint-host>"
SQL_ENDPOINT_ID="<sql-endpoint-id>"

node data/tools/build-semantic-model.ts \
  --sql-endpoint-host "$SQL_ENDPOINT_HOST" \
  --sql-endpoint-id "$SQL_ENDPOINT_ID"

fabio semantic-model create \
  --workspace "$WORKSPACE_ID" \
  --name "CaldovaLaunchModel" \
  --description "Direct Lake semantic model for Caldova Hydration Sunscreen demand, campaign and capacity demos." \
  --definition "src/fabric/CaldovaLaunch.SemanticModel"
```

Do not replace this with `fabio semantic-model generate --lakehouse <id> --all`.
That service-generated path creates a deployable Direct Lake shell but does not
preserve the authored 82 measures and descriptions.

A separate TMSL issue was already fixed in `model.bim`: TMSL rejects a bare
`cardinality` property on relationships with
`Unrecognized JSON property: cardinality`. Use `fromCardinality` and
`toCardinality`, or omit cardinality because many-to-one is the default.

## Refresh requirement

Direct Lake models must be framed before queries work. After creating the model
or after Delta table schema changes, run:

```bash
fabio semantic-model refresh --workspace "$WORKSPACE_ID" --id "$SEMANTIC_MODEL_ID"
```

The signed-in identity must be able to access the semantic model through the
public Fabric and Power BI service surfaces.
