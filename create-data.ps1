<#
.SYNOPSIS
Deploys the shared Caldova LTG243 synthetic demo dataset into Microsoft Fabric using fabio.

.USAGE
./create-data.ps1 --workspace <workspace-id-or-name> [options]

.OPTIONS
--workspace <value>  Fabric workspace id or display name. Defaults to FABIO_WORKSPACE.
--capacity <value>   Fabric capacity id used only when creating a missing workspace. Defaults to FABIO_CAPACITY.
--prefix <value>     Item name prefix. Defaults to Caldova.
--staging <dir>      Uncompressed staging directory. Defaults to data/.staging.
--dry-run            Validate locally and print fabio commands without remote calls.
--skip-generate      Use committed files as-is. This is the default.
--regenerate         Regenerate local payload files before validation.
--overwrite          Allow replacing/reloading existing target data.
--verify-only        Only run post-load verification queries against existing items.
--with-cosmos        Also provision a native Cosmos DB database item in Fabric.
--skip-fabric-items  Skip ontology, semantic model and data agent deployment/verification.
--evaluate-agent     Run published data-agent evaluation questions after deployment.
-h, --help           Show usage.

.DESCRIPTION
Deploys the LTG243 dataset and demo items to Microsoft Fabric. Fabric SQL
Database is a Fabric item. The optional --with-cosmos path belongs to the shared
dataset and is not required for LTG243.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Script:RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:DataDir = Join-Path $Script:RootDir 'data'
$Script:OntologyDir = Join-Path $Script:RootDir 'src/fabric/CaldovaLaunch.Ontology'
$Script:SemanticModelDir = Join-Path $Script:RootDir 'src/fabric/CaldovaLaunch.SemanticModel'
$Script:DataAgentDir = Join-Path $Script:RootDir 'src/fabric/CaldovaLaunch.DataAgent'

$Script:Workspace = $env:FABIO_WORKSPACE
$Script:Capacity = $env:FABIO_CAPACITY
$Script:Prefix = 'Caldova'
$Script:StagingInput = 'data/.staging'
$Script:DryRun = $false
$Script:Regenerate = $false
$Script:Overwrite = $false
$Script:VerifyOnly = $false
$Script:WithCosmos = $false
$Script:SkipFabricItems = $false
$Script:EvaluateAgent = $false

$Script:WorkspaceId = ''
$Script:LakehouseId = ''
$Script:EventhouseId = ''
$Script:KqlDatabaseId = ''
$Script:SqlDatabaseId = ''
$Script:CosmosDatabaseId = ''
$Script:CosmosDocumentsLoaded = 0
$Script:CosmosStatus = 'not requested'
$Script:OntologyId = ''
$Script:SemanticModelId = ''
$Script:SemanticModelConnectionId = ''
$Script:SemanticModelSqlEndpointHost = ''
$Script:OntologyBindingsOutput = ''
$Script:OntologyEntityBindingCount = ''
$Script:OntologyContextualizationCount = ''
$Script:OntologyMcpUrl = ''
$Script:DataAgentId = ''
$Script:DataAgentEvaluationQuestions = ''

$Script:OntologyStatus = 'skipped'
$Script:OntologyBindingStatus = 'skipped'
$Script:OntologyMcpUrlStatus = 'skipped'
$Script:OntologySearchStatus = 'skipped'
$Script:SemanticModelStatus = 'skipped'
$Script:SemanticModelRefreshStatus = 'skipped'
$Script:SemanticModelConnectionSource = 'skipped'
$Script:DataAgentStatus = 'skipped'
$Script:DataAgentSourcesAttached = 0
$Script:DataAgentPublished = 'no'
$Script:DataAgentElNinoSignalStatus = 'skipped'
$Script:DataAgentEvaluationStatus = 'skipped'
$Script:DataAgentFewshotSourcesVerified = 0
$Script:DataAgentFewshotStatus = 'skipped'

$Script:SqlRowsLoaded = 0
$Script:EventhouseRowsLoaded = 0
$Script:LakehouseAnalyticsDeltaTablesLoaded = 0
$Script:LakehouseAnalyticsRowsLoaded = 0
$Script:LakehouseDashboardRowsLoaded = 0
$Script:LakehouseEvidenceDeltaTablesLoaded = 0
$Script:LakehouseEvidenceRowsLoaded = 0
$Script:LakehouseFilesUploaded = 0
$Script:VerificationFailed = $false
$Script:FabricItemWarnings = $false

function Show-Usage {
  $content = Get-Content -Raw -Path $PSCommandPath
  $start = $content.IndexOf('<#') + 2
  $end = $content.IndexOf('#>', $start)
  $content.Substring($start, $end - $start).Trim()
}

function Fail([string]$Message) {
  [Console]::Error.WriteLine("ERROR: $Message")
  exit 1
}

function Warn([string]$Message) {
  Write-Warning $Message
}

function Get-RequiredValue([string[]]$Values, [int]$Index, [string]$Flag) {
  if (($Index + 1) -ge $Values.Count -or [string]::IsNullOrWhiteSpace($Values[$Index + 1])) {
    Fail "$Flag requires a value."
  }
  return $Values[$Index + 1]
}

for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--workspace' {
      $Script:Workspace = Get-RequiredValue $args $i $args[$i]
      $i++
    }
    '--capacity' {
      $Script:Capacity = Get-RequiredValue $args $i $args[$i]
      $i++
    }
    '--prefix' {
      $Script:Prefix = Get-RequiredValue $args $i $args[$i]
      $i++
    }
    '--staging' {
      $Script:StagingInput = Get-RequiredValue $args $i $args[$i]
      $i++
    }
    '--dry-run' {
      $Script:DryRun = $true
    }
    '--skip-generate' {
      $Script:Regenerate = $false
    }
    '--regenerate' {
      $Script:Regenerate = $true
    }
    '--overwrite' {
      $Script:Overwrite = $true
    }
    '--verify-only' {
      $Script:VerifyOnly = $true
    }
    '--with-cosmos' {
      $Script:WithCosmos = $true
    }
    '--skip-fabric-items' {
      $Script:SkipFabricItems = $true
    }
    '--evaluate-agent' {
      $Script:EvaluateAgent = $true
    }
    '-h' {
      Show-Usage
      exit 0
    }
    '--help' {
      Show-Usage
      exit 0
    }
    default {
      Fail "Unknown option: $($args[$i])"
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Script:Workspace)) {
  Fail '--workspace or FABIO_WORKSPACE is required.'
}

function Get-AbsolutePath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }
  return [System.IO.Path]::GetFullPath((Join-Path $Script:RootDir $Path))
}

$Script:Staging = Get-AbsolutePath $Script:StagingInput
$Script:LakehouseName = "$($Script:Prefix)Analytics"
$Script:EventhouseName = "$($Script:Prefix)Signals"
$Script:KqlDatabaseName = "$($Script:Prefix)Signals"
$Script:SqlDatabaseName = "$($Script:Prefix)Operations"
$Script:CosmosDatabaseName = "$($Script:Prefix)DecisionMemory"
$Script:OntologyName = "$($Script:Prefix)BusinessMeaning"
$Script:SemanticModelName = "$($Script:Prefix)LaunchModel"
$Script:DataAgentName = "$($Script:Prefix)Analyst"

function Ensure-QuerySafe([string]$Value, [string]$Label) {
  if ($Value.Contains("'")) {
    Fail "$Label cannot contain a single quote because fabio item/workspace JMESPath queries use single-quoted literals."
  }
}

Ensure-QuerySafe $Script:Workspace 'Workspace'
Ensure-QuerySafe $Script:Prefix 'Prefix'

function Test-Identifier([string]$Value) {
  return $Value -match '^[A-Za-z_][A-Za-z0-9_]*$'
}

function Format-Command([string[]]$Command) {
  return ($Command | ForEach-Object {
    if ($_ -match '^[A-Za-z0-9_./:=@-]+$') { $_ } else { "'" + ($_.Replace("'", "''")) + "'" }
  }) -join ' '
}

function Write-DryRun([string[]]$Command) {
  Write-Host "DRY-RUN: $(Format-Command $Command)"
}

function Write-NodeDryRun([string[]]$Arguments) {
  if ($Script:DryRun) {
    Write-DryRun (@('node') + $Arguments)
  }
}

function Invoke-Fabio {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$Capture,
    [switch]$AllowFailure
  )

  if ($Script:DryRun) {
    Write-DryRun (@('fabio') + $Arguments)
    return ''
  }

  if ($Capture) {
    $output = & fabio @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      if ($AllowFailure) {
        return $null
      }
      throw "fabio $($Arguments -join ' ') failed with exit code $exitCode.`n$($output | Out-String)"
    }
    # fabio writes a "[timing] ..." diagnostic line to stderr on every call.
    # stderr is merged so failures stay readable, which would otherwise let that
    # line be read as a command result: an empty --query match leaves the timing
    # line as the only captured output and it becomes the "id".
    $output = @($output | Where-Object { "$_" -notmatch '^\[timing\]\s' })
    return (($output | Out-String).Trim())
  }

  & fabio @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "fabio $($Arguments -join ' ') failed with exit code $exitCode."
  }
}

function Invoke-NodeRequired([string[]]$Arguments) {
  & node @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "node $($Arguments -join ' ') failed with exit code $exitCode."
  }
}

function Invoke-NodeRequiredVisible([string[]]$Arguments) {
  $output = & node @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($null -ne $output) {
    $output | ForEach-Object { Write-Host $_ }
  }
  if ($exitCode -ne 0) {
    throw "node $($Arguments -join ' ') failed with exit code $exitCode."
  }
}

function Invoke-NodeOptionalForDryRun([string[]]$Arguments) {
  & node @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    if ($Script:DryRun) {
      Warn "Local command failed during dry-run and was reported without stopping: node $($Arguments -join ' ')"
      return
    }
    throw "node $($Arguments -join ' ') failed with exit code $exitCode."
  }
}

function Get-CsvRowCount([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return 0
  }
  $count = 0
  foreach ($line in [System.IO.File]::ReadLines($Path)) {
    $null = $line
    $count++
  }
  return [Math]::Max(0, $count - 1)
}

function Normalize-Name([string]$Value) {
  return (($Value -replace '[^A-Za-z0-9]', '').ToLowerInvariant())
}

function ConvertTo-PascalName([string]$Value) {
  $parts = $Value -split '[^A-Za-z0-9]+'
  $out = ''
  foreach ($part in $parts) {
    if ([string]::IsNullOrWhiteSpace($part)) { continue }
    $word = $part.ToLowerInvariant()
    $out += $word.Substring(0, 1).ToUpperInvariant() + $word.Substring(1)
  }
  return $out
}

function ConvertTo-SnakeTableName([string]$Value) {
  $parts = $Value -split '[^A-Za-z0-9]+'
  $filtered = @()
  foreach ($part in $parts) {
    if ([string]::IsNullOrWhiteSpace($part)) { continue }
    $filtered += $part.ToLowerInvariant()
  }
  $out = $filtered -join '_'
  if ($out -match '^[0-9]') {
    $out = "t_$out"
  }
  return $out
}

function Get-KqlTables([string]$SchemaPath) {
  if (-not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) {
    return @()
  }
  $tables = New-Object System.Collections.Generic.List[string]
  foreach ($line in [System.IO.File]::ReadLines($SchemaPath)) {
    if ($line -match '\.create(?:-or-alter|-merge)?\s+table\s+([A-Za-z_][A-Za-z0-9_]*)') {
      $tables.Add($Matches[1])
    }
  }
  return @($tables | Sort-Object -Unique)
}

function Get-KqlTableDefinitionFiles([string]$DirPath) {
  if (-not (Test-Path -LiteralPath $DirPath -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $DirPath -Filter '*.kql' -File |
    Where-Object { $_.Name -notmatch 'mapping' -and $_.Name -notmatch 'stage_quer' -and $_.Name -notmatch 'queries' } |
    Sort-Object Name)
}

function Get-AllKqlTables([string]$DirPath) {
  $all = New-Object System.Collections.Generic.List[string]
  foreach ($f in Get-KqlTableDefinitionFiles $DirPath) {
    foreach ($t in Get-KqlTables $f.FullName) { $all.Add($t) }
  }
  return @($all | Sort-Object -Unique)
}

function Get-KqlTableForCsv([string]$CsvPath, [string]$DefsDir) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($CsvPath)
  $targetNorm = Normalize-Name $base
  $pascal = ConvertTo-PascalName $base
  $pascalNorm = Normalize-Name $pascal

  foreach ($table in Get-AllKqlTables $DefsDir) {
    $tableNorm = Normalize-Name $table
    if ($tableNorm -eq $targetNorm -or $tableNorm -eq $pascalNorm) {
      return $table
    }
  }

  Warn "Could not find a KQL table mapping for $([System.IO.Path]::GetFileName($CsvPath)); using derived table name $pascal."
  return $pascal
}

