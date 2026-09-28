# Fabric environment

LTG243 runs entirely in Microsoft Fabric.

You need:

- access to a Microsoft Fabric tenant and capacity;
- an empty or disposable workspace;
- permission to create, load, update, publish, and query the required items.

Run [create-data.sh](../create-data.sh) or
[create-data.ps1](../create-data.ps1) to create the Lakehouse,
Eventhouse/KQL database, Fabric SQL Database, Fabric IQ ontology, Direct Lake
semantic model, and Fabric data agent.

The workspace ID and generated item IDs remain local.
