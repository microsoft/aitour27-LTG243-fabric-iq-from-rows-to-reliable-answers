# LTG243 presenter runbook

This repository owns the reproducible demo environment.

## Core materials

| Item | Link | Notes |
|---|---|---|
| Delivery deck | [English](https://aka.ms/aitour27/LTG243/slides/en) | Required URL |
| Attendee landing page | [Session README](../README.md) | Public starting point |
| Workshop/lab instructions | [Instructions](../instructions/README.md) | Remove this row when not applicable |

## Before travel

1. Install Node.js 24+, Fabio 0.71.0+, and Bash or PowerShell 7.
2. Deploy into a dedicated demo workspace by following
   [the setup guide](../instructions/README.md).
3. Run local validation, `--verify-only`, and `--evaluate-agent`.
4. Confirm the presenter account can open the ontology, semantic model, and
   `CaldovaAnalyst`.
5. Keep the workspace and item IDs in private presenter notes, not in Git.

## Before the session

1. Re-run:

   ```sh
   ./create-data.sh --workspace <workspace-id> --verify-only --evaluate-agent
   ```

2. Open the ontology and Data Agent tabs before the talk.
3. Ask the hero question once and inspect the source rows.
4. Preserve the default open-decision dataset. Do not regenerate the optional
   outcome slice.

## Live demo

Ask:

```text
What's driving the increase in Hydration Sunscreen sales, and is it likely to continue?
```

Show the grounded answer and its source rows. The wording can vary; check the
facts and sources.

## Fallback

If the tenant surface is unavailable, use the checked-in
[`questions.json`](../data/evaluation/questions.json) and
[`expected-results.json`](../data/evaluation/expected-results.json) to explain
the expected result. Say that it is the expected result rather than a live
tenant response.