function Get-FirstMatchingFile([string]$Dir, [string]$Filter) {
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
    return $null
  }
  return Get-ChildItem -LiteralPath $Dir -Filter $Filter -File | Sort-Object FullName | Select-Object -First 1
}

function Check-Prerequisites {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Fail 'node is required. Install Node.js 24 or later and retry.'
  }
  $nodeVersion = (& node --version).Trim()
  $nodeExit = $LASTEXITCODE
  if ($nodeExit -ne 0) {
    Fail "node --version failed with exit code $nodeExit."
  }
  $nodeMajor = [int]((($nodeVersion -replace '^v', '') -split '\.')[0])
  if ($nodeMajor -lt 24) {
    Fail "Node.js 24 or later is required; found $nodeVersion."
  }

  $fabioCmd = Get-Command fabio -ErrorAction SilentlyContinue
  if (-not $fabioCmd) {
    Fail 'fabio is required. Install fabio 0.70.0+ (0.71.0+ for Cosmos DB documents) and ensure it is on PATH.'
  }
  $fabioVersion = (& fabio --version).Trim()
  $fabioExit = $LASTEXITCODE
  if ($fabioExit -ne 0) {
    Fail "fabio --version failed with exit code $fabioExit."
  }

  Write-Host "node: $nodeVersion"
  Write-Host "fabio: $fabioVersion"
}

function Invoke-LocalPrepare {
  if ($Script:VerifyOnly) {
    Write-Host 'Verify-only mode: skipping generation and load; expanding payloads for expected verification counts.'
    Invoke-NodeRequired -Arguments @((Join-Path $Script:DataDir 'tools/expand.ts'), '--out', $Script:Staging, '--clean')
    return
  }

  if ($Script:Regenerate) {
    Write-Host 'Regenerating local payload files...'
    Invoke-NodeRequired -Arguments @((Join-Path $Script:DataDir 'tools/generate.ts'))
  } else {
    Write-Host 'Using committed payload files as-is (default).'
  }

  Write-Host 'Checking data manifest...'
  $manifest = Join-Path $Script:DataDir 'manifest.json'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) {
    Invoke-NodeOptionalForDryRun -Arguments @((Join-Path $Script:DataDir 'tools/manifest.ts'), '--check')
  } elseif ($Script:DryRun) {
    Warn 'data/manifest.json is absent; continuing dry-run because the payload set may still be generated by another process.'
  } else {
    Fail 'data/manifest.json is missing. Run: node data/tools/manifest.ts'
  }

  $validator = Join-Path $Script:DataDir 'tools/validate.ts'
  if (Test-Path -LiteralPath $validator -PathType Leaf) {
    Write-Host 'Validating scenario payloads...'
    Invoke-NodeOptionalForDryRun -Arguments @($validator)
  } else {
    Warn 'data/tools/validate.ts is absent; continuing without validator.'
  }

  Write-Host "Expanding payloads into $($Script:Staging) ..."
  try {
    Invoke-NodeRequired -Arguments @((Join-Path $Script:DataDir 'tools/expand.ts'), '--out', $Script:Staging, '--clean')
  } catch {
    if ($Script:DryRun) {
      Warn 'Payload expansion failed during dry-run; continuing so planned fabio commands can still be reviewed.'
    } else {
      throw
    }
  }
}

function Invoke-Authentication {
  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'auth', 'status')
    Write-Host 'Dry-run mode: no remote fabio calls are executed; ids below are placeholders.'
    return
  }

  & fabio auth status *> $null
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    [Console]::Error.WriteLine("ERROR: fabio is not authenticated. Run this command, then retry:`n  fabio auth login")
    exit 1
  }
}

function Resolve-Workspace {
  if ($Script:DryRun) {
    $query = "[?displayName=='$($Script:Workspace)'].id | [0]"
    Write-DryRun @('fabio', 'workspace', 'show', '--id', $Script:Workspace, '--query', 'id', '--output', 'plain')
    Write-DryRun @('fabio', 'workspace', 'list', '--all', '--query', $query, '--output', 'plain')
    if (-not [string]::IsNullOrWhiteSpace($Script:Capacity)) {
      Write-DryRun @('fabio', 'workspace', 'create', '--name', $Script:Workspace, '--capacity-id', $Script:Capacity, '--query', 'id', '--output', 'plain')
    } else {
      Write-DryRun @('fabio', 'workspace', 'create', '--name', $Script:Workspace, '--query', 'id', '--output', 'plain')
    }
    $Script:WorkspaceId = '<workspace-id>'
    return
  }

  $resolved = Invoke-Fabio -Arguments @('workspace', 'show', '--id', $Script:Workspace, '--query', 'id', '--output', 'plain') -Capture -AllowFailure
  if (-not [string]::IsNullOrWhiteSpace($resolved) -and $resolved -ne 'null') {
    $Script:WorkspaceId = ($resolved -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
    Write-Host "Resolved workspace id: $($Script:WorkspaceId)"
    return
  }

  $query = "[?displayName=='$($Script:Workspace)'].id | [0]"
  $resolved = Invoke-Fabio -Arguments @('workspace', 'list', '--all', '--query', $query, '--output', 'plain') -Capture
  $resolved = ($resolved -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
  if (-not [string]::IsNullOrWhiteSpace($resolved) -and $resolved -ne 'null') {
    $Script:WorkspaceId = $resolved
    Write-Host "Resolved workspace '$($Script:Workspace)' to id: $($Script:WorkspaceId)"
    return
  }

  Write-Host "Workspace '$($Script:Workspace)' was not found; creating it."
  $args = @('workspace', 'create', '--name', $Script:Workspace)
  if (-not [string]::IsNullOrWhiteSpace($Script:Capacity)) {
    $args += @('--capacity-id', $Script:Capacity)
  }
  $args += @('--query', 'id', '--output', 'plain')
  $created = Invoke-Fabio -Arguments $args -Capture
  $Script:WorkspaceId = ($created -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($Script:WorkspaceId) -or $Script:WorkspaceId -eq 'null') {
    Fail 'fabio workspace create did not return a workspace id.'
  }
  Write-Host "Created workspace id: $($Script:WorkspaceId)"
}

function Resolve-OrCreateItem([string]$Type, [string]$Name, [string]$Group, [string]$ExtraFlag = '', [string]$ExtraValue = '') {
  Ensure-QuerySafe $Name "$Type item name"
  $query = "[?displayName=='$Name'].id | [0]"

  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'item', 'list', '--workspace', $Script:WorkspaceId, '--type', $Type, '--query', $query, '--output', 'plain')
    if (-not $Script:VerifyOnly) {
      $createArgs = @('fabio', $Group, 'create', '--workspace', $Script:WorkspaceId, '--name', $Name)
      if (-not [string]::IsNullOrWhiteSpace($ExtraFlag)) {
        $createArgs += @($ExtraFlag, $ExtraValue)
      }
      $createArgs += @('--query', 'id', '--output', 'plain')
      Write-DryRun $createArgs
    }
    return "<$Name-id>"
  }

  $id = Invoke-Fabio -Arguments @('item', 'list', '--workspace', $Script:WorkspaceId, '--type', $Type, '--query', $query, '--output', 'plain') -Capture
  $id = ($id -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
  if (-not [string]::IsNullOrWhiteSpace($id) -and $id -ne 'null') {
    Write-Host "Resolved $Type '$Name': $id"
    return $id
  }

  if ($Script:VerifyOnly) {
    Fail "Verify-only mode requires existing $Type item '$Name'."
  }

  Write-Host "Creating $Type '$Name'."
  $create = @($Group, 'create', '--workspace', $Script:WorkspaceId, '--name', $Name)
  if (-not [string]::IsNullOrWhiteSpace($ExtraFlag)) {
    $create += @($ExtraFlag, $ExtraValue)
  }
  $create += @('--query', 'id', '--output', 'plain')
  $created = Invoke-Fabio -Arguments $create -Capture
  $created = ($created -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($created) -or $created -eq 'null') {
    Fail "fabio $Group create did not return an id for '$Name'."
  }
  return $created
}

# fabio 0.71.0 added a Cosmos DB for NoSQL data plane, so decision-case documents
# can now be loaded directly rather than only staged in the Lakehouse. Every
# document carries an `id` because Cosmos requires one.
function Import-CosmosDocuments {
  if (-not $Script:WithCosmos) { return }
  if ([string]::IsNullOrWhiteSpace($Script:CosmosDatabaseId)) { return }

  $dir = Join-Path $Script:Staging 'lakehouse/decision-cases'
  $cases = Join-Path $dir 'decision-cases.jsonl'
  $timeline = Join-Path $dir 'decision-case-timeline.jsonl'

  if (-not (Test-Path -LiteralPath $cases -PathType Leaf)) {
    Warn "No decision-case documents found at $cases; skipping Cosmos DB import."
    return
  }

  Write-Host "Loading Cosmos DB containers and documents."

  $pairs = @(
    @{ Container = 'decision-cases'; Path = $cases },
    @{ Container = 'decision-timeline'; Path = $timeline }
  )
  foreach ($pair in $pairs) {
    if (-not (Test-Path -LiteralPath $pair.Path -PathType Leaf)) { continue }
    try {
      Invoke-Fabio -Arguments @('cosmos-db-database', 'create-container', '--workspace', $Script:WorkspaceId, '--id', $Script:CosmosDatabaseId, '--container', $pair.Container, '--partition-key', '/caseId') | Out-Null
    }
    catch {
      Warn "Cosmos container '$($pair.Container)' may already exist; continuing."
    }
    try {
      Invoke-Fabio -Arguments @('cosmos-db-database', 'import', '--workspace', $Script:WorkspaceId, '--id', $Script:CosmosDatabaseId, '--container', $pair.Container, '--source', $pair.Path)
      $Script:CosmosDocumentsLoaded += (Get-Content -LiteralPath $pair.Path | Measure-Object -Line).Lines
    }
    catch {
      Warn "Cosmos DB import into '$($pair.Container)' did not complete."
      $Script:CosmosStatus = 'import failed'
    }
  }
}

function Resolve-Items {
  $Script:LakehouseId = Resolve-OrCreateItem 'Lakehouse' $Script:LakehouseName 'lakehouse'
  $Script:EventhouseId = Resolve-OrCreateItem 'Eventhouse' $Script:EventhouseName 'eventhouse'
  $Script:KqlDatabaseId = Resolve-OrCreateItem 'KQLDatabase' $Script:KqlDatabaseName 'kql-database' '--eventhouse-id' $Script:EventhouseId
  $Script:SqlDatabaseId = Resolve-OrCreateItem 'SQLDatabase' $Script:SqlDatabaseName 'sql-database'
  if ($Script:WithCosmos) {
    # Cosmos DB in Fabric is a native, writable NoSQL database item. From fabio
    # 0.71.0 the Cosmos data plane also creates containers and imports the
    # decision-case documents; see Import-CosmosDocuments below.
    $Script:CosmosDatabaseId = Resolve-OrCreateItem 'CosmosDbDatabase' $Script:CosmosDatabaseName 'cosmos-db-database'
  }
}

function Invoke-SqlScalar([string]$Sql) {
  $result = Invoke-Fabio -Arguments @('sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', $Sql, '--query', '[0].value', '--output', 'plain') -Capture
  if ($null -eq $result) { return '' }
  $line = $result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
  if ($null -eq $line) { return '' }
  return $line.Trim()
}

function Get-SqlRowCount([string]$Table) {
  return Invoke-SqlScalar "SELECT COALESCE(SUM(row_count), 0) AS value FROM sys.dm_db_partition_stats WHERE object_id = OBJECT_ID(N'dbo.$Table') AND index_id IN (0, 1);"
}

function Invoke-KqlScalar([string]$Kql) {
  $result = Invoke-Fabio -Arguments @('kql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:KqlDatabaseId, '--kql', $Kql, '--query', '[0].value', '--output', 'plain') -Capture
  if ($null -eq $result) { return '' }
  $line = $result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
  if ($null -eq $line) { return '' }
  return $line.Trim()
}

function Test-LakehouseTableExists([string]$Table) {
  $query = "[?name=='$Table' || displayName=='$Table'].name | [0]"
  $result = Invoke-Fabio -Arguments @('lakehouse', 'list-tables', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--query', $query, '--output', 'plain') -Capture
  if ($null -eq $result) { return $false }
  $value = ($result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  return (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim() -ne 'null')
}

function Check-LakehouseTableOverwrite([string]$Table, [string]$Source, [string]$FileName) {
  if (-not (Test-Identifier $Table)) {
    Warn "Skipping lakehouse table existence check for unsafe $Source table name from file: $FileName"
    return
  }
  if ((Test-LakehouseTableExists $Table) -and -not $Script:Overwrite) {
    Fail "Lakehouse table '$Table' already exists. Re-run with --overwrite to replace/reload $Source tables."
  }
}

function Check-SqlOverwriteProtection {
  $dir = Join-Path $Script:Staging 'fabric-sql'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
    if (-not (Test-Identifier $table)) {
      Warn "Skipping overwrite check for SQL CSV with unsafe table name: $($csv.Name)"
      continue
    }
    $existingValue = Get-SqlRowCount $table
    $existing = if ([string]::IsNullOrWhiteSpace($existingValue)) { 0 } else { [int64]$existingValue }
    if ($existing -gt 0 -and -not $Script:Overwrite) {
      Fail "SQL table '$table' already contains $existing row(s). Re-run with --overwrite to replace/reload data."
    }
  }
}

function Clear-SqlTablesForOverwrite {
  if (-not $Script:Overwrite) { return }
  $dir = Join-Path $Script:Staging 'fabric-sql'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }

  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
    if (Test-Identifier $table) {
      Invoke-Fabio -Arguments @('sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', "IF OBJECT_ID(N'dbo.$table', N'U') IS NOT NULL DELETE FROM dbo.[$table];")
    }
  }
}

# Foreign keys are disabled around the whole SQL load because both the DELETE
# step and the CSV import run in alphabetical file order, not dependency order.
# They are re-enabled WITH CHECK afterwards, which re-validates every row and so
# still proves referential integrity.
function Set-SqlForeignKeys([string]$Mode) {
  $clause = if ($Mode -eq 'disable') { 'NOCHECK CONSTRAINT ALL' } else { 'WITH CHECK CHECK CONSTRAINT ALL' }
  $sql = "DECLARE @sql nvarchar(max) = N''; SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name) + N' $clause; ' FROM sys.tables AS t WHERE t.is_ms_shipped = 0; EXEC sp_executesql @sql;"
  Invoke-Fabio -Arguments @('sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', $sql)
}

# T-SQL requires CREATE VIEW to be the first statement in its batch, and fabio has
# no GO-batch support, so scripts are split on lines containing only GO and each
# batch is sent as a separate query.
function Invoke-SqlScript([string]$ScriptPath) {
  $content = Get-Content -LiteralPath $ScriptPath -Raw
  if ($content -notmatch '(?im)^\s*GO\s*$') {
    Invoke-Fabio -Arguments @('sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', "@$ScriptPath")
    return
  }

  $batches = [System.Text.RegularExpressions.Regex]::Split($content, '(?im)^\s*GO\s*$')
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fabio-sql-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $count = 0
  try {
    for ($i = 0; $i -lt $batches.Count; $i++) {
      $batch = $batches[$i]
      if ([string]::IsNullOrWhiteSpace($batch)) { continue }
      $batchPath = Join-Path $tempDir ("batch_{0:d3}.sql" -f $i)
      Set-Content -LiteralPath $batchPath -Value $batch -NoNewline
      Invoke-Fabio -Arguments @('sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', "@$batchPath")
      $count++
    }
  }
  finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  applied $count batch(es) from $([System.IO.Path]::GetFileName($ScriptPath))."
}

function Load-FabricSql {
  $dir = Join-Path $Script:Staging 'fabric-sql'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Warn "No Fabric SQL payload directory found at $dir; skipping SQL Database load."
    return
  }

  Check-SqlOverwriteProtection

  # Run every numbered SQL script in order: schema first, then views, including the
  # weather scripts. Discovered rather than hardcoded so new scripts are picked up.
  $sqlScripts = @(Get-ChildItem -LiteralPath $dir -Filter '*.sql' -File | Sort-Object Name)
  if ($sqlScripts.Count -eq 0) {
    Warn "No SQL scripts found in $dir; schema and views were not applied."
  }
  else {
    foreach ($script in $sqlScripts) {
      Write-Host "Applying $($script.Name)."
      Invoke-SqlScript $script.FullName
    }
  }

  Write-Host "Disabling foreign keys for the load."
  Set-SqlForeignKeys 'disable'

  Clear-SqlTablesForOverwrite

  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
    if (-not (Test-Identifier $table)) {
      Fail "Unsafe SQL table name derived from file $($csv.Name): $table"
    }
    $rows = Get-CsvRowCount $csv.FullName
    Invoke-Fabio -Arguments @('sql-database', 'import', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--file', $csv.FullName, '--table', $table, '--no-create-table')
    $Script:SqlRowsLoaded += $rows
  }

  Write-Host "Re-enabling and revalidating foreign keys."
  Set-SqlForeignKeys 'enable'
}

