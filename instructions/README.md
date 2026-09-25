# Deploy and run the LTG243 demo

This guide deploys the synthetic Caldova Fabric environment used by LTG243. Use
an empty or disposable workspace and start with the dry run.

## What this deploys

Everything runs in Microsoft Fabric. The script creates a Lakehouse,
Eventhouse/KQL database, Fabric SQL Database, Fabric IQ ontology, Direct Lake
semantic model, and Fabric data agent in the selected workspace. No separate
Azure application or Azure SQL server is required.

## Prerequisites

- Node.js 24 or later.
- [Fabio CLI](https://github.com/iemejia/fabio) 0.71.0 or later.
- Bash on macOS/Linux, or PowerShell 7 or later on Windows.
- Access to a Microsoft Fabric tenant with capacity and an empty or disposable
  workspace.
- Permission to create, read, update, publish, and load:
  - Lakehouse;
  - Eventhouse and KQL database;
  - Fabric SQL Database;
  - Fabric IQ ontology;
  - Direct Lake semantic model;
  - Fabric data agent.

No credentials, tenant IDs, workspace IDs, or item IDs are stored in the
repository.

## 1. Validate locally

From the repository root:

```sh
node --version
fabio --version
node data/tools/manifest.ts --check
node data/tools/validate.ts
```

Expected local results:

- `PASS manifest.json matches 94 files on disk.`
- `322 passed, 0 failed.`

The validator checks the scenario, relationships, Fabric definitions, expected
answers, and manifest.

## 2. Authenticate and select a workspace

```sh
fabio auth login --browser
fabio auth status
fabio workspace show --id <workspace-id> -o table
```

Use the workspace ID when possible and confirm that it is the workspace you
intend to use for the demo.

## 3. Preview the deployment

Bash:

```sh
./create-data.sh --workspace <workspace-id> --dry-run
```

PowerShell:

```powershell
pwsh ./create-data.ps1 --workspace <workspace-id> --dry-run
```

The dry run validates the files and prints the Fabio commands without changing
Fabric. Check the workspace and item names before continuing.

## 4. Deploy

Bash:

```sh
./create-data.sh --workspace <workspace-id>
```

PowerShell:

```powershell
pwsh ./create-data.ps1 --workspace <workspace-id>
```

The scripts load dependencies in order and then verify the Fabric estate. The
default names are:

- `CaldovaAnalytics`
- `CaldovaSignals`
- `CaldovaOperations`
- `CaldovaBusinessMeaning`
- `CaldovaLaunchModel`
- `CaldovaAnalyst`

Use `--prefix <value>` for another presenter in the same workspace. Use
`--overwrite` only when you intend to replace data in a disposable workspace.

LTG243 does not need `--with-cosmos`. That option belongs to a broader shared
fixture and is intentionally outside the lightning-talk path.

## 5. Verify the deployed estate

```sh
./create-data.sh --workspace <workspace-id> --verify-only
./create-data.sh --workspace <workspace-id> --verify-only --evaluate-agent
```

Verification checks SQL, KQL, Lakehouse, ontology, semantic model, and the
published data agent. The summary includes workspace and item IDs, so do not
commit it.

## 6. Run the lightning-talk question

Open the published `CaldovaAnalyst` Fabric data agent and ask:

```text
What's driving the increase in Hydration Sunscreen sales, and is it likely to continue?
```

Inspect both the answer and its retained source rows. A grounded answer should
identify:

- the external signal `SIG-ENSO-2026-07`;
- four affected regions and two control regions;
- the 100,000-unit, $800,000 targeted opportunity;
- a 0.78 persistence probability;
- `SCN-2026-HS-B` as recommended but not approved;
- the difference between the 30-day forecast horizon and the longer campaign
  and seasonal outlook.

The wording may vary. Check the facts and cited sources.

The authored prompts and expected facts are in:

- [`data/evaluation/questions.json`](../data/evaluation/questions.json)
- [`data/evaluation/expected-results.json`](../data/evaluation/expected-results.json)
- [`src/fabric/CaldovaLaunch.DataAgent/`](../src/fabric/CaldovaLaunch.DataAgent/)

## Rehearsal and reset

- Rehearse in the same workspace only after `--verify-only` passes.
- Prefer a new workspace or prefix for another presenter.
- Do not regenerate the optional outcome slice before the talk; the default
  scenario deliberately leaves the decision open.
- Keep `data/scenario.json` unchanged.
- Keep `data/.staging/`, generated Fabric IDs, tokens, screenshots, and
  deployment output out of Git.

## Use GitHub Copilot

Follow the [Copilot deployment runbook](copilot.md). The agent runs the local
checks and dry run, then shows you the workspace and deployment command before
continuing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Workspace not found | Confirm the signed-in tenant and immutable workspace ID. |
| Permission denied | Confirm that your workspace role can create and load the required Fabric items. |
| Existing rows protected | Use a new workspace or prefix; use `--overwrite` only for disposable data. |
| Agent answer is incomplete | Run `--evaluate-agent`, inspect selected sources, and compare with expected facts. |
| Generated answer differs in wording | Validate facts and sources; Data Agent output is non-deterministic. |
