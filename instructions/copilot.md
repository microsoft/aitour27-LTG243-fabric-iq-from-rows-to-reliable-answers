# Deploy LTG243 with a coding agent

Use this prompt from the repository root:

```text
Prepare the LTG243 Fabric IQ demo.

1. Read README.md, instructions/README.md, and AGENTS.md.
2. Verify Node.js 24+, Fabio 0.71.0+, and Bash or PowerShell 7.
3. Run node data/tools/manifest.ts --check and
   node data/tools/validate.ts.
4. Ask me for the Fabric workspace ID, then run the deployment with --dry-run.
5. Show me the workspace, six item names, and deployment command before
   continuing.
6. After I confirm, deploy with create-data.sh or create-data.ps1.
7. Run --verify-only and --verify-only --evaluate-agent.
8. Report the deployed items, verification results, and Data Agent result.
```

## Safe defaults

- Use an empty or disposable workspace.
- Do not add `--overwrite` unless you intend to replace existing demo data.
- Do not add `--with-cosmos`; LTG243 does not use it.
- Keep tokens, workspace IDs, item IDs, screenshots, generated definitions, and
  deployment output out of Git.
- If a command times out, inspect the workspace before running it again.

## Expected result

- `PASS manifest.json matches 94 files on disk.`
- `322 passed, 0 failed.`
- Six Fabric items created or resolved.
- `CaldovaAnalyst` published.
- The hero question returns the expected facts with source rows.