function Check-EventhouseOverwriteProtection {
  $dir = Join-Path $Script:Staging 'eventhouse'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = Get-KqlTableForCsv $csv.FullName $dir
    if (-not (Test-Identifier $table)) {
      Warn "Skipping overwrite check for eventhouse CSV with unsafe table name: $($csv.Name)"
      continue
    }
    $existingValue = Invoke-KqlScalar "$table | summarize value=count()"
    $existing = if ([string]::IsNullOrWhiteSpace($existingValue)) { 0 } else { [int64]$existingValue }
    if ($existing -gt 0 -and -not $Script:Overwrite) {
      Fail "KQL table '$table' already contains $existing row(s). Re-run with --overwrite to replace/reload data."
    }
  }
}

function Clear-EventhouseTablesForOverwrite {
  if (-not $Script:Overwrite) { return }
  $dir = Join-Path $Script:Staging 'eventhouse'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = Get-KqlTableForCsv $csv.FullName $dir
    if (Test-Identifier $table) {
      Invoke-Fabio -Arguments @('kql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:KqlDatabaseId, '--kql', ".clear table $table data")
    }
  }
}

# Kusto executes one control command per request, so KQL scripts are split into
# individual commands. A new command starts at a line beginning with a dot;
# following lines are treated as continuations of it.
function Invoke-KqlScript([string]$ScriptPath) {
  $lines = Get-Content -LiteralPath $ScriptPath
  $commands = New-Object System.Collections.Generic.List[string]
  $current = $null
  foreach ($line in $lines) {
    if ($line -match '^\s*//') { continue }
    if ($line -match '^\s*\.') {
      if ($null -ne $current) { $commands.Add($current) }
      $current = $line
    }
    elseif ($null -ne $current) {
      $current = $current + "`n" + $line
    }
  }
  if ($null -ne $current) { $commands.Add($current) }

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fabio-kql-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $count = 0
  try {
    for ($i = 0; $i -lt $commands.Count; $i++) {
      if ([string]::IsNullOrWhiteSpace($commands[$i])) { continue }
      $cmdPath = Join-Path $tempDir ("cmd_{0:d3}.kql" -f $i)
      Set-Content -LiteralPath $cmdPath -Value $commands[$i] -NoNewline
      Invoke-Fabio -Arguments @('kql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:KqlDatabaseId, '--kql', "@$cmdPath")
      $count++
    }
  }
  finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  applied $count command(s) from $([System.IO.Path]::GetFileName($ScriptPath))."
}

function Load-Eventhouse {
  $dir = Join-Path $Script:Staging 'eventhouse'
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Warn "No Eventhouse payload directory found at $dir; skipping Eventhouse load."
    return
  }

  # Run every numbered KQL script in order except the stage-query files, which are
  # presenter references rather than deployment steps.
  $kqlScripts = @(Get-ChildItem -LiteralPath $dir -Filter '*.kql' -File |
    Where-Object { $_.Name -notmatch 'stage_quer' -and $_.Name -notmatch 'queries' } |
    Sort-Object Name)
  if ($kqlScripts.Count -eq 0) {
    Warn "No KQL scripts found in $dir; tables and mappings were not created."
  }
  else {
    foreach ($script in $kqlScripts) {
      Write-Host "Applying $($script.Name)."
      Invoke-KqlScript $script.FullName
    }
  }

  Check-EventhouseOverwriteProtection
  Clear-EventhouseTablesForOverwrite

  foreach ($csv in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    $table = Get-KqlTableForCsv $csv.FullName $dir
    if (-not (Test-Identifier $table)) {
      Fail "Unsafe KQL table name derived for file $($csv.Name): $table"
    }
    $rows = Get-CsvRowCount $csv.FullName
    Invoke-Fabio -Arguments @('lakehouse', 'upload', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', $csv.FullName, '--dest-path', "Files/eventhouse/$($csv.Name)")
    Invoke-Fabio -Arguments @('kql-database', 'ingest', '--workspace', $Script:WorkspaceId, '--id', $Script:KqlDatabaseId, '--table', $table, '--source-lakehouse', $Script:LakehouseId, '--source-path', "Files/eventhouse/$($csv.Name)", '--format', 'Csv', '--ignore-first-record')
    $Script:EventhouseRowsLoaded += $rows
  }
}

function Upload-LakehouseFile([System.IO.FileInfo]$File, [string]$BaseDir, [string]$PrefixName) {
  $baseFull = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $relative = [System.IO.Path]::GetRelativePath($baseFull, $File.FullName)
  $relativeDir = [System.IO.Path]::GetDirectoryName($relative)
  if ([string]::IsNullOrWhiteSpace($relativeDir)) {
    $dest = "Files/$PrefixName"
  } else {
    $dest = "Files/$PrefixName/$($relativeDir -replace '\\', '/')"
  }
  Invoke-Fabio -Arguments @('lakehouse', 'upload', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', $File.FullName, '--dest-path', "$dest/$($File.Name)")
  $Script:LakehouseFilesUploaded++
}

function Check-LakehouseOverwriteProtection {
  $dashboard = Join-Path $Script:Staging 'lakehouse/dashboard'
  $evidence = Join-Path $Script:Staging 'lakehouse/evidence'
  $fabricSql = Join-Path $Script:Staging 'fabric-sql'
  $eventhouse = Join-Path $Script:Staging 'eventhouse'

  if (Test-Path -LiteralPath $dashboard -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $dashboard -Filter '*.csv' -File | Sort-Object FullName) {
      $table = 'dash_' + (ConvertTo-SnakeTableName ([System.IO.Path]::GetFileNameWithoutExtension($csv.Name)))
      Check-LakehouseTableOverwrite $table 'dashboard' $csv.Name
    }
  }

  if (Test-Path -LiteralPath $evidence -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $evidence -Filter '*.csv' -File | Sort-Object FullName) {
      $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
      Check-LakehouseTableOverwrite $table 'evidence' $csv.Name
    }
  }

  if (Test-Path -LiteralPath $fabricSql -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $fabricSql -Filter '*.csv' -File | Sort-Object FullName) {
      $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
      Check-LakehouseTableOverwrite $table 'analytics' $csv.Name
    }
  }

  if (Test-Path -LiteralPath $eventhouse -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $eventhouse -Filter '*.csv' -File | Sort-Object FullName) {
      $table = Get-KqlTableForCsv $csv.FullName $eventhouse
      Check-LakehouseTableOverwrite $table 'analytics' $csv.Name
    }
  }
}

