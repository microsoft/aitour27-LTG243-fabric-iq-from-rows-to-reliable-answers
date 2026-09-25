# LTG243 scenario

LTG243 uses the Hydration Sunscreen slice of the shared Caldova Fabric estate.
The deployable source is the deterministic dataset, Fabric IQ ontology, Direct
Lake semantic model, and `CaldovaAnalyst` data-agent definition in this
repository.

The lightning talk uses:

1. governed rows and measures for one open demand decision;
2. the Fabric IQ ontology to show entities, relationships, and bound meaning;
3. the Fabric data agent to ask the hero demand question;
4. source inspection and expected-answer checks;
5. a reusable case/correction idea to explain retained organizational learning.

The shared dataset contains additional campaign, production, policy, historical
case, and optional outcome records. They support model relationships and
evaluation but are not separate LTG243 demos.

## Related demos and exclusions

- [BRK390 Act 2 applications and agents](https://github.com/microsoft/aitour27-BRK390-building-ai-applications-with-microsoft-databases-and-fabric/tree/main/src/caldova-decisions)
  are deployed separately for the breakout session.
- [BRK390 Act 3 Azure staffing application](https://github.com/microsoft/aitour27-BRK390-building-ai-applications-with-microsoft-databases-and-fabric/tree/main/src/act3)
  is also deployed separately for the breakout session.
- Tenant-specific screenshots, workspace IDs, item IDs, and recordings are not
  included.
- Fabric Data Agent response wording can vary. Validate the required facts and
  source rows rather than exact phrasing.

The checked-in files recreate the Fabric environment. After deployment, run
`--verify-only --evaluate-agent` to check the live workspace.
