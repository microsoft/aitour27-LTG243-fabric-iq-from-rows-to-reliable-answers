# CaldovaAnalyst Data Agent

`CaldovaAnalyst` answers:

> What's driving the increase in Hydration Sunscreen sales, and is it likely to
> continue?

It uses the semantic model for governed measures, KQL for time-series evidence,
the Lakehouse for narrative evidence, and the Fabric IQ ontology for business
relationships.

## Files

| File | Purpose |
| --- | --- |
| `agent.json` | Agent name, sources, selected elements, and deployment settings |
| `instructions.md` | Grounding and answer rules |
| `fewshots/semantic-model.json` | Reference DAX examples |
| `fewshots/kql.json` | KQL examples uploaded during deployment |
| `fewshots/lakehouse.json` | Lakehouse SQL examples uploaded during deployment |
| `fewshots/ontology.json` | Example ontology search prompts |

## Sources

| Fabric item | Use |
| --- | --- |
| `CaldovaLaunchModel` | Named measures and governed totals |
| `CaldovaSignals` | Daily sales, forecast, weather, and line signals |
| `CaldovaAnalytics` | Evidence tables, decision records, and source attribution |
| `CaldovaBusinessMeaning` | Entity and relationship traversal through ontology search or MCP |

The ontology is a peer surface rather than an attached Data Agent source.
Semantic-model few-shots are reference material because that source type does
not accept uploaded examples. The deployment script uploads the KQL and
Lakehouse few-shots.

## Deploy

Use the repository deployment script; it creates, configures, and publishes the
Data Agent after the data sources are ready:

```sh
./create-data.sh --workspace <workspace-id> --dry-run
./create-data.sh --workspace <workspace-id>
```

PowerShell:

```powershell
pwsh ./create-data.ps1 --workspace <workspace-id> --dry-run
pwsh ./create-data.ps1 --workspace <workspace-id>
```

## Verify

```sh
./create-data.sh --workspace <workspace-id> --verify-only --evaluate-agent
```

You can also run the question directly:

```sh
fabio data-agent query \
  --workspace <workspace-id> \
  --id <data-agent-id> \
  --prompt "What's driving the increase in Hydration Sunscreen sales, and is it likely to continue?"
```

Check that the answer includes:

- `SIG-ENSO-2026-07`;
- four affected regions and two control regions;
- 100,000 incremental units and $800,000 incremental revenue;
- a `0.78` persistence probability;
- `SCN-2026-HS-B` as recommended and not yet approved;
- the 30-day forecast horizon and the longer campaign and seasonal outlook;
- source rows supporting the answer.

The wording can vary; the facts and sources are what matter.