function Load-Lakehouse {
  $lakehouse = Join-Path $Script:Staging 'lakehouse'
  $evaluation = Join-Path $Script:Staging 'evaluation'
  $receipts = Join-Path $Script:Staging 'receipts'
  $dashboard = Join-Path $lakehouse 'dashboard'
  $evidence = Join-Path $lakehouse 'evidence'

  if (Test-Path -LiteralPath $lakehouse -PathType Container) {
    foreach ($file in Get-ChildItem -LiteralPath $lakehouse -Recurse -File | Sort-Object FullName) {
      Upload-LakehouseFile $file $lakehouse 'lakehouse'
    }
  } else {
    Warn "No Lakehouse payload directory found at $lakehouse; skipping lakehouse file uploads."
  }

  if (Test-Path -LiteralPath $evaluation -PathType Container) {
    foreach ($file in Get-ChildItem -LiteralPath $evaluation -Recurse -File | Sort-Object FullName) {
      Upload-LakehouseFile $file $evaluation 'evaluation'
    }
  } else {
    Warn "No evaluation payload directory found at $evaluation; skipping evaluation uploads."
  }

  if (Test-Path -LiteralPath $receipts -PathType Container) {
    foreach ($file in Get-ChildItem -LiteralPath $receipts -Recurse -File | Sort-Object FullName) {
      Upload-LakehouseFile $file $receipts 'receipts'
    }
  } else {
    Warn "No receipts payload directory found at $receipts; skipping receipt uploads."
  }

  if (Test-Path -LiteralPath $dashboard -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $dashboard -Filter '*.csv' -File | Sort-Object FullName) {
      $table = 'dash_' + (ConvertTo-SnakeTableName ([System.IO.Path]::GetFileNameWithoutExtension($csv.Name)))
      if (-not (Test-Identifier $table)) {
        Fail "Unsafe Lakehouse table name derived from file $($csv.Name): $table"
      }
      $rows = Get-CsvRowCount $csv.FullName
      Invoke-Fabio -Arguments @('lakehouse', 'load-table', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', "Files/lakehouse/dashboard/$($csv.Name)", '--table', $table, '--mode', 'Overwrite', '--format', 'Csv')
      $Script:LakehouseDashboardRowsLoaded += $rows
    }
  }

  if (Test-Path -LiteralPath $evidence -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $evidence -Filter '*.csv' -File | Sort-Object FullName) {
      $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
      if (-not (Test-Identifier $table)) {
        Fail "Unsafe Lakehouse evidence table name derived from file $($csv.Name): $table"
      }
      $rows = Get-CsvRowCount $csv.FullName
      Invoke-Fabio -Arguments @('lakehouse', 'load-table', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', "Files/lakehouse/evidence/$($csv.Name)", '--table', $table, '--mode', 'Overwrite', '--format', 'Csv')
      $Script:LakehouseEvidenceDeltaTablesLoaded++
      $Script:LakehouseEvidenceRowsLoaded += $rows
      $Script:LakehouseAnalyticsDeltaTablesLoaded++
      $Script:LakehouseAnalyticsRowsLoaded += $rows
    }
  }
}

function Load-LakehouseAnalytics {
  $fabricSql = Join-Path $Script:Staging 'fabric-sql'
  $eventhouse = Join-Path $Script:Staging 'eventhouse'

  if (Test-Path -LiteralPath $fabricSql -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $fabricSql -Filter '*.csv' -File | Sort-Object FullName) {
      $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
      if (-not (Test-Identifier $table)) {
        Fail "Unsafe Lakehouse analytics table name derived from file $($csv.Name): $table"
      }
      $rows = Get-CsvRowCount $csv.FullName
      Invoke-Fabio -Arguments @('lakehouse', 'upload', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', $csv.FullName, '--dest-path', "Files/analytics/fabric-sql/$($csv.Name)")
      Invoke-Fabio -Arguments @('lakehouse', 'load-table', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', "Files/analytics/fabric-sql/$($csv.Name)", '--table', $table, '--mode', 'Overwrite', '--format', 'Csv')
      $Script:LakehouseAnalyticsDeltaTablesLoaded++
      $Script:LakehouseAnalyticsRowsLoaded += $rows
    }
  }

  if (Test-Path -LiteralPath $eventhouse -PathType Container) {
    foreach ($csv in Get-ChildItem -LiteralPath $eventhouse -Filter '*.csv' -File | Sort-Object FullName) {
      $table = Get-KqlTableForCsv $csv.FullName $eventhouse
      if (-not (Test-Identifier $table)) {
        Fail "Unsafe Lakehouse analytics table name derived for Eventhouse file $($csv.Name): $table"
      }
      $rows = Get-CsvRowCount $csv.FullName
      Invoke-Fabio -Arguments @('lakehouse', 'load-table', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--source-path', "Files/eventhouse/$($csv.Name)", '--table', $table, '--mode', 'Overwrite', '--format', 'Csv')
      $Script:LakehouseAnalyticsDeltaTablesLoaded++
      $Script:LakehouseAnalyticsRowsLoaded += $rows
    }
  }
}

function Resolve-ExistingOptionalItem([string]$Type, [string]$Name) {
  Ensure-QuerySafe $Name "$Type item name"
  $query = "[?displayName=='$Name'].id | [0]"

  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'item', 'list', '--workspace', $Script:WorkspaceId, '--type', $Type, '--query', $query, '--output', 'plain')
    return ''
  }

  try {
    $result = Invoke-Fabio -Arguments @('item', 'list', '--workspace', $Script:WorkspaceId, '--type', $Type, '--query', $query, '--output', 'plain') -Capture
  } catch {
    Warn "Could not resolve $Type '$Name': $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
    return $null
  }

  $id = $result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
  if (-not [string]::IsNullOrWhiteSpace($id) -and $id.Trim() -ne 'null') {
    return $id.Trim()
  }
  return ''
}

function Find-JsonPropertyValue([object]$Value, [string[]]$Names) {
  if ($null -eq $Value -or $Value -is [string]) { return '' }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    foreach ($entry in $Value) {
      $found = Find-JsonPropertyValue $entry $Names
      if (-not [string]::IsNullOrWhiteSpace($found)) { return $found }
    }
    return ''
  }

  foreach ($name in $Names) {
    foreach ($property in $Value.PSObject.Properties) {
      if ($property.Name -ieq $name -and $property.Value -is [string] -and $property.Value -match '^https?://') {
        return $property.Value
      }
    }
  }

  foreach ($property in $Value.PSObject.Properties) {
    $found = Find-JsonPropertyValue $property.Value $Names
    if (-not [string]::IsNullOrWhiteSpace($found)) { return $found }
  }
  return ''
}

function Get-EventhouseQueryUri {
  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'eventhouse', 'show', '--workspace', $Script:WorkspaceId, '--id', $Script:EventhouseId, '--output', 'json')
    return '<eventhouse-query-uri>'
  }

  try {
    $json = Invoke-Fabio -Arguments @('eventhouse', 'show', '--workspace', $Script:WorkspaceId, '--id', $Script:EventhouseId, '--output', 'json') -Capture
    $payload = $json | ConvertFrom-Json
    $root = if ($payload.PSObject.Properties.Name -contains 'data') { $payload.data } else { $payload }
    $uri = ''
    if ($root.PSObject.Properties.Name -contains 'properties' -and
        $null -ne $root.properties -and
        $root.properties.PSObject.Properties.Name -contains 'queryServiceUri' -and
        $root.properties.queryServiceUri -is [string]) {
      $uri = $root.properties.queryServiceUri
    }
    if ([string]::IsNullOrWhiteSpace($uri)) {
      Warn 'Could not find properties.queryServiceUri in fabio eventhouse show output; ontology Eventhouse binding was skipped.'
      $Script:FabricItemWarnings = $true
      return ''
    }
    return $uri
  } catch {
    Warn "Could not read Eventhouse details for ontology binding: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
    return ''
  }
}

function Set-OntologyBindingCounts([string]$BindingsPath) {
  if (-not (Test-Path -LiteralPath $BindingsPath -PathType Leaf)) { return }
  try {
    $payload = Get-Content -LiteralPath $BindingsPath -Raw | ConvertFrom-Json
    if ($null -ne $payload.entities) {
      $Script:OntologyEntityBindingCount = [string]@($payload.entities.PSObject.Properties).Count
    }
    if ($null -ne $payload.relationships) {
      $Script:OntologyContextualizationCount = [string]@($payload.relationships.PSObject.Properties).Count
    }
  } catch {
    Warn "Could not read ontology binding counts from ${BindingsPath}: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
  }
}

function New-OntologyBindings {
  Write-Host 'Checking ontology definition compatibility...'
  $checkArgs = @((Join-Path $Script:DataDir 'tools/build-ontology.ts'), '--check')
  Write-NodeDryRun $checkArgs
  Invoke-NodeRequiredVisible -Arguments $checkArgs

  $Script:OntologyBindingsOutput = Join-Path $Script:Staging 'fabric-items/ontology-bindings.json'
  $clusterUri = Get-EventhouseQueryUri
  if ([string]::IsNullOrWhiteSpace($clusterUri)) {
    Warn 'Ontology deploy-ready binding map was not generated because the Eventhouse query URI could not be discovered.'
    $Script:FabricItemWarnings = $true
    return $false
  }

  Write-Host 'Generating ontology binding map.'
  $buildArgs = @(
    (Join-Path $Script:DataDir 'tools/build-ontology.ts'),
    '--bindings-output', $Script:OntologyBindingsOutput,
    '--eventhouse', $Script:EventhouseId,
    '--cluster-uri', $clusterUri,
    '--database', $Script:KqlDatabaseName
  )
  Write-NodeDryRun $buildArgs
  try {
    Invoke-NodeRequiredVisible -Arguments $buildArgs
    Set-OntologyBindingCounts $Script:OntologyBindingsOutput
    return $true
  } catch {
    Warn "Ontology binding map generation failed and may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
    return $false
  }
}

