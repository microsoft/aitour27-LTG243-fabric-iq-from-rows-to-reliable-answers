# LTG243 repository instructions

Read `AGENTS.md`, `README.md`, `instructions/README.md`, and
`instructions/copilot.md` before helping with setup.

- Scope is the Fabric-only LTG243 demo.
- Use Node.js 24+ and Fabio 0.71.0+.
- Run the manifest check and validator before any deployment work.
- Ask for the target workspace ID; do not infer or reuse one from logs.
- Run `create-data.sh` or `create-data.ps1` with `--dry-run` first.
- Show the workspace and command before running a deployment or authenticated
  verification, then wait for confirmation.
- Use `--overwrite` only for data the user intends to replace. Do not use
  `--with-cosmos` for LTG243.
- Do not expose or commit credentials, tokens, tenant IDs, workspace IDs, item
  IDs, deployment output, screenshots, or generated definitions.
- Keep `data/scenario.json` frozen and preserve deterministic generation.
- Report local checks, dry-run output, and deployed results separately.
