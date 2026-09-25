# Fabric source

This folder contains the authored Microsoft Fabric item definitions used by the
LTG243 demo.

| Path | Purpose |
| --- | --- |
| [`fabric/CaldovaLaunch.Ontology/`](fabric/CaldovaLaunch.Ontology/) | Fabric IQ ontology source and data-binding definition |
| [`fabric/CaldovaLaunch.SemanticModel/`](fabric/CaldovaLaunch.SemanticModel/) | Direct Lake semantic-model source and metadata |
| [`fabric/CaldovaLaunch.DataAgent/`](fabric/CaldovaLaunch.DataAgent/) | Data-agent instructions, source selection, few-shot examples, and evaluation path |
| [`fabric/semantic-model-source/`](fabric/semantic-model-source/) | Authored semantic model projected into the deployable definition |

`create-data.sh` and `create-data.ps1` deploy these items after loading the
synthetic data estate. Generated semantic-model definitions and tenant IDs are
local build artifacts and must not be committed.