function Bind-Ontology {
  if ([string]::IsNullOrWhiteSpace($Script:OntologyBindingsOutput) -or -not (Test-Path -LiteralPath $Script:OntologyBindingsOutput -PathType Leaf)) {
    Warn 'Ontology binding map was not available; ontology binding was skipped.'
    $Script:OntologyBindingStatus = 'failed'
    $Script:FabricItemWarnings = $true
    return
  }

  try {
    $null = Invoke-Fabio -Arguments @('ontology', 'bind', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--lakehouse', $Script:LakehouseId, '--bindings', $Script:OntologyBindingsOutput) -Capture
    $Script:OntologyBindingStatus = 'bound'
  } catch {
    Warn "Ontology binding did not complete and may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:OntologyBindingStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Deploy-Ontology {
  if ($Script:SkipFabricItems) {
    $Script:OntologyStatus = 'skipped'
    $Script:OntologyBindingStatus = 'skipped'
    return
  }
  if (-not (Test-Path -LiteralPath $Script:OntologyDir -PathType Container)) {
    Warn "Ontology source directory was not found at $($Script:OntologyDir); skipping ontology deployment."
    $Script:OntologyStatus = 'skipped'
    $Script:OntologyBindingStatus = 'skipped'
    return
  }

  $bindingsReady = New-OntologyBindings
  if (-not $bindingsReady) {
    $Script:OntologyBindingStatus = 'failed'
  }

  $existing = Resolve-ExistingOptionalItem 'Ontology' $Script:OntologyName
  if ($null -eq $existing) {
    $Script:OntologyStatus = 'failed'
    $Script:OntologyBindingStatus = 'failed'
    return
  }
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    $Script:OntologyId = $existing
    $Script:OntologyStatus = 'resolved'
    Write-Host "Resolved Ontology '$($Script:OntologyName)': $($Script:OntologyId)"
    if ($bindingsReady) {
      Bind-Ontology
    }
    return
  }

  if ($Script:DryRun) {
    $null = Invoke-Fabio -Arguments @('ontology', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:OntologyName, '--dir', $Script:OntologyDir, '--query', 'id', '--output', 'plain') -Capture
    $Script:OntologyId = "<$($Script:OntologyName)-id>"
    $Script:OntologyStatus = 'created'
    if ($bindingsReady) {
      Bind-Ontology
    }
    return
  }

  try {
    $created = Invoke-Fabio -Arguments @('ontology', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:OntologyName, '--dir', $Script:OntologyDir, '--query', 'id', '--output', 'plain') -Capture
    $Script:OntologyId = ($created -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
    if ([string]::IsNullOrWhiteSpace($Script:OntologyId) -or $Script:OntologyId -eq 'null') {
      Warn "fabio ontology create did not return an id for '$($Script:OntologyName)'."
      $Script:OntologyStatus = 'failed'
      $Script:OntologyBindingStatus = 'failed'
      $Script:FabricItemWarnings = $true
      return
    }
    $Script:OntologyStatus = 'created'
    if ($bindingsReady) {
      Bind-Ontology
    }
  } catch {
    Warn "Ontology deployment failed and may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:OntologyStatus = 'failed'
    $Script:OntologyBindingStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Refresh-SemanticModel {
  try {
    $null = Invoke-Fabio -Arguments @('semantic-model', 'refresh', '--workspace', $Script:WorkspaceId, '--id', $Script:SemanticModelId, '--type', 'full') -Capture
    $Script:SemanticModelRefreshStatus = 'refreshed'
  } catch {
    Warn "Semantic model refresh did not complete; Direct Lake framing may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:SemanticModelRefreshStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Test-FabricItemId([string]$Value) {
  return $Value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

function Find-JsonIdPropertyValue([object]$Value, [string[]]$Names) {
  if ($null -eq $Value -or $Value -is [string]) { return '' }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    foreach ($entry in $Value) {
      $found = Find-JsonIdPropertyValue $entry $Names
      if (-not [string]::IsNullOrWhiteSpace($found)) { return $found }
    }
    return ''
  }

  foreach ($name in $Names) {
    foreach ($property in $Value.PSObject.Properties) {
      if ($property.Name -ieq $name -and $property.Value -is [string] -and (Test-FabricItemId $property.Value)) {
        return $property.Value
      }
    }
  }

  foreach ($property in $Value.PSObject.Properties) {
    $lower = $property.Name.ToLowerInvariant()
    if ($lower.Contains('sql') -and $lower.Contains('endpoint')) {
      if ($property.Value -is [string] -and (Test-FabricItemId $property.Value)) {
        return $property.Value
      }
      if ($null -ne $property.Value -and $property.Value.PSObject.Properties.Name -contains 'id' -and (Test-FabricItemId $property.Value.id)) {
        return $property.Value.id
      }
    }
  }

  foreach ($property in $Value.PSObject.Properties) {
    $found = Find-JsonIdPropertyValue $property.Value $Names
    if (-not [string]::IsNullOrWhiteSpace($found)) { return $found }
  }
  return ''
}

function Resolve-SemanticModelConnection {
  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'lakehouse', 'show', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--output', 'json')
    $Script:SemanticModelSqlEndpointHost = '<sql-endpoint-host>'
    $Script:SemanticModelConnectionId = '<sql-endpoint-id>'
    $Script:SemanticModelConnectionSource = 'Lakehouse SQL endpoint'
    return $true
  }

  try {
    $json = Invoke-Fabio -Arguments @('lakehouse', 'show', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--output', 'json') -Capture
    $payload = $json | ConvertFrom-Json
    $root = if ($payload.PSObject.Properties.Name -contains 'data') { $payload.data } else { $payload }
    $props = $null
    if ($root.PSObject.Properties.Name -contains 'properties' -and
        $null -ne $root.properties -and
        $root.properties.PSObject.Properties.Name -contains 'sqlEndpointProperties') {
      $props = $root.properties.sqlEndpointProperties
    }
    if ($null -ne $props -and
        $props.connectionString -is [string] -and
        -not [string]::IsNullOrWhiteSpace($props.connectionString) -and
        $props.id -is [string] -and
        -not [string]::IsNullOrWhiteSpace($props.id)) {
      $Script:SemanticModelSqlEndpointHost = $props.connectionString
      $Script:SemanticModelConnectionId = $props.id
      $Script:SemanticModelConnectionSource = 'Lakehouse SQL endpoint'
      return $true
    }
    Warn 'Could not find properties.sqlEndpointProperties.connectionString/id in fabio lakehouse show output.'
  } catch {
    Warn "Could not read Lakehouse details for semantic model connection discovery: $($_.Exception.Message)"
  }

  $Script:FabricItemWarnings = $true
  return $false
}

function Invoke-SemanticModelConverter {
  $args = @(
    (Join-Path $Script:DataDir 'tools/build-semantic-model.ts'),
    '--sql-endpoint-host', $Script:SemanticModelSqlEndpointHost,
    '--sql-endpoint-id', $Script:SemanticModelConnectionId
  )

  if ($Script:DryRun) {
    Write-NodeDryRun $args
    return $true
  }

  try {
    Invoke-NodeRequiredVisible -Arguments $args
    return $true
  } catch {
    Warn "Semantic model converter failed and may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
    return $false
  }
}

function Deploy-SemanticModel {
  if ($Script:SkipFabricItems) {
    $Script:SemanticModelStatus = 'skipped'
    $Script:SemanticModelRefreshStatus = 'skipped'
    return
  }

  $existing = Resolve-ExistingOptionalItem 'SemanticModel' $Script:SemanticModelName
  if ($null -eq $existing) {
    $Script:SemanticModelStatus = 'failed'
    $Script:SemanticModelRefreshStatus = 'failed'
    return
  }
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    $Script:SemanticModelId = $existing
    $Script:SemanticModelStatus = 'resolved'
    Write-Host "Resolved SemanticModel '$($Script:SemanticModelName)': $($Script:SemanticModelId)"
    Refresh-SemanticModel
    return
  }

  if (-not (Test-Path -LiteralPath $Script:SemanticModelDir -PathType Container)) {
    Warn "Semantic model definition folder was not found at $($Script:SemanticModelDir); semantic-model create/refresh was skipped."
    $Script:SemanticModelStatus = 'skipped'
    $Script:SemanticModelRefreshStatus = 'skipped'
    return
  }
  if (-not (Resolve-SemanticModelConnection)) {
    $Script:SemanticModelStatus = 'failed'
    $Script:SemanticModelRefreshStatus = 'failed'
    return
  }
  if (-not (Invoke-SemanticModelConverter)) {
    $Script:SemanticModelStatus = 'failed'
    $Script:SemanticModelRefreshStatus = 'failed'
    return
  }

  if ($Script:DryRun) {
    $null = Invoke-Fabio -Arguments @('semantic-model', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:SemanticModelName, '--definition', $Script:SemanticModelDir, '--connection', $Script:SemanticModelConnectionId, '--query', 'id', '--output', 'plain') -Capture
    $Script:SemanticModelId = "<$($Script:SemanticModelName)-id>"
    $Script:SemanticModelStatus = 'created'
    Refresh-SemanticModel
    return
  }

  try {
    $created = Invoke-Fabio -Arguments @('semantic-model', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:SemanticModelName, '--definition', $Script:SemanticModelDir, '--connection', $Script:SemanticModelConnectionId, '--query', 'id', '--output', 'plain') -Capture
    $Script:SemanticModelId = ($created -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim()
    if ([string]::IsNullOrWhiteSpace($Script:SemanticModelId) -or $Script:SemanticModelId -eq 'null') {
      Warn "fabio semantic-model create did not return an id for '$($Script:SemanticModelName)'."
      $Script:SemanticModelStatus = 'failed'
      $Script:SemanticModelRefreshStatus = 'failed'
      $Script:FabricItemWarnings = $true
      return
    }
    $Script:SemanticModelStatus = 'created'
    Refresh-SemanticModel
  } catch {
    Warn "Semantic model deployment failed and may need finishing in the Fabric portal: $($_.Exception.Message)"
    $Script:SemanticModelStatus = 'failed'
    $Script:SemanticModelRefreshStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Verify-OntologyPeerSurface {
  if ($Script:SkipFabricItems -or
      $Script:OntologyStatus -eq 'skipped' -or
      $Script:OntologyStatus -eq 'failed' -or
      [string]::IsNullOrWhiteSpace($Script:OntologyId)) {
    $Script:OntologyMcpUrlStatus = 'skipped'
    $Script:OntologySearchStatus = 'skipped'
    return
  }

  try {
    $output = Invoke-Fabio -Arguments @('ontology', 'mcp-url', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--output', 'plain') -Capture
    if ($Script:DryRun) {
      $Script:OntologyMcpUrl = '<ontology-mcp-url>'
      $Script:OntologyMcpUrlStatus = 'dry-run'
    }
    else {
      $url = $output -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
      if (-not [string]::IsNullOrWhiteSpace($url) -and $url.Trim() -ne 'null') {
        $Script:OntologyMcpUrl = $url.Trim()
        $Script:OntologyMcpUrlStatus = 'resolved'
        Write-Host "Ontology MCP endpoint: $($Script:OntologyMcpUrl)"
      }
      else {
        Warn 'Ontology MCP endpoint command did not return a URL.'
        $Script:OntologyMcpUrlStatus = 'failed'
        $Script:FabricItemWarnings = $true
      }
    }
  } catch {
    Warn "Ontology MCP endpoint lookup did not complete: $($_.Exception.Message)"
    $Script:OntologyMcpUrlStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }

  # Read the signal id from the scenario rather than hardcoding it, so a calendar
  # move or rename does not silently turn this smoke test into a query that
  # matches nothing and still "passes".
  $signalId = ''
  try {
    $scenarioPath = Join-Path $Script:DataDir 'scenario.json'
    if (Test-Path $scenarioPath) {
      $signalId = [string]((Get-Content $scenarioPath -Raw | ConvertFrom-Json).externalSignal.signalId)
    }
  }
  catch { $signalId = '' }
  if ([string]::IsNullOrWhiteSpace($signalId)) { $signalId = 'the persistent El Nino advisory' }
  $prompt = "Which regions are affected by the El Nino signal ${signalId}?"
  try {
    $output = Invoke-Fabio -Arguments @('ontology', 'search', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--prompt', $prompt, '--output', 'plain') -Capture
    if ($Script:DryRun) {
      $Script:OntologySearchStatus = 'dry-run'
    }
    elseif (-not [string]::IsNullOrWhiteSpace($output)) {
      $Script:OntologySearchStatus = 'answered'
      Write-Host 'PASS: Ontology search smoke test answered the El Nino affected-regions question.'
    }
    else {
      Warn 'Ontology search smoke test returned no answer.'
      $Script:OntologySearchStatus = 'empty'
      $Script:FabricItemWarnings = $true
    }
  } catch {
    Warn "Ontology search smoke test did not complete: $($_.Exception.Message)"
    $Script:OntologySearchStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Get-DataAgentDefaultDescription {
  return 'Caldova analyst data agent for the LTG243 Fabric IQ demo.'
}

function Convert-DataAgentConfig {
  $agentJson = Join-Path $Script:DataAgentDir 'agent.json'
  $code = @'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
function norm(value) { return String(value).replace(/[^A-Za-z0-9]/g, "").toLowerCase(); }
function prop(obj, names) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const wanted = new Set(names.map(norm));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(norm(key))) return value;
  }
  return undefined;
}
function str(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
function sourceEntries(value) {
  if (Array.isArray(value)) return value.map((source) => ({ source, mapKey: "" }));
  if (value && typeof value === "object") {
    return Object.entries(value).map(([mapKey, source]) => ({ source, mapKey }));
  }
  return [];
}
function findSources(root) {
  if (Array.isArray(root)) return sourceEntries(root);
  const direct = prop(root, ["dataSources", "datasources", "sources", "sourceList", "artifacts"]);
  return sourceEntries(direct);
}
function flattenSelected(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenSelected);
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "object") {
    const named = str(prop(value, ["name", "displayName", "table", "element", "entity", "id"]));
    if (named) return [named];
    const out = [];
    for (const [key, nested] of Object.entries(value)) {
      if (nested === true) out.push(key);
      else out.push(...flattenSelected(nested));
    }
    return out;
  }
  return [];
}
const roots = [
  config,
  prop(config, ["agent", "dataAgent", "definition", "config"])
].filter(Boolean);
let fewShotDirectory = "fewshots";
for (const root of roots) {
  const dir = str(prop(root, ["fewShotDirectory", "fewShotsDirectory", "fewshotDirectory"]));
  if (dir) {
    fewShotDirectory = dir;
    break;
  }
}
let description = "";
for (const root of roots) {
  description = str(prop(root, ["description", "agentDescription", "summary"]));
  if (description) break;
}
const instructionsFile = str(prop(config, ["instructionsFile", "instructionFile", "instructionsPath"]));
let entries = [];
for (const root of roots) {
  entries = findSources(root);
  if (entries.length) break;
}
const sources = [];
const seen = new Set();
for (const entry of entries) {
  const source = entry.source && typeof entry.source === "object" && !Array.isArray(entry.source)
    ? entry.source
    : { artifact: entry.source };
  const artifact = prop(source, ["artifact", "item", "fabricItem", "datasource", "dataSource"]);
  const artifactObj = artifact && typeof artifact === "object" && !Array.isArray(artifact) ? artifact : undefined;
  const itemName =
    str(prop(source, ["artifactName", "artifactDisplayName", "itemName", "fabricItemName", "displayName"])) ||
    str(prop(artifactObj, ["name", "displayName", "itemName", "artifactName"])) ||
    str(artifact);
  const artifactType =
    str(prop(source, ["artifactType", "itemType", "type"])) ||
    str(prop(artifactObj, ["artifactType", "itemType", "type"]));
  const key =
    str(prop(source, ["key", "logicalKey", "logicalName", "sourceKey"])) ||
    entry.mapKey ||
    itemName ||
    artifactType;
  const instructions =
    str(prop(source, ["instructions", "instruction", "sourceInstructions", "datasourceInstructions"])) ||
    str(prop(artifactObj, ["instructions", "instruction"]));
  const selectedElements = [...new Set(flattenSelected(prop(source, ["selectedElements", "selectedTables", "elements", "tables", "selection", "include"])))];
  const attachAs = str(prop(source, ["attachAs", "attachMode", "surface"])) || "DataSource";
  const rawFewShotsUploadable = prop(source, ["fewShotsUploadable", "fewShotUploadable", "uploadFewShots"]);
  const fewShotsUploadable = rawFewShotsUploadable === true ? "true" : rawFewShotsUploadable === false ? "false" : str(rawFewShotsUploadable).toLowerCase();
  let fewShotFile = str(prop(source, ["fewShotFile", "fewShotsFile", "fewshotFile", "fewShotPath", "fewShotsPath"]));
  if (fewShotFile && !/[\\/]/.test(fewShotFile) && fewShotDirectory) {
    fewShotFile = `${fewShotDirectory.replace(/[\\/]+$/, "")}/${fewShotFile}`;
  }
  if (!key || !itemName || !artifactType) continue;
  const identity = `${key}\u0000${itemName}\u0000${artifactType}`;
  if (seen.has(identity)) continue;
  seen.add(identity);
  sources.push({ key, itemName, artifactType, attachAs, instructions, selectedElements, fewShotFile, fewShotsUploadable });
}
console.log(JSON.stringify({ description, instructionsFile, sources }));
'@
  $output = & node -e $code $agentJson
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "node failed to parse $agentJson with exit code $exitCode."
  }
  return (($output | Out-String).Trim() | ConvertFrom-Json)
}

function Test-SafeDataAgentKey([string]$Key) {
  return $Key -match '^[A-Za-z0-9_.-]+$'
}

function Get-DataAgentCanonicalArtifactType([string]$ArtifactType, [string]$ItemName) {
  $normalized = Normalize-Name $ArtifactType
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    switch ($ItemName) {
      $Script:SemanticModelName { $normalized = 'semanticmodel'; break }
      $Script:OntologyName { $normalized = 'ontology'; break }
      $Script:KqlDatabaseName { $normalized = 'kqldatabase'; break }
      $Script:LakehouseName { $normalized = 'lakehouse'; break }
      $Script:SqlDatabaseName { $normalized = 'sqldatabase'; break }
    }
  }

  switch ($normalized) {
    'semanticmodel' { return 'SemanticModel' }
    'ontology' { return 'Ontology' }
    'kqldatabase' { return 'KQLDatabase' }
    'kustodatabase' { return 'KQLDatabase' }
    'lakehouse' { return 'Lakehouse' }
    'sqldatabase' { return 'SQLDatabase' }
    default { return '' }
  }
}

function Get-DataAgentArtifactId([string]$CanonicalType) {
  switch ($CanonicalType) {
    'SemanticModel' { return $Script:SemanticModelId }
    'Ontology' { return $Script:OntologyId }
    'KQLDatabase' { return $Script:KqlDatabaseId }
    'Lakehouse' { return $Script:LakehouseId }
    'SQLDatabase' { return $Script:SqlDatabaseId }
    default { return '' }
  }
}

function Resolve-OrCreateDataAgent([string]$Description) {
  Ensure-QuerySafe $Script:DataAgentName 'DataAgent item name'
  $query = "[?displayName=='$($Script:DataAgentName)'].id | [0]"

  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'data-agent', 'list', '--workspace', $Script:WorkspaceId, '--query', $query, '--output', 'plain')
    if (-not $Script:VerifyOnly) {
      Write-DryRun @('fabio', 'data-agent', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:DataAgentName, '--description', $Description, '--query', 'id', '--output', 'plain')
    }
    $Script:DataAgentId = "<$($Script:DataAgentName)-id>"
    $Script:DataAgentStatus = 'created'
    return $true
  }

  try {
    $existing = Invoke-Fabio -Arguments @('data-agent', 'list', '--workspace', $Script:WorkspaceId, '--query', $query, '--output', 'plain') -Capture
    $id = $existing -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    if (-not [string]::IsNullOrWhiteSpace($id) -and $id.Trim() -ne 'null') {
      $Script:DataAgentId = $id.Trim()
      $Script:DataAgentStatus = 'resolved'
      Write-Host "Resolved DataAgent '$($Script:DataAgentName)': $($Script:DataAgentId)"
      return $true
    }
  } catch {
    Warn "Could not resolve data agent '$($Script:DataAgentName)': $($_.Exception.Message)"
    $Script:DataAgentStatus = 'failed'
    $Script:FabricItemWarnings = $true
    return $false
  }

  try {
    $created = Invoke-Fabio -Arguments @('data-agent', 'create', '--workspace', $Script:WorkspaceId, '--name', $Script:DataAgentName, '--description', $Description, '--query', 'id', '--output', 'plain') -Capture
    $Script:DataAgentId = $created -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    if (-not [string]::IsNullOrWhiteSpace($Script:DataAgentId) -and $Script:DataAgentId.Trim() -ne 'null') {
      $Script:DataAgentId = $Script:DataAgentId.Trim()
      $Script:DataAgentStatus = 'created'
      return $true
    }
    Warn "fabio data-agent create did not return an id for '$($Script:DataAgentName)'."
  } catch {
    Warn "Data agent creation failed and may need finishing in the Fabric portal: $($_.Exception.Message)"
  }

  $Script:DataAgentStatus = 'failed'
  $Script:FabricItemWarnings = $true
  return $false
}

function Get-DataAgentAct1Question {
  $questions = Join-Path $Script:DataDir 'evaluation/questions.json'
  $code = 'const fs=require("node:fs"); const entries=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const selected=entries.find((entry)=>String(entry.act)==="1") || entries[0]; if(!selected || typeof selected.question!=="string" || !selected.question.trim()) process.exit(2); console.log(selected.question.trim());'
  $output = & node -e $code $questions
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { return '' }
  return (($output | Out-String).Trim())
}

function New-DataAgentEvaluationQuestions {
  $source = Join-Path $Script:DataDir 'evaluation/questions.json'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    Warn "Evaluation questions file was not found at $source; data agent evaluation was skipped."
    $Script:DataAgentEvaluationStatus = 'skipped'
    $Script:FabricItemWarnings = $true
    return $false
  }

  $output = Join-Path $Script:Staging 'fabric-items/data-agent-evaluation-questions.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
  $code = 'const fs=require("node:fs"); const entries=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(entries)) throw new Error("questions.json must be an array"); const questions=entries.map((entry)=>({question:String(entry.question||"").trim(), expected:Array.isArray(entry.expectedFacts) ? entry.expectedFacts.map(String).join("; ") : String(entry.expected||"").trim()})).filter((entry)=>entry.question); fs.writeFileSync(process.argv[2], JSON.stringify(questions,null,2)+"\n");'
  & node -e $code $source $output
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Warn "Could not derive fabio data-agent evaluation questions from $source."
    $Script:DataAgentEvaluationStatus = 'failed'
    $Script:FabricItemWarnings = $true
    return $false
  }
  $Script:DataAgentEvaluationQuestions = $output
  return $true
}

function Test-DataAgentQueryBlockedByTenantSetting([string]$Message) {
  return ($Message -match 'AllowStoreAOAIDataInOtherRegions' -or
    ($Message -match 'Data sent to Azure OpenAI can be stored outside your capacity' -and
     $Message -match 'geographic region'))
}

function Test-DataAgentFewshotsUploadable([string]$Value) {
  return $Value -match '^(?i:true|1|yes)$'
}

function Verify-DataAgentFewshots([string]$Key, [string]$SourceRef) {
  try {
    $output = Invoke-Fabio -Arguments @('data-agent', 'list-fewshots', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--datasource', $SourceRef, '--all', '--query', 'length(@)', '--output', 'plain') -Capture
    if ($Script:DryRun) {
      $Script:DataAgentFewshotStatus = 'dry-run'
      return
    }
    $line = $output -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    $count = 0
    if (-not [int]::TryParse([string]$line, [ref]$count)) {
      $count = 0
    }
    if ($count -gt 0) {
      $Script:DataAgentFewshotSourcesVerified++
      if ($Script:DataAgentFewshotStatus -ne 'failed') {
        $Script:DataAgentFewshotStatus = 'verified'
      }
      Write-Host "PASS: Data agent source '$Key' reports $count stored few-shot example(s)."
    }
    else {
      Warn "Data agent source '$Key' accepted a few-shot upload but list-fewshots returned zero examples."
      $Script:DataAgentFewshotStatus = 'failed'
      $Script:FabricItemWarnings = $true
    }
  } catch {
    Warn "Few-shot verification for data agent source '$Key' did not complete: $($_.Exception.Message)"
    $Script:DataAgentFewshotStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Verify-DataAgentAct1Answer {
  if ($Script:DataAgentPublished -ne 'yes') { return }
  $question = Get-DataAgentAct1Question
  if ([string]::IsNullOrWhiteSpace($question)) {
    Warn 'Could not read the Act 1 evaluation question; data agent query verification was skipped.'
    $Script:DataAgentElNinoSignalStatus = 'skipped'
    $Script:FabricItemWarnings = $true
    return
  }

  try {
    $output = Invoke-Fabio -Arguments @('data-agent', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--prompt', $question, '--output', 'plain') -Capture
    if ($Script:DryRun) {
      $Script:DataAgentElNinoSignalStatus = 'dry-run'
      return
    }
    if ($output -match '(?i)(El\s*-?\s*Nino|ENSO|SIG-ENSO)') {
      Write-Host 'PASS: Data agent Act 1 answer mentioned the El Nino signal.'
      $Script:DataAgentElNinoSignalStatus = 'mentioned'
    }
    else {
      Warn 'Data agent Act 1 answer did not clearly mention the El Nino signal; review the published agent response.'
      $Script:DataAgentElNinoSignalStatus = 'not mentioned'
      $Script:FabricItemWarnings = $true
    }
  } catch {
    $message = $_.Exception.Message
    if (Test-DataAgentQueryBlockedByTenantSetting $message) {
      Warn "Data agent Act 1 query is blocked by Fabric tenant setting AllowStoreAOAIDataInOtherRegions ('Data sent to Azure OpenAI can be stored outside your capacity's geographic region'). Ask a Fabric admin to enable that setting; the agent deployment can still be valid."
      $Script:DataAgentElNinoSignalStatus = 'blocked by tenant setting AllowStoreAOAIDataInOtherRegions'
    }
    else {
      Warn "Data agent Act 1 query verification did not complete: $message"
      $Script:DataAgentElNinoSignalStatus = 'failed'
    }
    $Script:FabricItemWarnings = $true
  }
}

function Invoke-DataAgentEvaluation {
  if (-not $Script:EvaluateAgent) { return }
  if ($Script:DataAgentPublished -ne 'yes' -or [string]::IsNullOrWhiteSpace($Script:DataAgentId)) {
    Warn 'Data agent evaluation was requested but no published agent is available.'
    $Script:DataAgentEvaluationStatus = 'skipped'
    $Script:FabricItemWarnings = $true
    return
  }
  if (-not (New-DataAgentEvaluationQuestions)) { return }

  try {
    $output = Invoke-Fabio -Arguments @('data-agent', 'evaluate', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--questions', $Script:DataAgentEvaluationQuestions) -Capture
    $Script:DataAgentEvaluationStatus = if ($Script:DryRun) { 'dry-run' } else { 'ran' }
    if (-not [string]::IsNullOrWhiteSpace($output)) {
      Write-Host $output
    }
  } catch {
    Warn "Data agent evaluation did not complete: $($_.Exception.Message)"
    $Script:DataAgentEvaluationStatus = 'failed'
    $Script:FabricItemWarnings = $true
  }
}

function Deploy-DataAgent {
  if ($Script:SkipFabricItems) {
    $Script:DataAgentStatus = 'skipped'
    $Script:DataAgentPublished = 'no'
    $Script:DataAgentElNinoSignalStatus = 'skipped'
    $Script:DataAgentEvaluationStatus = 'skipped'
    $Script:DataAgentFewshotStatus = 'skipped'
    $Script:DataAgentFewshotSourcesVerified = 0
    return
  }

  $agentJson = Join-Path $Script:DataAgentDir 'agent.json'
  $description = Get-DataAgentDefaultDescription
  $config = $null
  if (Test-Path -LiteralPath $agentJson -PathType Leaf) {
    try {
      $config = Convert-DataAgentConfig
      if (-not [string]::IsNullOrWhiteSpace($config.description)) {
        $description = [string]$config.description
      }
    } catch {
      Warn "Could not parse data agent config from ${agentJson}: $($_.Exception.Message)"
      $Script:FabricItemWarnings = $true
    }
  }
  else {
    Warn "Data agent definition was not found at $agentJson; only the resolve/create command will be planned."
    $Script:FabricItemWarnings = $true
  }

  if ($description.Length -gt 256) {
    Warn "Data agent description is longer than fabio's 256-character limit; using the first 256 characters."
    $description = $description.Substring(0, 256)
  }

  if (-not (Resolve-OrCreateDataAgent $description)) { return }
  if (-not (Test-Path -LiteralPath $agentJson -PathType Leaf)) { return }
  if ($null -eq $config) { return }

  $instructionsFile = if ($null -ne $config.instructionsFile -and -not [string]::IsNullOrWhiteSpace($config.instructionsFile)) { [string]$config.instructionsFile } else { 'instructions.md' }
  if ([System.IO.Path]::IsPathRooted($instructionsFile)) {
    $instructions = $instructionsFile
  }
  else {
    $instructions = Join-Path $Script:DataAgentDir $instructionsFile
  }
  if (Test-Path -LiteralPath $instructions -PathType Leaf) {
    try {
      $null = Invoke-Fabio -Arguments @('data-agent', 'update-config', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--instructions-file', $instructions) -Capture
    } catch {
      Warn "Data agent instructions update did not complete: $($_.Exception.Message)"
      $Script:FabricItemWarnings = $true
    }
  }
  else {
    Warn "Data agent instructions file was not found at $instructions; continuing without global agent instructions."
    $Script:FabricItemWarnings = $true
  }

  $sources = @($config.sources)
  if ($sources.Count -eq 0) {
    Warn "No data agent sources were found in $agentJson; publish was skipped."
    $Script:FabricItemWarnings = $true
    return
  }

  foreach ($source in $sources) {
    $key = [string]$source.key
    $itemName = [string]$source.itemName
    $artifactType = [string]$source.artifactType
    $attachAs = [string]$source.attachAs
    $normalizedAttachAs = Normalize-Name $attachAs
    $canonicalType = Get-DataAgentCanonicalArtifactType $artifactType $itemName
    if ([string]::IsNullOrWhiteSpace($canonicalType)) {
      Warn "Data agent source '$key' uses unsupported artifactType '$artifactType'; skipping."
      $Script:FabricItemWarnings = $true
      continue
    }

    $fewshot = ''
    if (-not [string]::IsNullOrWhiteSpace($source.fewShotFile)) {
      $configuredFewshot = [string]$source.fewShotFile
      if ([System.IO.Path]::IsPathRooted($configuredFewshot)) {
        $fewshot = $configuredFewshot
      }
      else {
        $fewshot = Join-Path $Script:DataAgentDir $configuredFewshot
      }
    }

    if ($normalizedAttachAs -eq 'peersurface') {
      if ($canonicalType -eq 'Ontology') {
        Write-Host "Using data agent source '$key' as a peer surface from agent.json attachAs=PeerSurface."
        Verify-OntologyPeerSurface
      }
      else {
        Warn "Data agent source '$key' has attachAs=PeerSurface, but artifactType '$artifactType' does not have a scripted peer-surface verifier."
        $Script:FabricItemWarnings = $true
      }
      continue
    }

    if ($normalizedAttachAs -ne 'datasource') {
      Warn "Data agent source '$key' has unsupported attachAs='$attachAs'; skipping."
      $Script:FabricItemWarnings = $true
      continue
    }

    $artifactId = Get-DataAgentArtifactId $canonicalType
    if ([string]::IsNullOrWhiteSpace($artifactId)) {
      Warn "Data agent source '$key' references $canonicalType '$itemName', but the corresponding item id is not available; skipping."
      $Script:FabricItemWarnings = $true
      continue
    }

    $addArgs = @('data-agent', 'add-datasource', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--artifact', $artifactId, '--artifact-type', $canonicalType)
    if (-not [string]::IsNullOrWhiteSpace($source.instructions)) {
      $addArgs += @('--instructions', [string]$source.instructions)
    }
    $addArgs += @('--query', 'id', '--output', 'plain')

    try {
      $added = Invoke-Fabio -Arguments $addArgs -Capture
      $Script:DataAgentSourcesAttached++
      $sourceRef = $added -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
      if ($Script:DryRun) {
        $placeholder = Normalize-Name $key
        if ([string]::IsNullOrWhiteSpace($placeholder)) { $placeholder = Normalize-Name $canonicalType }
        $sourceRef = "<$placeholder-datasource-id>"
      }
      elseif ([string]::IsNullOrWhiteSpace($sourceRef) -or $sourceRef.Trim() -eq 'null') {
        $sourceRef = $artifactId
      }
      else {
        $sourceRef = $sourceRef.Trim()
      }
    } catch {
      if ("$($_.Exception.Message)" -match 'AlreadyAddedDataSource') {
        # Re-running the deployment must be a no-op here, not a failure. The
        # source is already attached, so treat it as attached and carry on;
        # otherwise the attach count stays at zero and publish is skipped on
        # every rerun.
        Write-Host "Data agent source '$key' is already attached; reusing it."
        $Script:DataAgentSourcesAttached++
        $sourceRef = $artifactId
      }
      else {
        Warn "Data agent source '$key' was not attached: $($_.Exception.Message)"
        $Script:FabricItemWarnings = $true
        continue
      }
    }

    if (Test-DataAgentFewshotsUploadable ([string]$source.fewShotsUploadable)) {
      if ([string]::IsNullOrWhiteSpace($fewshot)) {
        Warn "Data agent source '$key' is marked fewShotsUploadable=true but has no fewShotFile."
        $Script:DataAgentFewshotStatus = 'failed'
        $Script:FabricItemWarnings = $true
      }
      elseif (-not (Test-Path -LiteralPath $fewshot -PathType Leaf)) {
        Warn "Data agent source '$key' is marked fewShotsUploadable=true but few-shot file was not found at $fewshot."
        $Script:DataAgentFewshotStatus = 'failed'
        $Script:FabricItemWarnings = $true
      }
      else {
        try {
          # upload-fewshots appends, so re-running the deployment would accumulate
          # duplicate examples on every pass. Clear first to make the upload a
          # replace, which is what an idempotent deployment needs.
          try {
            $null = Invoke-Fabio -Arguments @('data-agent', 'clear-fewshots', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--datasource', $sourceRef) -Capture
          } catch { }
          $null = Invoke-Fabio -Arguments @('data-agent', 'upload-fewshots', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--datasource', $sourceRef, '--file', $fewshot) -Capture
          Verify-DataAgentFewshots $key $sourceRef
        } catch {
          Warn "Few-shot upload for data agent source '$key' did not complete: $($_.Exception.Message)"
          $Script:DataAgentFewshotStatus = 'failed'
          $Script:FabricItemWarnings = $true
        }
      }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($fewshot)) {
      Write-Host "Skipping few-shot upload for data agent source '$key' because agent.json marks fewShotsUploadable=false."
    }

    $selected = @($source.selectedElements) -join ','
    if (-not [string]::IsNullOrWhiteSpace($selected)) {
      try {
        $null = Invoke-Fabio -Arguments @('data-agent', 'select-tables', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId, '--datasource', $sourceRef, '--elements', $selected) -Capture
      } catch {
        Warn "Data agent selected elements for source '$key' were not applied: $($_.Exception.Message)"
        $Script:FabricItemWarnings = $true
      }
    }
  }

  if ($Script:DataAgentSourcesAttached -eq 0) {
    Warn 'No data agent data sources were attached; publish was skipped.'
    $Script:FabricItemWarnings = $true
    return
  }

  try {
    $null = Invoke-Fabio -Arguments @('data-agent', 'publish', '--workspace', $Script:WorkspaceId, '--id', $Script:DataAgentId) -Capture
    $Script:DataAgentPublished = 'yes'
  } catch {
    Warn "Data agent publish did not complete: $($_.Exception.Message)"
    $Script:DataAgentPublished = 'no'
    $Script:FabricItemWarnings = $true
    return
  }

  Verify-DataAgentAct1Answer
  Invoke-DataAgentEvaluation
}

function Deploy-FabricItems {
  Deploy-Ontology
  Deploy-SemanticModel
  Deploy-DataAgent
}

function Get-ExpectedShortfallUnits {
  $code = 'const fs=require("node:fs"); const path=require("node:path"); const root=process.argv[1]; const scenario=JSON.parse(fs.readFileSync(path.join(root,"scenario.json"),"utf8")); let expected={}; const p=path.join(root,"evaluation","expected-results.json"); if (fs.existsSync(p)) expected=JSON.parse(fs.readFileSync(p,"utf8")); const value=expected.shortfallUnits ?? expected.capacityShortfallUnits ?? expected.capacity?.shortfallUnits ?? expected.capacityModel?.shortfallUnits ?? scenario.capacityModel?.expected?.shortfallUnits; if (value === undefined || value === null) process.exit(2); console.log(value);'
  $value = & node -e $code $Script:DataDir
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    return ''
  }
  return (($value | Out-String).Trim())
}

function Get-PreferredSqlCsvsForVerification {
  $dir = Join-Path $Script:Staging 'fabric-sql'
  $result = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    return @()
  }
  foreach ($name in @('regions', 'products', 'campaigns', 'launch_plans', 'decision_cases')) {
    $file = Join-Path $dir "$name.csv"
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $result.Add((Get-Item -LiteralPath $file))
      if ($result.Count -ge 3) { return @($result) }
    }
  }
  foreach ($file in Get-ChildItem -LiteralPath $dir -Filter '*.csv' -File | Sort-Object FullName) {
    if ($result.FullName -contains $file.FullName) { continue }
    $result.Add($file)
    if ($result.Count -ge 3) { return @($result) }
  }
  return @($result)
}

function Record-Check([string]$Label, [string]$Actual, [string]$Expected) {
  if ($Actual -eq $Expected) {
    Write-Host "PASS: $Label ($Actual)"
  } else {
    $actualDisplay = if ([string]::IsNullOrWhiteSpace($Actual)) { '<empty>' } else { $Actual }
    [Console]::Error.WriteLine("FAIL: $Label expected $Expected, got $actualDisplay")
    $Script:VerificationFailed = $true
  }
}

function Verify-SqlCounts {
  foreach ($csv in Get-PreferredSqlCsvsForVerification) {
    $table = [System.IO.Path]::GetFileNameWithoutExtension($csv.Name)
    if (-not (Test-Identifier $table)) { continue }
    $expected = [string](Get-CsvRowCount $csv.FullName)
    $actual = [string](Get-SqlRowCount $table)
    Record-Check "SQL table $table row count" $actual $expected
  }
}

function Verify-SqlShortfall {
  $expected = Get-ExpectedShortfallUnits
  if ([string]::IsNullOrWhiteSpace($expected)) {
    Warn "No expected shortfall value was found in expected-results.json or scenario.json."
    return
  }

  # Read the purpose-built stage view rather than guessing at a CSV column. This
  # is the same number the Act 3 demo puts on screen.
  $actual = Invoke-SqlScalar "SELECT TOP 1 shortfallUnits AS value FROM dbo.vw_capacity_conflict;"
  if ([string]::IsNullOrWhiteSpace($actual)) {
    Warn "Could not read shortfallUnits from dbo.vw_capacity_conflict; skipping shortfall assertion."
    return
  }
  Record-Check "SQL campaign shortfall value" $actual $expected
}

function Verify-KqlLineSignals {
  $dir = Join-Path $Script:Staging 'eventhouse'
  $csv = Get-FirstMatchingFile $dir '*line*signals*.csv'
  if (-not $csv) {
    $csv = Get-FirstMatchingFile $dir '*LineSignals*.csv'
  }
  if (-not $csv) {
    Warn 'No LineSignals CSV found; skipped KQL LineSignals verification.'
    return
  }
  $table = Get-KqlTableForCsv $csv.FullName $dir
  $expected = [string](Get-CsvRowCount $csv.FullName)
  $actual = [string](Invoke-KqlScalar "$table | summarize value=count()")
  Record-Check "KQL table $table row count" $actual $expected
}

function Verify-LakehouseDashboardTables {
  $dashboard = Join-Path $Script:Staging 'lakehouse/dashboard'
  if (-not (Test-Path -LiteralPath $dashboard -PathType Container)) { return }
  foreach ($csv in Get-ChildItem -LiteralPath $dashboard -Filter '*.csv' -File | Sort-Object FullName) {
    $table = 'dash_' + (ConvertTo-SnakeTableName ([System.IO.Path]::GetFileNameWithoutExtension($csv.Name)))
    if (-not (Test-Identifier $table)) { continue }
    if (Test-LakehouseTableExists $table) {
      Write-Host "PASS: Lakehouse table $table exists"
    } else {
      [Console]::Error.WriteLine("FAIL: Lakehouse table $table was not found")
      $Script:VerificationFailed = $true
    }
  }
}

function Verify-OntologyEntityTypes {
  if ($Script:OntologyStatus -eq 'skipped' -or $Script:OntologyStatus -eq 'failed' -or [string]::IsNullOrWhiteSpace($Script:OntologyId)) {
    return
  }
  try {
    # The API returns {values:[...]}, so length(@) counts object keys and always
    # reports 1. Count the array itself, falling back for any future shape change.
    $result = Invoke-Fabio -Arguments @('ontology', 'list-entity-types', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--query', 'length(values)', '--output', 'plain') -Capture
    $count = $result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($count) -or $count.Trim() -eq 'null') {
      $result = Invoke-Fabio -Arguments @('ontology', 'list-entity-types', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--query', 'length(@)', '--output', 'plain') -Capture
      $count = $result -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    }
    if (-not [string]::IsNullOrWhiteSpace($count) -and $count.Trim() -ne '0' -and $count.Trim() -ne 'null') {
      Write-Host "PASS: Ontology $($Script:OntologyName) reports $($count.Trim()) entity type(s)"
    } else {
      Warn "Ontology '$($Script:OntologyName)' exists but did not report entity types."
      $Script:FabricItemWarnings = $true
    }
  } catch {
    Warn "Ontology entity type verification did not complete: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
  }
}

function Verify-SemanticModelQuery {
  if ($Script:SemanticModelStatus -eq 'skipped' -or $Script:SemanticModelStatus -eq 'failed' -or [string]::IsNullOrWhiteSpace($Script:SemanticModelId)) {
    return
  }
  try {
    $null = Invoke-Fabio -Arguments @('semantic-model', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SemanticModelId, '--dax', 'EVALUATE ROW("ok", 1)') -Capture
    Write-Host "PASS: Semantic model $($Script:SemanticModelName) answered a trivial DAX query"
  } catch {
    Warn "Semantic model DAX verification did not complete: $($_.Exception.Message)"
    $Script:FabricItemWarnings = $true
  }

  # Direct Lake serves a framed snapshot of the Delta tables, and a framing that
  # fails to advance leaves the model quietly answering from pre-load data. That
  # is not cosmetic here: it once reported three executed governed actions while
  # the Lakehouse correctly reported none, which would contradict the
  # open-decision story the session depends on.
  try {
    $modelRows = (Invoke-Fabio -Arguments @('semantic-model', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SemanticModelId, '--dax', 'EVALUATE ROW("n", COUNTROWS(capacity_plan))', '--query', '[0]."[n]"', '--output', 'plain') -Capture) -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    $lakeRows = (Invoke-Fabio -Arguments @('lakehouse', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:LakehouseId, '--sql', 'SELECT COUNT(*) AS n FROM capacity_plan', '--query', '[0].n', '--output', 'plain') -Capture) -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1
    if (-not [string]::IsNullOrWhiteSpace($modelRows) -and $modelRows.Trim() -eq $lakeRows.Trim()) {
      Write-Host "PASS: Semantic model agrees with the Lakehouse (capacity_plan = $($modelRows.Trim()) rows)"
    }
    else {
      Warn "Semantic model is stale: capacity_plan reports $modelRows rows but the Lakehouse reports $lakeRows. Re-run 'fabio semantic-model refresh --type full'."
      $Script:FabricItemWarnings = $true
    }
  } catch {
    Warn "Semantic model staleness check did not complete: $($_.Exception.Message)"
  }
}

function Invoke-Verification {
  Write-Host 'Running post-load verification...'
  if ($Script:DryRun) {
    Write-DryRun @('fabio', 'sql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SqlDatabaseId, '--sql', 'SELECT COUNT_BIG(*) AS value FROM dbo.<table>;', '--query', '[0].value', '--output', 'plain')
    Write-DryRun @('fabio', 'kql-database', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:KqlDatabaseId, '--kql', 'LineSignals | summarize value=count()', '--query', '[0].value', '--output', 'plain')
    if (-not $Script:SkipFabricItems -and $Script:OntologyStatus -ne 'skipped' -and $Script:OntologyStatus -ne 'failed') {
      Write-DryRun @('fabio', 'ontology', 'list-entity-types', '--workspace', $Script:WorkspaceId, '--id', $Script:OntologyId, '--query', 'length(@)', '--output', 'plain')
    }
    if (-not $Script:SkipFabricItems -and $Script:SemanticModelStatus -ne 'skipped' -and $Script:SemanticModelStatus -ne 'failed') {
      Write-DryRun @('fabio', 'semantic-model', 'query', '--workspace', $Script:WorkspaceId, '--id', $Script:SemanticModelId, '--dax', 'EVALUATE ROW("ok", 1)')
    }
    return
  }
  Verify-SqlCounts
  Verify-SqlShortfall
  Verify-KqlLineSignals
  Verify-LakehouseDashboardTables
  Verify-OntologyEntityTypes
  Verify-SemanticModelQuery
  if ($Script:VerificationFailed) {
    Fail 'One or more verification checks failed.'
  }
}

function Write-Summary {
  Write-Host ''
  Write-Host 'Deployment summary'
  Write-Host "  Workspace: $($Script:WorkspaceId)"
  Write-Host "  Lakehouse: $($Script:LakehouseName) ($($Script:LakehouseId))"
  Write-Host "  Eventhouse: $($Script:EventhouseName) ($($Script:EventhouseId))"
  Write-Host "  KQL database: $($Script:KqlDatabaseName) ($($Script:KqlDatabaseId))"
  Write-Host "  SQL database: $($Script:SqlDatabaseName) ($($Script:SqlDatabaseId))"
  if ($Script:WithCosmos) {
    Write-Host "  Cosmos DB database: $($Script:CosmosDatabaseName) ($($Script:CosmosDatabaseId)) [documents loaded: $($Script:CosmosDocumentsLoaded)]"
  }
  $ontologyId = if ([string]::IsNullOrWhiteSpace($Script:OntologyId)) { '<none>' } else { $Script:OntologyId }
  $semanticModelId = if ([string]::IsNullOrWhiteSpace($Script:SemanticModelId)) { '<none>' } else { $Script:SemanticModelId }
  if (-not [string]::IsNullOrWhiteSpace($Script:OntologyEntityBindingCount) -and -not [string]::IsNullOrWhiteSpace($Script:OntologyContextualizationCount)) {
    Write-Host "  Ontology: $($Script:OntologyName) ($ontologyId) [$($Script:OntologyStatus); binding: $($Script:OntologyBindingStatus); entity_bindings: $($Script:OntologyEntityBindingCount); contextualizations: $($Script:OntologyContextualizationCount)]"
  } else {
    Write-Host "  Ontology: $($Script:OntologyName) ($ontologyId) [$($Script:OntologyStatus); binding: $($Script:OntologyBindingStatus)]"
  }
  $ontologyMcpUrl = if ([string]::IsNullOrWhiteSpace($Script:OntologyMcpUrl)) { '<none>' } else { $Script:OntologyMcpUrl }
  Write-Host "  Ontology MCP endpoint: $ontologyMcpUrl [mcp-url: $($Script:OntologyMcpUrlStatus); search: $($Script:OntologySearchStatus)]"
  Write-Host "  Semantic model: $($Script:SemanticModelName) ($semanticModelId) [$($Script:SemanticModelStatus); refresh: $($Script:SemanticModelRefreshStatus)]"
  $semanticModelConnectionId = if ([string]::IsNullOrWhiteSpace($Script:SemanticModelConnectionId)) { '<none>' } else { $Script:SemanticModelConnectionId }
  Write-Host "  Semantic model connection: $semanticModelConnectionId [$($Script:SemanticModelConnectionSource)]"
  $dataAgentId = if ([string]::IsNullOrWhiteSpace($Script:DataAgentId)) { '<none>' } else { $Script:DataAgentId }
  Write-Host "  Data agent: $($Script:DataAgentName) ($dataAgentId) [$($Script:DataAgentStatus); sources attached: $($Script:DataAgentSourcesAttached); published: $($Script:DataAgentPublished); few-shot verification: $($Script:DataAgentFewshotStatus); few-shot sources verified: $($Script:DataAgentFewshotSourcesVerified); El Nino signal: $($Script:DataAgentElNinoSignalStatus); evaluation: $($Script:DataAgentEvaluationStatus)]"
  Write-Host "  SQL rows loaded: $($Script:SqlRowsLoaded)"
  Write-Host "  Eventhouse rows loaded: $($Script:EventhouseRowsLoaded)"
  Write-Host "  Lakehouse files uploaded: $($Script:LakehouseFilesUploaded)"
  Write-Host "  Lakehouse analytics Delta tables loaded: $($Script:LakehouseAnalyticsDeltaTablesLoaded)"
  Write-Host "  Lakehouse analytics rows loaded: $($Script:LakehouseAnalyticsRowsLoaded)"
  Write-Host "  Lakehouse dashboard rows loaded: $($Script:LakehouseDashboardRowsLoaded)"
  Write-Host "  Lakehouse evidence Delta tables loaded: $($Script:LakehouseEvidenceDeltaTablesLoaded)"
  Write-Host "  Lakehouse evidence rows loaded: $($Script:LakehouseEvidenceRowsLoaded)"
  if ($Script:DryRun) {
    Write-Host '  Verification: dry-run commands printed'
  } elseif ($Script:FabricItemWarnings) {
    Write-Host '  Verification: PASS with fabric item warnings'
  } else {
    Write-Host '  Verification: PASS'
  }
  Write-Host ''
  Write-Host 'Next step:'
  if ($Script:DryRun) {
    Write-Host '  Review the workspace and item names, then run the same command without --dry-run.'
  }
  elseif ($Script:FabricItemWarnings) {
    Write-Host '  Resolve the warnings above before rehearsing the demo.'
  }
  else {
    Write-Host "  Open $($Script:DataAgentName), ask the LTG243 question, and inspect the source rows."
  }
  if ($Script:SkipFabricItems) {
    Write-Host '  Ontology, semantic model, and Data Agent deployment was skipped.'
  }
  if ($Script:WithCosmos) {
    Write-Host '  Optional shared-fixture Cosmos documents were also loaded.'
  }
}

function Main {
  Check-Prerequisites
  Invoke-LocalPrepare
  Invoke-Authentication
  Resolve-Workspace
  Resolve-Items

  if (-not $Script:VerifyOnly) {
    Check-LakehouseOverwriteProtection
    Load-FabricSql
    Load-Eventhouse
    Load-Lakehouse
    Load-LakehouseAnalytics
    Import-CosmosDocuments
    Deploy-FabricItems
  } elseif ($Script:SkipFabricItems) {
    $Script:OntologyStatus = 'skipped'
    $Script:OntologyBindingStatus = 'skipped'
    $Script:SemanticModelStatus = 'skipped'
    $Script:SemanticModelRefreshStatus = 'skipped'
  }

  Invoke-Verification
  Write-Summary
}

Main
