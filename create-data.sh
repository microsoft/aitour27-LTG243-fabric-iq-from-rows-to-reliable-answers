#!/usr/bin/env bash
#
# Deploys the shared Caldova LTG243 synthetic demo dataset into Microsoft Fabric using fabio.
#
# Usage:
#   ./create-data.sh --workspace <workspace-id-or-name> [options]
#
# Options:
#   --workspace <value>  Fabric workspace id or display name. Defaults to FABIO_WORKSPACE.
#   --capacity <value>   Fabric capacity id used only when creating a missing workspace.
#                        Defaults to FABIO_CAPACITY.
#   --prefix <value>     Item name prefix. Defaults to Caldova.
#   --staging <dir>      Uncompressed staging directory. Defaults to data/.staging.
#   --dry-run            Validate locally and print fabio commands without remote calls.
#   --skip-generate      Use committed files as-is. This is the default.
#   --regenerate         Regenerate local payload files before validation.
#   --overwrite          Allow replacing/reloading existing target data.
#   --verify-only        Only run post-load verification queries against existing items.
#   --with-cosmos        Also provision a native Cosmos DB database item in Fabric.
#   --skip-fabric-items  Skip ontology, semantic model and data agent deployment/verification.
#   --evaluate-agent     Run published data-agent evaluation questions after deployment.
#   -h, --help           Show usage.
#
# This script deploys the LTG243 dataset and demo items to Microsoft Fabric.
# Fabric SQL Database is a Fabric item. The optional --with-cosmos path belongs
# to the shared dataset and is not required for LTG243.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$ROOT_DIR/data"
ONTOLOGY_DIR="$ROOT_DIR/src/fabric/CaldovaLaunch.Ontology"
SEMANTIC_MODEL_DIR="$ROOT_DIR/src/fabric/CaldovaLaunch.SemanticModel"
DATA_AGENT_DIR="$ROOT_DIR/src/fabric/CaldovaLaunch.DataAgent"

WORKSPACE="${FABIO_WORKSPACE:-}"
CAPACITY="${FABIO_CAPACITY:-}"
PREFIX="Caldova"
STAGING_INPUT="data/.staging"
DRY_RUN=0
REGENERATE=0
OVERWRITE=0
VERIFY_ONLY=0
WITH_COSMOS=0
SKIP_FABRIC_ITEMS=0
EVALUATE_AGENT=0

WORKSPACE_ID=""
LAKEHOUSE_ID=""
EVENTHOUSE_ID=""
KQL_DATABASE_ID=""
SQL_DATABASE_ID=""
COSMOS_DATABASE_ID=""
COSMOS_DOCUMENTS_LOADED=0
COSMOS_STATUS="not requested"
ONTOLOGY_ID=""
SEMANTIC_MODEL_ID=""
SEMANTIC_MODEL_CONNECTION_ID=""
SEMANTIC_MODEL_SQL_ENDPOINT_HOST=""
ONTOLOGY_BINDINGS_OUTPUT=""
ONTOLOGY_ENTITY_BINDING_COUNT=""
ONTOLOGY_CONTEXTUALIZATION_COUNT=""
ONTOLOGY_MCP_URL=""
DATA_AGENT_ID=""
DATA_AGENT_EVALUATION_QUESTIONS=""

ONTOLOGY_STATUS="skipped"
ONTOLOGY_BINDING_STATUS="skipped"
ONTOLOGY_MCP_URL_STATUS="skipped"
ONTOLOGY_SEARCH_STATUS="skipped"
SEMANTIC_MODEL_STATUS="skipped"
SEMANTIC_MODEL_REFRESH_STATUS="skipped"
SEMANTIC_MODEL_CONNECTION_SOURCE="skipped"
DATA_AGENT_STATUS="skipped"
DATA_AGENT_SOURCES_ATTACHED=0
DATA_AGENT_PUBLISHED="no"
DATA_AGENT_EL_NINO_SIGNAL_STATUS="skipped"
DATA_AGENT_EVALUATION_STATUS="skipped"
DATA_AGENT_FEWSHOT_SOURCES_VERIFIED=0
DATA_AGENT_FEWSHOT_STATUS="skipped"

SQL_ROWS_LOADED=0
EVENTHOUSE_ROWS_LOADED=0
LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED=0
LAKEHOUSE_ANALYTICS_ROWS_LOADED=0
LAKEHOUSE_DASHBOARD_ROWS_LOADED=0
LAKEHOUSE_EVIDENCE_DELTA_TABLES_LOADED=0
LAKEHOUSE_EVIDENCE_ROWS_LOADED=0
LAKEHOUSE_FILES_UPLOADED=0
VERIFICATION_FAILED=0
FABRIC_ITEM_WARNINGS=0

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    fail "$1 requires a value."
  fi
  printf '%s' "$2"
}

absolute_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$ROOT_DIR" "$1" ;;
  esac
}

has_single_quote() {
  case "$1" in
    *"'"*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_query_safe() {
  if has_single_quote "$1"; then
    fail "$2 cannot contain a single quote because fabio item/workspace JMESPath queries use single-quoted literals."
  fi
}

is_identifier() {
  case "$1" in
    ""|[0-9]*|*[!A-Za-z0-9_]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

quote_cmd() {
  local first=1
  local arg
  while [ "$#" -gt 0 ]; do
    arg="$1"
    if [ "$first" -eq 0 ]; then
      printf ' '
    fi
    # Keep dry-run output copy-pasteable: quote only when the argument
    # actually needs it, instead of escaping every metacharacter.
    case "$arg" in
      ''|*[!A-Za-z0-9_@%+=:,./-]*)
        printf "'%s'" "$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")"
        ;;
      *)
        printf '%s' "$arg"
        ;;
    esac
    first=0
    shift
  done
}

print_dry_run() {
  printf 'DRY-RUN: '
  quote_cmd "$@"
  printf '\n'
}

run_fabio() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio "$@"
    return 0
  fi
  fabio "$@"
}

run_fabio_capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio "$@" >&2
    printf '\n'
    return 0
  fi
  fabio "$@"
}

# fabio writes a "[timing] ..." diagnostic line to stderr on every call. The
# optional capture below merges stderr so failures stay readable, which would
# otherwise let that line be read as a command result — an empty --query match
# leaves the timing line as the only captured output and it becomes the "id".
strip_fabio_noise() {
  sed -e '/^\[timing\][[:space:]]/d'
}

run_fabio_optional_capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio "$@" >&2
    printf '\n'
    return 0
  fi
  fabio "$@" 2>&1 | strip_fabio_noise
}

run_node_required() {
  node "$@"
}

print_node_dry_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run node "$@"
  fi
}

run_node_optional_for_dry_run() {
  if ! node "$@"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Local command failed during dry-run and was reported without stopping: node $(quote_cmd "$@")"
      return 0
    fi
    return 1
  fi
}

csv_row_count() {
  local file="$1"
  local lines
  if [ ! -f "$file" ]; then
    printf '0'
    return 0
  fi
  lines="$(wc -l < "$file" | tr -d '[:space:]')"
  if [ -z "$lines" ] || [ "$lines" -le 0 ]; then
    printf '0'
  else
    printf '%s' "$((lines - 1))"
  fi
}

text_line_count() {
  local file="$1"
  if [ ! -f "$file" ]; then
    printf '0'
    return 0
  fi
  wc -l < "$file" | tr -d '[:space:]'
}

normalize_name() {
  printf '%s' "$1" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]'
}

to_pascal_name() {
  printf '%s\n' "$1" | awk -F'[^[:alnum:]]+' '{
    out="";
    for (i = 1; i <= NF; i++) {
      if ($i == "") continue;
      word=tolower($i);
      out=out toupper(substr(word, 1, 1)) substr(word, 2);
    }
    print out;
  }'
}

to_snake_table_name() {
  printf '%s\n' "$1" | awk -F'[^[:alnum:]]+' '{
    out="";
    for (i = 1; i <= NF; i++) {
      if ($i == "") continue;
      part=tolower($i);
      if (out == "") out=part; else out=out "_" part;
    }
    if (out ~ /^[0-9]/) out="t_" out;
    print out;
  }'
}

parse_kql_tables() {
  local schema="$1"
  if [ ! -f "$schema" ]; then
    return 0
  fi
  sed -nE 's/.*\.create(-or-alter|-merge)?[[:space:]]+table[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*/\2/p' "$schema" | sort -u
}

# Concatenates every KQL table-definition script so table discovery covers the
# weather scripts as well as the base ones, without hardcoding filenames.
kql_table_definition_files() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f -name '*.kql' -print | sort | while IFS= read -r f; do
    case "$(basename "$f")" in
      *mapping*|*stage_quer*|*queries*) : ;;
      *) printf '%s\n' "$f" ;;
    esac
  done
}

parse_all_kql_tables() {
  local dir="$1"
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    parse_kql_tables "$f"
  done < <(kql_table_definition_files "$dir") | sort -u
}

kql_table_for_csv() {
  local csv="$1"
  local defs_dir="$2"
  local base
  local target_norm
  local pascal
  local pascal_norm
  local table
  local table_norm
  base="$(basename "$csv" .csv)"
  target_norm="$(normalize_name "$base")"
  pascal="$(to_pascal_name "$base")"
  pascal_norm="$(normalize_name "$pascal")"

  while IFS= read -r table; do
    [ -n "$table" ] || continue
    table_norm="$(normalize_name "$table")"
    if [ "$table_norm" = "$target_norm" ] || [ "$table_norm" = "$pascal_norm" ]; then
      printf '%s' "$table"
      return 0
    fi
  done < <(parse_all_kql_tables "$defs_dir")

  warn "Could not find a KQL table mapping for $(basename "$csv"); using derived table name $pascal."
  printf '%s' "$pascal"
}

find_first_matching_file() {
  local dir="$1"
  local pattern="$2"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  find "$dir" -type f -name "$pattern" | sort | sed -n '1p'
}

next_arg() {
  if [ "$#" -lt 2 ]; then
    fail "$1 requires a value."
  fi
  printf '%s' "$2"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace)
      WORKSPACE="$(next_arg "$@")"
      shift 2
      ;;
    --capacity)
      CAPACITY="$(next_arg "$@")"
      shift 2
      ;;
    --prefix)
      PREFIX="$(next_arg "$@")"
      shift 2
      ;;
    --staging)
      STAGING_INPUT="$(next_arg "$@")"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-generate)
      REGENERATE=0
      shift
      ;;
    --regenerate)
      REGENERATE=1
      shift
      ;;
    --overwrite)
      OVERWRITE=1
      shift
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --with-cosmos)
      WITH_COSMOS=1
      shift
      ;;
    --skip-fabric-items)
      SKIP_FABRIC_ITEMS=1
      shift
      ;;
    --evaluate-agent)
      EVALUATE_AGENT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

STAGING="$(absolute_path "$STAGING_INPUT")"

[ -n "$WORKSPACE" ] || fail "--workspace or FABIO_WORKSPACE is required."
ensure_query_safe "$WORKSPACE" "Workspace"
ensure_query_safe "$PREFIX" "Prefix"

LAKEHOUSE_NAME="${PREFIX}Analytics"
EVENTHOUSE_NAME="${PREFIX}Signals"
KQL_DATABASE_NAME="${PREFIX}Signals"
SQL_DATABASE_NAME="${PREFIX}Operations"
COSMOS_DATABASE_NAME="${PREFIX}DecisionMemory"
ONTOLOGY_NAME="${PREFIX}BusinessMeaning"
SEMANTIC_MODEL_NAME="${PREFIX}LaunchModel"
DATA_AGENT_NAME="${PREFIX}Analyst"

check_prerequisites() {
  local node_version
  local node_major
  local fabio_version

  command -v node >/dev/null 2>&1 || fail "node is required. Install Node.js 24 or later and retry."
  node_version="$(node --version)"
  node_major="$(printf '%s' "$node_version" | sed 's/^v//; s/\..*$//')"
  case "$node_major" in
    ''|*[!0-9]*)
      fail "Could not parse node version: $node_version"
      ;;
  esac
  if [ "$node_major" -lt 24 ]; then
    fail "Node.js 24 or later is required; found $node_version."
  fi

  command -v fabio >/dev/null 2>&1 || fail "fabio is required. Install fabio 0.70.0+ (0.71.0+ for Cosmos DB documents) and ensure it is on PATH."
  fabio_version="$(fabio --version)"

  info "node: $node_version"
  info "fabio: $fabio_version"
}

local_prepare() {
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    info "Verify-only mode: skipping generation and load; expanding payloads for expected verification counts."
    if ! node "$DATA_DIR/tools/expand.ts" --out "$STAGING" --clean; then
      return 1
    fi
    return 0
  fi

  if [ "$REGENERATE" -eq 1 ]; then
    info "Regenerating local payload files..."
    run_node_required "$DATA_DIR/tools/generate.ts"
  else
    info "Using committed payload files as-is (default)."
  fi

  info "Checking data manifest..."
  if [ -f "$DATA_DIR/manifest.json" ]; then
    run_node_optional_for_dry_run "$DATA_DIR/tools/manifest.ts" --check
  elif [ "$DRY_RUN" -eq 1 ]; then
    warn "data/manifest.json is absent; continuing dry-run because the payload set may still be generated by another process."
  else
    fail "data/manifest.json is missing. Run: node data/tools/manifest.ts"
  fi

  if [ -f "$DATA_DIR/tools/validate.ts" ]; then
    info "Validating scenario payloads..."
    run_node_optional_for_dry_run "$DATA_DIR/tools/validate.ts"
  else
    warn "data/tools/validate.ts is absent; continuing without validator."
  fi

  info "Expanding payloads into $STAGING ..."
  if ! node "$DATA_DIR/tools/expand.ts" --out "$STAGING" --clean; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Payload expansion failed during dry-run; continuing so planned fabio commands can still be reviewed."
    else
      return 1
    fi
  fi
}

authenticate() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio auth status
    info "Dry-run mode: no remote fabio calls are executed; ids below are placeholders."
    return 0
  fi

  if ! fabio auth status >/dev/null 2>&1; then
    printf 'ERROR: fabio is not authenticated. Run this command, then retry:\n  fabio auth login\n' >&2
    exit 1
  fi
}

resolve_workspace() {
  local resolved
  local query

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio workspace show --id "$WORKSPACE" --query id --output plain
    query="[?displayName=='$WORKSPACE'].id | [0]"
    print_dry_run fabio workspace list --all --query "$query" --output plain
    if [ -n "$CAPACITY" ]; then
      print_dry_run fabio workspace create --name "$WORKSPACE" --capacity-id "$CAPACITY" --query id --output plain
    else
      print_dry_run fabio workspace create --name "$WORKSPACE" --query id --output plain
    fi
    WORKSPACE_ID="<workspace-id>"
    return 0
  fi

  if resolved="$(fabio workspace show --id "$WORKSPACE" --query id --output plain 2>/dev/null)"; then
    resolved="$(printf '%s' "$resolved" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -n "$resolved" ] && [ "$resolved" != "null" ]; then
      WORKSPACE_ID="$resolved"
      info "Resolved workspace id: $WORKSPACE_ID"
      return 0
    fi
  fi

  query="[?displayName=='$WORKSPACE'].id | [0]"
  resolved="$(fabio workspace list --all --query "$query" --output plain)"
  resolved="$(printf '%s' "$resolved" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  if [ -n "$resolved" ] && [ "$resolved" != "null" ]; then
    WORKSPACE_ID="$resolved"
    info "Resolved workspace '$WORKSPACE' to id: $WORKSPACE_ID"
    return 0
  fi

  info "Workspace '$WORKSPACE' was not found; creating it."
  if [ -n "$CAPACITY" ]; then
    WORKSPACE_ID="$(fabio workspace create --name "$WORKSPACE" --capacity-id "$CAPACITY" --query id --output plain)"
  else
    WORKSPACE_ID="$(fabio workspace create --name "$WORKSPACE" --query id --output plain)"
  fi
  WORKSPACE_ID="$(printf '%s' "$WORKSPACE_ID" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  [ -n "$WORKSPACE_ID" ] && [ "$WORKSPACE_ID" != "null" ] || fail "fabio workspace create did not return a workspace id."
  info "Created workspace id: $WORKSPACE_ID"
}

resolve_or_create_item() {
  local type="$1"
  local name="$2"
  local group="$3"
  local extra_flag="${4:-}"
  local extra_value="${5:-}"
  local query
  local id

  ensure_query_safe "$name" "$type item name"
  query="[?displayName=='$name'].id | [0]"

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio item list --workspace "$WORKSPACE_ID" --type "$type" --query "$query" --output plain >&2
    if [ "$VERIFY_ONLY" -eq 0 ]; then
      if [ -n "$extra_flag" ]; then
        print_dry_run fabio "$group" create --workspace "$WORKSPACE_ID" --name "$name" "$extra_flag" "$extra_value" --query id --output plain >&2
      else
        print_dry_run fabio "$group" create --workspace "$WORKSPACE_ID" --name "$name" --query id --output plain >&2
      fi
    fi
    printf '<%s-id>' "$name"
    return 0
  fi

  id="$(fabio item list --workspace "$WORKSPACE_ID" --type "$type" --query "$query" --output plain)"
  id="$(printf '%s' "$id" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  if [ -n "$id" ] && [ "$id" != "null" ]; then
    info "Resolved $type '$name': $id" >&2
    printf '%s' "$id"
    return 0
  fi

  if [ "$VERIFY_ONLY" -eq 1 ]; then
    fail "Verify-only mode requires existing $type item '$name'."
  fi

  info "Creating $type '$name'." >&2
  if [ -n "$extra_flag" ]; then
    id="$(fabio "$group" create --workspace "$WORKSPACE_ID" --name "$name" "$extra_flag" "$extra_value" --query id --output plain)"
  else
    id="$(fabio "$group" create --workspace "$WORKSPACE_ID" --name "$name" --query id --output plain)"
  fi
  id="$(printf '%s' "$id" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  [ -n "$id" ] && [ "$id" != "null" ] || fail "fabio $group create did not return an id for '$name'."
  printf '%s' "$id"
}

# fabio 0.71.0 added a Cosmos DB for NoSQL data plane, so decision-case documents
# can now be loaded directly rather than only staged in the Lakehouse. Every
# document carries an `id` because Cosmos requires one.
load_cosmos_documents() {
  local dir="$STAGING/lakehouse/decision-cases"
  local cases="$dir/decision-cases.jsonl"
  local timeline="$dir/decision-case-timeline.jsonl"

  [ "$WITH_COSMOS" -eq 1 ] || return 0
  [ -n "$COSMOS_DATABASE_ID" ] || return 0

  if [ ! -f "$cases" ]; then
    warn "No decision-case documents found at $cases; skipping Cosmos DB import."
    return 0
  fi

  info "Loading Cosmos DB containers and documents."

  if ! run_fabio cosmos-db-database create-container --workspace "$WORKSPACE_ID" --id "$COSMOS_DATABASE_ID" --container decision-cases --partition-key /caseId >/dev/null 2>&1; then
    warn "Cosmos container 'decision-cases' may already exist; continuing."
  fi
  if run_fabio cosmos-db-database import --workspace "$WORKSPACE_ID" --id "$COSMOS_DATABASE_ID" --container decision-cases --source "$cases"; then
    COSMOS_DOCUMENTS_LOADED="$((COSMOS_DOCUMENTS_LOADED + $(wc -l < "$cases" | tr -d ' ')))"
  else
    warn "Cosmos DB import of decision cases did not complete."
    COSMOS_STATUS="import failed"
  fi

  if [ -f "$timeline" ]; then
    if ! run_fabio cosmos-db-database create-container --workspace "$WORKSPACE_ID" --id "$COSMOS_DATABASE_ID" --container decision-timeline --partition-key /caseId >/dev/null 2>&1; then
      warn "Cosmos container 'decision-timeline' may already exist; continuing."
    fi
    if run_fabio cosmos-db-database import --workspace "$WORKSPACE_ID" --id "$COSMOS_DATABASE_ID" --container decision-timeline --source "$timeline"; then
      COSMOS_DOCUMENTS_LOADED="$((COSMOS_DOCUMENTS_LOADED + $(wc -l < "$timeline" | tr -d ' ')))"
    else
      warn "Cosmos DB import of the decision timeline did not complete."
      COSMOS_STATUS="import failed"
    fi
  fi
}

resolve_items() {
  LAKEHOUSE_ID="$(resolve_or_create_item Lakehouse "$LAKEHOUSE_NAME" lakehouse)"
  EVENTHOUSE_ID="$(resolve_or_create_item Eventhouse "$EVENTHOUSE_NAME" eventhouse)"
  KQL_DATABASE_ID="$(resolve_or_create_item KQLDatabase "$KQL_DATABASE_NAME" kql-database --eventhouse-id "$EVENTHOUSE_ID")"
  SQL_DATABASE_ID="$(resolve_or_create_item SQLDatabase "$SQL_DATABASE_NAME" sql-database)"
  if [ "$WITH_COSMOS" -eq 1 ]; then
    # Cosmos DB in Fabric is a native, writable NoSQL database item. From fabio
    # 0.71.0 the Cosmos data plane also creates containers and imports the
    # decision-case documents; see load_cosmos_documents below.
    COSMOS_DATABASE_ID="$(resolve_or_create_item CosmosDbDatabase "$COSMOS_DATABASE_NAME" cosmos-db-database)"
  fi
}

sql_scalar() {
  local sql="$1"
  run_fabio_capture sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "$sql" --query '[0].value' --output plain | tr -d '\r' | sed '/^$/d' | sed -n '1p'
}

sql_row_count() {
  local table="$1"
  sql_scalar "SELECT COALESCE(SUM(row_count), 0) AS value FROM sys.dm_db_partition_stats WHERE object_id = OBJECT_ID(N'dbo.$table') AND index_id IN (0, 1);"
}

kql_scalar() {
  local kql="$1"
  run_fabio_capture kql-database query --workspace "$WORKSPACE_ID" --id "$KQL_DATABASE_ID" --kql "$kql" --query '[0].value' --output plain | tr -d '\r' | sed '/^$/d' | sed -n '1p'
}

lakehouse_table_exists() {
  local table="$1"
  local query
  local result
  query="[?name=='$table' || displayName=='$table'].name | [0]"
  result="$(run_fabio_capture lakehouse list-tables --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --query "$query" --output plain | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  [ -n "$result" ] && [ "$result" != "null" ]
}

check_lakehouse_table_overwrite() {
  local table="$1"
  local source="$2"
  local file_name="$3"
  if ! is_identifier "$table"; then
    warn "Skipping lakehouse table existence check for unsafe $source table name from file: $file_name"
    return 0
  fi
  if lakehouse_table_exists "$table" && [ "$OVERWRITE" -eq 0 ]; then
    fail "Lakehouse table '$table' already exists. Re-run with --overwrite to replace/reload $source tables."
  fi
}

check_sql_overwrite_protection() {
  local dir="$STAGING/fabric-sql"
  local csv
  local table
  local existing
  [ -d "$dir" ] || return 0

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(basename "$csv" .csv)"
    if ! is_identifier "$table"; then
      warn "Skipping overwrite check for SQL CSV with unsafe table name: $(basename "$csv")"
      continue
    fi
    existing="$(sql_row_count "$table")"
    existing="${existing:-0}"
    if [ "$existing" -gt 0 ] && [ "$OVERWRITE" -eq 0 ]; then
      fail "SQL table '$table' already contains $existing row(s). Re-run with --overwrite to replace/reload data."
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

truncate_sql_tables_for_overwrite() {
  local dir="$STAGING/fabric-sql"
  local csv
  local table
  [ "$OVERWRITE" -eq 1 ] || return 0
  [ -d "$dir" ] || return 0

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(basename "$csv" .csv)"
    if is_identifier "$table"; then
      run_fabio sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "IF OBJECT_ID(N'dbo.$table', N'U') IS NOT NULL DELETE FROM dbo.[$table];"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

# Foreign keys are disabled around the whole SQL load because both the DELETE
# step and the CSV import run in alphabetical file order, not dependency order.
# They are re-enabled WITH CHECK afterwards, which re-validates every row and so
# still proves referential integrity.
set_sql_foreign_keys() {
  local mode="$1"
  local clause
  if [ "$mode" = "disable" ]; then
    clause="NOCHECK CONSTRAINT ALL"
  else
    clause="WITH CHECK CHECK CONSTRAINT ALL"
  fi
  run_fabio sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "DECLARE @sql nvarchar(max) = N''; SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name) + N' $clause; ' FROM sys.tables AS t WHERE t.is_ms_shipped = 0; EXEC sp_executesql @sql;"
}

# T-SQL requires CREATE VIEW to be the first statement in its batch, and fabio has
# no GO-batch support, so scripts are split on lines containing only GO and each
# batch is sent as a separate query.
apply_sql_script() {
  local script="$1"
  local batch_dir
  local batch
  local count

  if ! grep -qiE '^[[:space:]]*GO[[:space:]]*$' "$script"; then
    run_fabio sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "@$script"
    return 0
  fi

  batch_dir="$(mktemp -d)"
  awk -v dir="$batch_dir" '
    BEGIN { n = 1; out = sprintf("%s/batch_%03d.sql", dir, n) }
    /^[[:space:]]*[Gg][Oo][[:space:]]*$/ { close(out); n++; out = sprintf("%s/batch_%03d.sql", dir, n); next }
    { print >> out }
  ' "$script"

  count=0
  for batch in "$batch_dir"/batch_*.sql; do
    [ -f "$batch" ] || continue
    if grep -qE '[^[:space:]]' "$batch"; then
      run_fabio sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "@$batch"
      count=$((count + 1))
    fi
  done
  rm -rf "$batch_dir"
  info "  applied $count batch(es) from $(basename "$script")."
}

load_fabric_sql() {
  local dir="$STAGING/fabric-sql"
  local script
  local csv
  local table
  local rows

  if [ ! -d "$dir" ]; then
    warn "No Fabric SQL payload directory found at $dir; skipping SQL Database load."
    return 0
  fi

  check_sql_overwrite_protection

  # Run every numbered SQL script in order: schema first, then views, including
  # the weather scripts. Discovered rather than hardcoded so new scripts are picked up.
  if [ -z "$(find "$dir" -maxdepth 1 -type f -name '*.sql' -print -quit)" ]; then
    warn "No SQL scripts found in $dir; schema and views were not applied."
  else
    while IFS= read -r script; do
      [ -n "$script" ] || continue
      info "Applying $(basename "$script")."
      apply_sql_script "$script"
    done < <(find "$dir" -maxdepth 1 -type f -name '*.sql' -print | sort)
  fi

  info "Disabling foreign keys for the load."
  set_sql_foreign_keys disable

  truncate_sql_tables_for_overwrite

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(basename "$csv" .csv)"
    if ! is_identifier "$table"; then
      fail "Unsafe SQL table name derived from file $(basename "$csv"): $table"
    fi
    rows="$(csv_row_count "$csv")"
    run_fabio sql-database import --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --file "$csv" --table "$table" --no-create-table
    SQL_ROWS_LOADED="$((SQL_ROWS_LOADED + rows))"
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)

  info "Re-enabling and revalidating foreign keys."
  set_sql_foreign_keys enable
}

check_eventhouse_overwrite_protection() {
  local dir="$STAGING/eventhouse"
  local csv
  local table
  local existing
  [ -d "$dir" ] || return 0

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(kql_table_for_csv "$csv" "$dir")"
    if ! is_identifier "$table"; then
      warn "Skipping overwrite check for eventhouse CSV with unsafe table name: $(basename "$csv")"
      continue
    fi
    existing="$(kql_scalar "$table | summarize value=count()")"
    existing="${existing:-0}"
    if [ "$existing" -gt 0 ] && [ "$OVERWRITE" -eq 0 ]; then
      fail "KQL table '$table' already contains $existing row(s). Re-run with --overwrite to replace/reload data."
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

clear_eventhouse_tables_for_overwrite() {
  local dir="$STAGING/eventhouse"
  local csv
  local table
  [ "$OVERWRITE" -eq 1 ] || return 0
  [ -d "$dir" ] || return 0

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(kql_table_for_csv "$csv" "$dir")"
    if is_identifier "$table"; then
      run_fabio kql-database query --workspace "$WORKSPACE_ID" --id "$KQL_DATABASE_ID" --kql ".clear table $table data"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

# Kusto executes one control command per request, so KQL scripts are split into
# individual commands. A new command starts at a line beginning with a dot;
# following lines are treated as continuations of it.
apply_kql_script() {
  local script="$1"
  local cmd_dir
  local cmd
  local count

  cmd_dir="$(mktemp -d)"
  awk -v dir="$cmd_dir" '
    /^[[:space:]]*\/\// { next }
    /^[[:space:]]*\./ { n++; out = sprintf("%s/cmd_%03d.kql", dir, n) }
    { if (n > 0) print >> out }
  ' "$script"

  count=0
  for cmd in "$cmd_dir"/cmd_*.kql; do
    [ -f "$cmd" ] || continue
    if grep -qE '[^[:space:]]' "$cmd"; then
      run_fabio kql-database query --workspace "$WORKSPACE_ID" --id "$KQL_DATABASE_ID" --kql "@$cmd"
      count=$((count + 1))
    fi
  done
  rm -rf "$cmd_dir"
  info "  applied $count command(s) from $(basename "$script")."
}

load_eventhouse() {
  local dir="$STAGING/eventhouse"
  local script
  local csv
  local table
  local rows
  local file_name

  if [ ! -d "$dir" ]; then
    warn "No Eventhouse payload directory found at $dir; skipping Eventhouse load."
    return 0
  fi

  # Run every numbered KQL script in order except the stage-query files, which are
  # presenter references rather than deployment steps.
  if [ -z "$(find "$dir" -maxdepth 1 -type f -name '*.kql' -print -quit)" ]; then
    warn "No KQL scripts found in $dir; tables and mappings were not created."
  else
    while IFS= read -r script; do
      [ -n "$script" ] || continue
      case "$(basename "$script")" in
        *stage_quer*|*queries*) continue ;;
      esac
      info "Applying $(basename "$script")."
      apply_kql_script "$script"
    done < <(find "$dir" -maxdepth 1 -type f -name '*.kql' -print | sort)
  fi

  check_eventhouse_overwrite_protection
  clear_eventhouse_tables_for_overwrite

  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(kql_table_for_csv "$csv" "$dir")"
    if ! is_identifier "$table"; then
      fail "Unsafe KQL table name derived for file $(basename "$csv"): $table"
    fi
    rows="$(csv_row_count "$csv")"
    file_name="$(basename "$csv")"
    run_fabio lakehouse upload --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "$csv" --dest-path "Files/eventhouse/$(basename "$csv")"
    run_fabio kql-database ingest --workspace "$WORKSPACE_ID" --id "$KQL_DATABASE_ID" --table "$table" --source-lakehouse "$LAKEHOUSE_ID" --source-path "Files/eventhouse/$file_name" --format Csv --ignore-first-record
    EVENTHOUSE_ROWS_LOADED="$((EVENTHOUSE_ROWS_LOADED + rows))"
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

upload_lakehouse_file() {
  local file="$1"
  local base_dir="$2"
  local prefix="$3"
  local rel
  local rel_dir
  local dest

  rel="${file#$base_dir/}"
  rel_dir="$(dirname "$rel")"
  if [ "$rel_dir" = "." ]; then
    dest="Files/$prefix"
  else
    dest="Files/$prefix/$rel_dir"
  fi
  run_fabio lakehouse upload --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "$file" --dest-path "$dest/$(basename "$file")"
  LAKEHOUSE_FILES_UPLOADED="$((LAKEHOUSE_FILES_UPLOADED + 1))"
}

check_lakehouse_overwrite_protection() {
  local dashboard="$STAGING/lakehouse/dashboard"
  local evidence="$STAGING/lakehouse/evidence"
  local fabric_sql="$STAGING/fabric-sql"
  local eventhouse="$STAGING/eventhouse"
  local csv
  local table

  if [ -d "$dashboard" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="dash_$(to_snake_table_name "$(basename "$csv" .csv)")"
      check_lakehouse_table_overwrite "$table" dashboard "$(basename "$csv")"
    done < <(find "$dashboard" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi

  if [ -d "$evidence" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(basename "$csv" .csv)"
      check_lakehouse_table_overwrite "$table" evidence "$(basename "$csv")"
    done < <(find "$evidence" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi

  if [ -d "$fabric_sql" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(basename "$csv" .csv)"
      check_lakehouse_table_overwrite "$table" analytics "$(basename "$csv")"
    done < <(find "$fabric_sql" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi

  if [ -d "$eventhouse" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(kql_table_for_csv "$csv" "$eventhouse")"
      check_lakehouse_table_overwrite "$table" analytics "$(basename "$csv")"
    done < <(find "$eventhouse" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi
}

load_lakehouse() {
  local lakehouse="$STAGING/lakehouse"
  local evaluation="$STAGING/evaluation"
  local receipts="$STAGING/receipts"
  local dashboard="$lakehouse/dashboard"
  local evidence="$lakehouse/evidence"
  local file
  local csv
  local table
  local rows
  local file_name

  if [ -d "$lakehouse" ]; then
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      upload_lakehouse_file "$file" "$lakehouse" lakehouse
    done < <(find "$lakehouse" -type f -print | sort)
  else
    warn "No Lakehouse payload directory found at $lakehouse; skipping lakehouse file uploads."
  fi

  if [ -d "$evaluation" ]; then
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      upload_lakehouse_file "$file" "$evaluation" evaluation
    done < <(find "$evaluation" -type f -print | sort)
  else
    warn "No evaluation payload directory found at $evaluation; skipping evaluation uploads."
  fi

  if [ -d "$receipts" ]; then
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      upload_lakehouse_file "$file" "$receipts" receipts
    done < <(find "$receipts" -type f -print | sort)
  else
    warn "No receipts payload directory found at $receipts; skipping receipt uploads."
  fi

  if [ -d "$dashboard" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      # Dashboard CSVs are presentation extracts and are prefixed so they cannot
      # collide with a relational table of the same name.
      table="dash_$(to_snake_table_name "$(basename "$csv" .csv)")"
      if ! is_identifier "$table"; then
        fail "Unsafe Lakehouse table name derived from file $(basename "$csv"): $table"
      fi
      rows="$(csv_row_count "$csv")"
      file_name="$(basename "$csv")"
      run_fabio lakehouse load-table --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "Files/lakehouse/dashboard/$file_name" --table "$table" --mode Overwrite --format Csv
      LAKEHOUSE_DASHBOARD_ROWS_LOADED="$((LAKEHOUSE_DASHBOARD_ROWS_LOADED + rows))"
    done < <(find "$dashboard" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi

  if [ -d "$evidence" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(basename "$csv" .csv)"
      if ! is_identifier "$table"; then
        fail "Unsafe Lakehouse evidence table name derived from file $(basename "$csv"): $table"
      fi
      rows="$(csv_row_count "$csv")"
      file_name="$(basename "$csv")"
      run_fabio lakehouse load-table --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "Files/lakehouse/evidence/$file_name" --table "$table" --mode Overwrite --format Csv
      LAKEHOUSE_EVIDENCE_DELTA_TABLES_LOADED="$((LAKEHOUSE_EVIDENCE_DELTA_TABLES_LOADED + 1))"
      LAKEHOUSE_EVIDENCE_ROWS_LOADED="$((LAKEHOUSE_EVIDENCE_ROWS_LOADED + rows))"
      LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED="$((LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED + 1))"
      LAKEHOUSE_ANALYTICS_ROWS_LOADED="$((LAKEHOUSE_ANALYTICS_ROWS_LOADED + rows))"
    done < <(find "$evidence" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi
}

load_lakehouse_analytics() {
  local fabric_sql="$STAGING/fabric-sql"
  local eventhouse="$STAGING/eventhouse"
  local csv
  local table
  local rows
  local file_name

  if [ -d "$fabric_sql" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(basename "$csv" .csv)"
      if ! is_identifier "$table"; then
        fail "Unsafe Lakehouse analytics table name derived from file $(basename "$csv"): $table"
      fi
      rows="$(csv_row_count "$csv")"
      file_name="$(basename "$csv")"
      run_fabio lakehouse upload --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "$csv" --dest-path "Files/analytics/fabric-sql/$(basename "$csv")"
      run_fabio lakehouse load-table --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "Files/analytics/fabric-sql/$file_name" --table "$table" --mode Overwrite --format Csv
      LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED="$((LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED + 1))"
      LAKEHOUSE_ANALYTICS_ROWS_LOADED="$((LAKEHOUSE_ANALYTICS_ROWS_LOADED + rows))"
    done < <(find "$fabric_sql" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi

  if [ -d "$eventhouse" ]; then
    while IFS= read -r csv; do
      [ -n "$csv" ] || continue
      table="$(kql_table_for_csv "$csv" "$eventhouse")"
      if ! is_identifier "$table"; then
        fail "Unsafe Lakehouse analytics table name derived for Eventhouse file $(basename "$csv"): $table"
      fi
      rows="$(csv_row_count "$csv")"
      file_name="$(basename "$csv")"
      run_fabio lakehouse load-table --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --source-path "Files/eventhouse/$file_name" --table "$table" --mode Overwrite --format Csv
      LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED="$((LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED + 1))"
      LAKEHOUSE_ANALYTICS_ROWS_LOADED="$((LAKEHOUSE_ANALYTICS_ROWS_LOADED + rows))"
    done < <(find "$eventhouse" -maxdepth 1 -type f -name '*.csv' -print | sort)
  fi
}

resolve_existing_optional_item() {
  local type="$1"
  local name="$2"
  local query
  local output
  local id

  ensure_query_safe "$name" "$type item name"
  query="[?displayName=='$name'].id | [0]"

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio item list --workspace "$WORKSPACE_ID" --type "$type" --query "$query" --output plain >&2
    return 1
  fi

  if ! output="$(run_fabio_optional_capture item list --workspace "$WORKSPACE_ID" --type "$type" --query "$query" --output plain)"; then
    warn "Could not resolve $type '$name': $output"
    FABRIC_ITEM_WARNINGS=1
    return 2
  fi

  id="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  if [ -n "$id" ] && [ "$id" != "null" ]; then
    printf '%s' "$id"
    return 0
  fi
  return 1
}

extract_eventhouse_query_uri() {
  node -e "
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const start = input.indexOf('{');
const end = input.lastIndexOf('}');
if (start < 0 || end < start) process.exit(1);
const payload = JSON.parse(input.slice(start, end + 1));
const root = payload && payload.data ? payload.data : payload;
const uri = root && root.properties && root.properties.queryServiceUri;
if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) process.exit(1);
console.log(uri);
"
}

eventhouse_query_uri() {
  local output
  local uri
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio eventhouse show --workspace "$WORKSPACE_ID" --id "$EVENTHOUSE_ID" --output json >&2
    printf '<eventhouse-query-uri>'
    return 0
  fi

  if ! output="$(run_fabio_optional_capture eventhouse show --workspace "$WORKSPACE_ID" --id "$EVENTHOUSE_ID" --output json)"; then
    warn "Could not read Eventhouse details for ontology binding: $output"
    FABRIC_ITEM_WARNINGS=1
    return 1
  fi
  if ! uri="$(printf '%s' "$output" | extract_eventhouse_query_uri)"; then
    warn "Could not find an Eventhouse query URI in fabio eventhouse show output; ontology Eventhouse binding was skipped."
    FABRIC_ITEM_WARNINGS=1
    return 1
  fi
  printf '%s' "$uri"
}

record_ontology_binding_counts() {
  local bindings="$1"
  local counts
  [ -f "$bindings" ] || return 0
  counts="$(node -e "
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
function objectCount(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : '';
}
console.log(objectCount(payload.entities) + '\t' + objectCount(payload.relationships));
" "$bindings" 2>/dev/null || true)"
  ONTOLOGY_ENTITY_BINDING_COUNT="$(printf '%s' "$counts" | awk 'BEGIN { FS="\t" } NR == 1 { print $1 }')"
  ONTOLOGY_CONTEXTUALIZATION_COUNT="$(printf '%s' "$counts" | awk 'BEGIN { FS="\t" } NR == 1 { print $2 }')"
}

prepare_ontology_bindings() {
  local cluster_uri
  local output

  info "Checking ontology definition compatibility..."
  print_node_dry_run "$DATA_DIR/tools/build-ontology.ts" --check
  if ! run_node_required "$DATA_DIR/tools/build-ontology.ts" --check; then
    fail "Ontology compatibility check failed. Fix unsupported valueTypes or binding map errors before deploying."
  fi

  ONTOLOGY_BINDINGS_OUTPUT="$STAGING/fabric-items/ontology-bindings.json"
  if ! cluster_uri="$(eventhouse_query_uri)"; then
    warn "Ontology deploy-ready binding map was not generated because the Eventhouse query URI could not be discovered."
    FABRIC_ITEM_WARNINGS=1
    return 1
  fi

  info "Generating ontology binding map."
  print_node_dry_run "$DATA_DIR/tools/build-ontology.ts" --bindings-output "$ONTOLOGY_BINDINGS_OUTPUT" --eventhouse "$EVENTHOUSE_ID" --cluster-uri "$cluster_uri" --database "$KQL_DATABASE_NAME"
  if output="$(node "$DATA_DIR/tools/build-ontology.ts" --bindings-output "$ONTOLOGY_BINDINGS_OUTPUT" --eventhouse "$EVENTHOUSE_ID" --cluster-uri "$cluster_uri" --database "$KQL_DATABASE_NAME" 2>&1)"; then
    printf '%s\n' "$output"
    record_ontology_binding_counts "$ONTOLOGY_BINDINGS_OUTPUT"
    return 0
  fi

  warn "Ontology binding map generation failed and may need finishing in the Fabric portal: $output"
  FABRIC_ITEM_WARNINGS=1
  return 1
}

bind_ontology() {
  local output
  if [ -z "$ONTOLOGY_BINDINGS_OUTPUT" ] || [ ! -f "$ONTOLOGY_BINDINGS_OUTPUT" ]; then
    warn "Ontology binding map was not available; ontology binding was skipped."
    ONTOLOGY_BINDING_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi

  if output="$(run_fabio_optional_capture ontology bind --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --lakehouse "$LAKEHOUSE_ID" --bindings "$ONTOLOGY_BINDINGS_OUTPUT")"; then
    ONTOLOGY_BINDING_STATUS="bound"
  else
    warn "Ontology binding did not complete and may need finishing in the Fabric portal: $output"
    ONTOLOGY_BINDING_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

deploy_ontology() {
  local id
  local rc
  local output
  local bindings_ready=0

  if [ "$SKIP_FABRIC_ITEMS" -eq 1 ]; then
    ONTOLOGY_STATUS="skipped"
    ONTOLOGY_BINDING_STATUS="skipped"
    return 0
  fi
  if [ ! -d "$ONTOLOGY_DIR" ]; then
    warn "Ontology source directory was not found at $ONTOLOGY_DIR; skipping ontology deployment."
    ONTOLOGY_STATUS="skipped"
    ONTOLOGY_BINDING_STATUS="skipped"
    return 0
  fi

  if prepare_ontology_bindings; then
    bindings_ready=1
  else
    ONTOLOGY_BINDING_STATUS="failed"
  fi

  rc=0
  id="$(resolve_existing_optional_item Ontology "$ONTOLOGY_NAME")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    ONTOLOGY_ID="$id"
    ONTOLOGY_STATUS="resolved"
    info "Resolved Ontology '$ONTOLOGY_NAME': $ONTOLOGY_ID"
  elif [ "$rc" -eq 2 ]; then
    ONTOLOGY_STATUS="failed"
    ONTOLOGY_BINDING_STATUS="failed"
    return 0
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      run_fabio_optional_capture ontology create --workspace "$WORKSPACE_ID" --name "$ONTOLOGY_NAME" --dir "$ONTOLOGY_DIR" --query id --output plain >/dev/null
      ONTOLOGY_ID="<$ONTOLOGY_NAME-id>"
      ONTOLOGY_STATUS="created"
    elif output="$(run_fabio_optional_capture ontology create --workspace "$WORKSPACE_ID" --name "$ONTOLOGY_NAME" --dir "$ONTOLOGY_DIR" --query id --output plain)"; then
      ONTOLOGY_ID="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
      if [ -n "$ONTOLOGY_ID" ] && [ "$ONTOLOGY_ID" != "null" ]; then
        ONTOLOGY_STATUS="created"
      else
        warn "fabio ontology create did not return an id for '$ONTOLOGY_NAME'."
        ONTOLOGY_STATUS="failed"
        ONTOLOGY_BINDING_STATUS="failed"
        FABRIC_ITEM_WARNINGS=1
        return 0
      fi
    else
      warn "Ontology deployment failed and may need finishing in the Fabric portal: $output"
      ONTOLOGY_STATUS="failed"
      ONTOLOGY_BINDING_STATUS="failed"
      FABRIC_ITEM_WARNINGS=1
      return 0
    fi
  fi

  if [ "$bindings_ready" -eq 1 ]; then
    bind_ontology
  fi
}

refresh_semantic_model() {
  local output
  if output="$(run_fabio_optional_capture semantic-model refresh --workspace "$WORKSPACE_ID" --id "$SEMANTIC_MODEL_ID" --type full)"; then
    SEMANTIC_MODEL_REFRESH_STATUS="refreshed"
  else
    warn "Semantic model refresh did not complete; Direct Lake framing may need finishing in the Fabric portal: $output"
    SEMANTIC_MODEL_REFRESH_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

is_fabric_item_id() {
  case "$1" in
    ????????-????-????-????-????????????) return 0 ;;
    *) return 1 ;;
  esac
}

extract_lakehouse_sql_endpoint_properties() {
  node -e "
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const start = input.indexOf('{');
const end = input.lastIndexOf('}');
if (start < 0 || end < start) process.exit(1);
const payload = JSON.parse(input.slice(start, end + 1));
const root = payload && payload.data ? payload.data : payload;
const props = root && root.properties && root.properties.sqlEndpointProperties;
if (!props || typeof props.connectionString !== 'string' || typeof props.id !== 'string') {
  process.exit(1);
}
console.log(props.connectionString + '\t' + props.id);
"
}

resolve_semantic_model_connection() {
  local output
  local endpoint_properties

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio lakehouse show --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --output json >&2
    SEMANTIC_MODEL_SQL_ENDPOINT_HOST="<sql-endpoint-host>"
    SEMANTIC_MODEL_CONNECTION_ID="<sql-endpoint-id>"
    SEMANTIC_MODEL_CONNECTION_SOURCE="Lakehouse SQL endpoint"
    return 0
  fi

  if output="$(run_fabio_optional_capture lakehouse show --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --output json)"; then
    if endpoint_properties="$(printf '%s' "$output" | extract_lakehouse_sql_endpoint_properties)"; then
      SEMANTIC_MODEL_SQL_ENDPOINT_HOST="$(printf '%s' "$endpoint_properties" | awk 'BEGIN { FS="\t" } NR == 1 { print $1 }')"
      SEMANTIC_MODEL_CONNECTION_ID="$(printf '%s' "$endpoint_properties" | awk 'BEGIN { FS="\t" } NR == 1 { print $2 }')"
      SEMANTIC_MODEL_CONNECTION_SOURCE="Lakehouse SQL endpoint"
      return 0
    fi
    warn "Could not find properties.sqlEndpointProperties.connectionString/id in fabio lakehouse show output."
  else
    warn "Could not read Lakehouse details for semantic model connection discovery: $output"
  fi

  FABRIC_ITEM_WARNINGS=1
  return 1
}

build_semantic_model_definition() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_node_dry_run "$DATA_DIR/tools/build-semantic-model.ts" --sql-endpoint-host "$SEMANTIC_MODEL_SQL_ENDPOINT_HOST" --sql-endpoint-id "$SEMANTIC_MODEL_CONNECTION_ID"
    return 0
  fi

  if run_node_required "$DATA_DIR/tools/build-semantic-model.ts" --sql-endpoint-host "$SEMANTIC_MODEL_SQL_ENDPOINT_HOST" --sql-endpoint-id "$SEMANTIC_MODEL_CONNECTION_ID"; then
    return 0
  fi

  warn "Semantic model converter failed and may need finishing in the Fabric portal."
  FABRIC_ITEM_WARNINGS=1
  return 1
}

deploy_semantic_model() {
  local id
  local rc
  local output

  if [ "$SKIP_FABRIC_ITEMS" -eq 1 ]; then
    SEMANTIC_MODEL_STATUS="skipped"
    SEMANTIC_MODEL_REFRESH_STATUS="skipped"
    return 0
  fi

  rc=0
  id="$(resolve_existing_optional_item SemanticModel "$SEMANTIC_MODEL_NAME")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    SEMANTIC_MODEL_ID="$id"
    SEMANTIC_MODEL_STATUS="resolved"
    info "Resolved SemanticModel '$SEMANTIC_MODEL_NAME': $SEMANTIC_MODEL_ID"
    refresh_semantic_model
    return 0
  elif [ "$rc" -eq 2 ]; then
    SEMANTIC_MODEL_STATUS="failed"
    SEMANTIC_MODEL_REFRESH_STATUS="failed"
    return 0
  fi

  if [ ! -d "$SEMANTIC_MODEL_DIR" ]; then
    warn "Semantic model definition folder was not found at $SEMANTIC_MODEL_DIR; semantic-model create/refresh was skipped."
    SEMANTIC_MODEL_STATUS="skipped"
    SEMANTIC_MODEL_REFRESH_STATUS="skipped"
    return 0
  fi
  if ! resolve_semantic_model_connection; then
    SEMANTIC_MODEL_STATUS="failed"
    SEMANTIC_MODEL_REFRESH_STATUS="failed"
    return 0
  fi
  if ! build_semantic_model_definition; then
    SEMANTIC_MODEL_STATUS="failed"
    SEMANTIC_MODEL_REFRESH_STATUS="failed"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    run_fabio_optional_capture semantic-model create --workspace "$WORKSPACE_ID" --name "$SEMANTIC_MODEL_NAME" --definition "$SEMANTIC_MODEL_DIR" --connection "$SEMANTIC_MODEL_CONNECTION_ID" --query id --output plain >/dev/null
    SEMANTIC_MODEL_ID="<$SEMANTIC_MODEL_NAME-id>"
    SEMANTIC_MODEL_STATUS="created"
    refresh_semantic_model
  elif output="$(run_fabio_optional_capture semantic-model create --workspace "$WORKSPACE_ID" --name "$SEMANTIC_MODEL_NAME" --definition "$SEMANTIC_MODEL_DIR" --connection "$SEMANTIC_MODEL_CONNECTION_ID" --query id --output plain)"; then
    SEMANTIC_MODEL_ID="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -n "$SEMANTIC_MODEL_ID" ] && [ "$SEMANTIC_MODEL_ID" != "null" ]; then
      SEMANTIC_MODEL_STATUS="created"
      refresh_semantic_model
    else
      warn "fabio semantic-model create did not return an id for '$SEMANTIC_MODEL_NAME'."
      SEMANTIC_MODEL_STATUS="failed"
      SEMANTIC_MODEL_REFRESH_STATUS="failed"
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Semantic model deployment failed and may need finishing in the Fabric portal: $output"
    SEMANTIC_MODEL_STATUS="failed"
    SEMANTIC_MODEL_REFRESH_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

verify_ontology_peer_surface() {
  local output
  local url
  local signal_id
  # Read the signal id from the scenario rather than hardcoding it, so a
  # calendar move or rename does not silently turn this smoke test into a query
  # that matches nothing and still "passes".
  signal_id="$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.externalSignal?.signalId||""))' "$DATA_DIR/scenario.json" 2>/dev/null || true)"
  [ -n "$signal_id" ] || signal_id="the persistent El Nino advisory"
  local prompt="Which regions are affected by the El Nino signal ${signal_id}?"

  if [ "$SKIP_FABRIC_ITEMS" -eq 1 ] || [ "$ONTOLOGY_STATUS" = "skipped" ] || [ "$ONTOLOGY_STATUS" = "failed" ] || [ -z "$ONTOLOGY_ID" ]; then
    ONTOLOGY_MCP_URL_STATUS="skipped"
    ONTOLOGY_SEARCH_STATUS="skipped"
    return 0
  fi

  if output="$(run_fabio_optional_capture ontology mcp-url --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --output plain)"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      ONTOLOGY_MCP_URL="<ontology-mcp-url>"
      ONTOLOGY_MCP_URL_STATUS="dry-run"
    else
      url="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
      if [ -n "$url" ] && [ "$url" != "null" ]; then
        ONTOLOGY_MCP_URL="$url"
        ONTOLOGY_MCP_URL_STATUS="resolved"
        info "Ontology MCP endpoint: $ONTOLOGY_MCP_URL"
      else
        warn "Ontology MCP endpoint command did not return a URL."
        ONTOLOGY_MCP_URL_STATUS="failed"
        FABRIC_ITEM_WARNINGS=1
      fi
    fi
  else
    warn "Ontology MCP endpoint lookup did not complete: $output"
    ONTOLOGY_MCP_URL_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi

  if output="$(run_fabio_optional_capture ontology search --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --prompt "$prompt" --output plain)"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      ONTOLOGY_SEARCH_STATUS="dry-run"
    elif [ -n "$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')" ]; then
      ONTOLOGY_SEARCH_STATUS="answered"
      info "PASS: Ontology search smoke test answered the El Nino affected-regions question."
    else
      warn "Ontology search smoke test returned no answer."
      ONTOLOGY_SEARCH_STATUS="empty"
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Ontology search smoke test did not complete: $output"
    ONTOLOGY_SEARCH_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

data_agent_default_description() {
  printf 'Caldova analyst data agent for the LTG243 Fabric IQ demo.'
}

data_agent_description_from_config() {
  node -e '
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
  return typeof value === "string" ? value.trim() : "";
}
const roots = [
  config,
  prop(config, ["agent", "dataAgent", "definition", "config"])
].filter(Boolean);
for (const root of roots) {
  const value = str(prop(root, ["description", "agentDescription", "summary"]));
  if (value) {
    console.log(value);
    process.exit(0);
  }
}
process.exit(2);
' "$DATA_AGENT_DIR/agent.json"
}

data_agent_instructions_file_from_config() {
  node -e '
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
const value = prop(config, ["instructionsFile", "instructionFile", "instructionsPath"]);
if (typeof value !== "string" || !value.trim()) process.exit(2);
console.log(value.trim());
' "$DATA_AGENT_DIR/agent.json"
}

data_agent_sources_tsv() {
  node -e '
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
  const names = ["dataSources", "datasources", "sources", "sourceList", "artifacts"];
  const direct = prop(root, names);
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
let entries = [];
for (const root of roots) {
  entries = findSources(root);
  if (entries.length) break;
}
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
  const selected = [...new Set(flattenSelected(prop(source, ["selectedElements", "selectedTables", "elements", "tables", "selection", "include"])))];
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
  console.log([key, itemName, artifactType, attachAs, instructions, selected.join(","), fewShotFile, fewShotsUploadable].map(JSON.stringify).join("\t"));
}
' "$DATA_AGENT_DIR/agent.json"
}

json_string_arg() {
  node -e 'process.stdout.write(String(JSON.parse(process.argv[1])));' "$1"
}

safe_data_agent_key() {
  case "$1" in
    ""|*[!A-Za-z0-9_.-]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

canonical_data_agent_artifact_type() {
  local artifact_type="$1"
  local item_name="$2"
  local normalized
  normalized="$(normalize_name "$artifact_type")"

  if [ -z "$normalized" ]; then
    case "$item_name" in
      "$SEMANTIC_MODEL_NAME") normalized="semanticmodel" ;;
      "$ONTOLOGY_NAME") normalized="ontology" ;;
      "$KQL_DATABASE_NAME") normalized="kqldatabase" ;;
      "$LAKEHOUSE_NAME") normalized="lakehouse" ;;
      "$SQL_DATABASE_NAME") normalized="sqldatabase" ;;
    esac
  fi

  case "$normalized" in
    semanticmodel) printf 'SemanticModel' ;;
    ontology) printf 'Ontology' ;;
    kqldatabase|kustodatabase) printf 'KQLDatabase' ;;
    lakehouse) printf 'Lakehouse' ;;
    sqldatabase) printf 'SQLDatabase' ;;
    *) return 1 ;;
  esac
}

data_agent_artifact_id() {
  case "$(canonical_data_agent_artifact_type "$1" "$2" 2>/dev/null || true)" in
    SemanticModel) printf '%s' "$SEMANTIC_MODEL_ID" ;;
    Ontology) printf '%s' "$ONTOLOGY_ID" ;;
    KQLDatabase) printf '%s' "$KQL_DATABASE_ID" ;;
    Lakehouse) printf '%s' "$LAKEHOUSE_ID" ;;
    SQLDatabase) printf '%s' "$SQL_DATABASE_ID" ;;
    *) return 1 ;;
  esac
}

resolve_or_create_data_agent() {
  local description="$1"
  local query
  local output
  local id

  ensure_query_safe "$DATA_AGENT_NAME" "DataAgent item name"
  query="[?displayName=='$DATA_AGENT_NAME'].id | [0]"

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio data-agent list --workspace "$WORKSPACE_ID" --query "$query" --output plain
    if [ "$VERIFY_ONLY" -eq 0 ]; then
      print_dry_run fabio data-agent create --workspace "$WORKSPACE_ID" --name "$DATA_AGENT_NAME" --description "$description" --query id --output plain
    fi
    DATA_AGENT_ID="<$DATA_AGENT_NAME-id>"
    DATA_AGENT_STATUS="created"
    return 0
  fi

  if ! output="$(run_fabio_optional_capture data-agent list --workspace "$WORKSPACE_ID" --query "$query" --output plain)"; then
    warn "Could not resolve data agent '$DATA_AGENT_NAME': $output"
    DATA_AGENT_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
    return 1
  fi

  id="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
  if [ -n "$id" ] && [ "$id" != "null" ]; then
    DATA_AGENT_ID="$id"
    DATA_AGENT_STATUS="resolved"
    info "Resolved DataAgent '$DATA_AGENT_NAME': $DATA_AGENT_ID"
    return 0
  fi

  if output="$(run_fabio_optional_capture data-agent create --workspace "$WORKSPACE_ID" --name "$DATA_AGENT_NAME" --description "$description" --query id --output plain)"; then
    DATA_AGENT_ID="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -n "$DATA_AGENT_ID" ] && [ "$DATA_AGENT_ID" != "null" ]; then
      DATA_AGENT_STATUS="created"
      return 0
    fi
    warn "fabio data-agent create did not return an id for '$DATA_AGENT_NAME'."
  else
    warn "Data agent creation failed and may need finishing in the Fabric portal: $output"
  fi

  DATA_AGENT_STATUS="failed"
  FABRIC_ITEM_WARNINGS=1
  return 1
}

data_agent_act1_question() {
  node -e '
const fs = require("node:fs");
const path = process.argv[1];
const entries = JSON.parse(fs.readFileSync(path, "utf8"));
const selected = entries.find((entry) => String(entry.act) === "1") || entries[0];
if (!selected || typeof selected.question !== "string" || !selected.question.trim()) process.exit(2);
console.log(selected.question.trim());
' "$DATA_DIR/evaluation/questions.json"
}

prepare_data_agent_evaluation_questions() {
  local source="$DATA_DIR/evaluation/questions.json"
  local output="$STAGING/fabric-items/data-agent-evaluation-questions.json"

  if [ ! -f "$source" ]; then
    warn "Evaluation questions file was not found at $source; data agent evaluation was skipped."
    DATA_AGENT_EVALUATION_STATUS="skipped"
    FABRIC_ITEM_WARNINGS=1
    return 1
  fi

  mkdir -p "$(dirname "$output")"
  if node -e '
const fs = require("node:fs");
const input = process.argv[1];
const output = process.argv[2];
const entries = JSON.parse(fs.readFileSync(input, "utf8"));
if (!Array.isArray(entries)) throw new Error("questions.json must be an array");
const questions = entries.map((entry) => ({
  question: String(entry.question || "").trim(),
  expected: Array.isArray(entry.expectedFacts) ? entry.expectedFacts.map(String).join("; ") : String(entry.expected || "").trim()
})).filter((entry) => entry.question);
fs.writeFileSync(output, JSON.stringify(questions, null, 2) + "\n");
' "$source" "$output"; then
    DATA_AGENT_EVALUATION_QUESTIONS="$output"
    return 0
  fi

  warn "Could not derive fabio data-agent evaluation questions from $source."
  DATA_AGENT_EVALUATION_STATUS="failed"
  FABRIC_ITEM_WARNINGS=1
  return 1
}

verify_data_agent_act1_answer() {
  local question
  local output

  [ "$DATA_AGENT_PUBLISHED" = "yes" ] || return 0
  if ! question="$(data_agent_act1_question 2>/dev/null)"; then
    warn "Could not read the Act 1 evaluation question; data agent query verification was skipped."
    DATA_AGENT_EL_NINO_SIGNAL_STATUS="skipped"
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi

  if output="$(run_fabio_optional_capture data-agent query --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --prompt "$question" --output plain)"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      DATA_AGENT_EL_NINO_SIGNAL_STATUS="dry-run"
      return 0
    fi
    if printf '%s' "$output" | grep -Eiq 'El[[:space:]-]*Nino|ENSO|SIG-ENSO'; then
      info "PASS: Data agent Act 1 answer mentioned the El Nino signal."
      DATA_AGENT_EL_NINO_SIGNAL_STATUS="mentioned"
    else
      warn "Data agent Act 1 answer did not clearly mention the El Nino signal; review the published agent response."
      DATA_AGENT_EL_NINO_SIGNAL_STATUS="not mentioned"
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    if data_agent_query_blocked_by_tenant_setting "$output"; then
      warn "Data agent Act 1 query is blocked by Fabric tenant setting AllowStoreAOAIDataInOtherRegions ('Data sent to Azure OpenAI can be stored outside your capacity's geographic region'). Ask a Fabric admin to enable that setting; the agent deployment can still be valid."
      DATA_AGENT_EL_NINO_SIGNAL_STATUS="blocked by tenant setting AllowStoreAOAIDataInOtherRegions"
    else
      warn "Data agent Act 1 query verification did not complete: $output"
      DATA_AGENT_EL_NINO_SIGNAL_STATUS="failed"
    fi
    FABRIC_ITEM_WARNINGS=1
  fi
}

data_agent_query_blocked_by_tenant_setting() {
  case "$1" in
    *AllowStoreAOAIDataInOtherRegions*|*"Data sent to Azure OpenAI can be stored outside your capacity"*"geographic region"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

data_agent_fewshots_uploadable() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

verify_data_agent_fewshots() {
  local key="$1"
  local source_ref="$2"
  local output
  local count

  if output="$(run_fabio_optional_capture data-agent list-fewshots --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --datasource "$source_ref" --all --query 'length(@)' --output plain)"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      DATA_AGENT_FEWSHOT_STATUS="dry-run"
      return 0
    fi
    count="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -n "$count" ] && [ "$count" != "null" ] && [ "$count" -gt 0 ] 2>/dev/null; then
      DATA_AGENT_FEWSHOT_SOURCES_VERIFIED="$((DATA_AGENT_FEWSHOT_SOURCES_VERIFIED + 1))"
      if [ "$DATA_AGENT_FEWSHOT_STATUS" != "failed" ]; then
        DATA_AGENT_FEWSHOT_STATUS="verified"
      fi
      info "PASS: Data agent source '$key' reports $count stored few-shot example(s)."
    else
      warn "Data agent source '$key' accepted a few-shot upload but list-fewshots returned zero examples."
      DATA_AGENT_FEWSHOT_STATUS="failed"
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Few-shot verification for data agent source '$key' did not complete: $output"
    DATA_AGENT_FEWSHOT_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

evaluate_data_agent() {
  local output

  [ "$EVALUATE_AGENT" -eq 1 ] || return 0
  if [ "$DATA_AGENT_PUBLISHED" != "yes" ] || [ -z "$DATA_AGENT_ID" ]; then
    warn "Data agent evaluation was requested but no published agent is available."
    DATA_AGENT_EVALUATION_STATUS="skipped"
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi
  if ! prepare_data_agent_evaluation_questions; then
    return 0
  fi

  if output="$(run_fabio_optional_capture data-agent evaluate --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --questions "$DATA_AGENT_EVALUATION_QUESTIONS")"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      DATA_AGENT_EVALUATION_STATUS="dry-run"
    else
      DATA_AGENT_EVALUATION_STATUS="ran"
    fi
    if [ -n "$output" ]; then
      printf '%s\n' "$output"
    fi
  else
    warn "Data agent evaluation did not complete: $output"
    DATA_AGENT_EVALUATION_STATUS="failed"
    FABRIC_ITEM_WARNINGS=1
  fi
}

deploy_data_agent() {
  local description
  local sources
  local key_json
  local item_name_json
  local artifact_type_json
  local attach_as_json
  local instructions_json
  local selected_json
  local fewshot_json
  local fewshots_uploadable_json
  local key
  local item_name
  local artifact_type
  local attach_as
  local normalized_attach_as
  local canonical_type
  local instructions
  local selected
  local configured_fewshot
  local fewshots_uploadable
  local artifact_id
  local output
  local source_ref
  local source_placeholder
  local fewshot
  local instructions_file
  local instructions_path
  local -a args

  if [ "$SKIP_FABRIC_ITEMS" -eq 1 ]; then
    DATA_AGENT_STATUS="skipped"
    DATA_AGENT_PUBLISHED="no"
    DATA_AGENT_EL_NINO_SIGNAL_STATUS="skipped"
    DATA_AGENT_EVALUATION_STATUS="skipped"
    DATA_AGENT_FEWSHOT_STATUS="skipped"
    DATA_AGENT_FEWSHOT_SOURCES_VERIFIED=0
    return 0
  fi

  description="$(data_agent_default_description)"
  if [ -f "$DATA_AGENT_DIR/agent.json" ]; then
    if output="$(data_agent_description_from_config 2>/dev/null)"; then
      [ -n "$output" ] && description="$output"
    else
      warn "Could not read data agent description from $DATA_AGENT_DIR/agent.json; using the default description."
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Data agent definition was not found at $DATA_AGENT_DIR/agent.json; only the resolve/create command will be planned."
    FABRIC_ITEM_WARNINGS=1
  fi
  if [ "${#description}" -gt 256 ]; then
    warn "Data agent description is longer than fabio's 256-character limit; using the first 256 characters."
    description="${description:0:256}"
  fi

  if ! resolve_or_create_data_agent "$description"; then
    return 0
  fi

  if [ ! -f "$DATA_AGENT_DIR/agent.json" ]; then
    return 0
  fi

  instructions_file="instructions.md"
  if output="$(data_agent_instructions_file_from_config 2>/dev/null)"; then
    [ -n "$output" ] && instructions_file="$output"
  fi
  case "$instructions_file" in
    /*) instructions_path="$instructions_file" ;;
    *) instructions_path="$DATA_AGENT_DIR/$instructions_file" ;;
  esac

  if [ -f "$instructions_path" ]; then
    if ! output="$(run_fabio_optional_capture data-agent update-config --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --instructions-file "$instructions_path")"; then
      warn "Data agent instructions update did not complete: $output"
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Data agent instructions file was not found at $instructions_path; continuing without global agent instructions."
    FABRIC_ITEM_WARNINGS=1
  fi

  if ! sources="$(data_agent_sources_tsv 2>&1)"; then
    warn "Could not parse data agent sources from $DATA_AGENT_DIR/agent.json: $sources"
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi
  if [ -z "$sources" ]; then
    warn "No data agent sources were found in $DATA_AGENT_DIR/agent.json; publish was skipped."
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi

  while IFS=$'\t' read -r key_json item_name_json artifact_type_json attach_as_json instructions_json selected_json fewshot_json fewshots_uploadable_json; do
    [ -n "$key_json" ] || continue
    key="$(json_string_arg "$key_json")"
    item_name="$(json_string_arg "$item_name_json")"
    artifact_type="$(json_string_arg "$artifact_type_json")"
    attach_as="$(json_string_arg "$attach_as_json")"
    normalized_attach_as="$(normalize_name "$attach_as")"
    instructions="$(json_string_arg "$instructions_json")"
    selected="$(json_string_arg "$selected_json")"
    if [ -n "${fewshot_json:-}" ]; then
      configured_fewshot="$(json_string_arg "$fewshot_json")"
    else
      configured_fewshot=""
    fi
    if [ -n "${fewshots_uploadable_json:-}" ]; then
      fewshots_uploadable="$(json_string_arg "$fewshots_uploadable_json")"
    else
      fewshots_uploadable=""
    fi

    if ! canonical_type="$(canonical_data_agent_artifact_type "$artifact_type" "$item_name")"; then
      warn "Data agent source '$key' uses unsupported artifactType '$artifact_type'; skipping."
      FABRIC_ITEM_WARNINGS=1
      continue
    fi

    fewshot=""
    if [ -n "$configured_fewshot" ]; then
      case "$configured_fewshot" in
        /*) fewshot="$configured_fewshot" ;;
        *) fewshot="$DATA_AGENT_DIR/$configured_fewshot" ;;
      esac
    fi

    if [ "$normalized_attach_as" = "peersurface" ]; then
      if [ "$canonical_type" = "Ontology" ]; then
        info "Using data agent source '$key' as a peer surface from agent.json attachAs=PeerSurface."
        verify_ontology_peer_surface
      else
        warn "Data agent source '$key' has attachAs=PeerSurface, but artifactType '$artifact_type' does not have a scripted peer-surface verifier."
        FABRIC_ITEM_WARNINGS=1
      fi
      continue
    fi

    if [ "$normalized_attach_as" != "datasource" ]; then
      warn "Data agent source '$key' has unsupported attachAs='$attach_as'; skipping."
      FABRIC_ITEM_WARNINGS=1
      continue
    fi

    artifact_id="$(data_agent_artifact_id "$canonical_type" "$item_name" || true)"
    if [ -z "$artifact_id" ]; then
      warn "Data agent source '$key' references $canonical_type '$item_name', but the corresponding item id is not available; skipping."
      FABRIC_ITEM_WARNINGS=1
      continue
    fi

    args=(data-agent add-datasource --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --artifact "$artifact_id" --artifact-type "$canonical_type")
    if [ -n "$instructions" ]; then
      args+=(--instructions "$instructions")
    fi
    args+=(--query id --output plain)
    if output="$(run_fabio_optional_capture "${args[@]}")"; then
      DATA_AGENT_SOURCES_ATTACHED="$((DATA_AGENT_SOURCES_ATTACHED + 1))"
      source_ref="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
      if [ "$DRY_RUN" -eq 1 ]; then
        source_placeholder="$(normalize_name "$key")"
        [ -n "$source_placeholder" ] || source_placeholder="$(normalize_name "$canonical_type")"
        source_ref="<$source_placeholder-datasource-id>"
      elif [ -z "$source_ref" ] || [ "$source_ref" = "null" ]; then
        source_ref="$artifact_id"
      fi
    elif printf '%s' "$output" | grep -q 'AlreadyAddedDataSource'; then
      # Re-running the deployment must be a no-op here, not a failure. The source
      # is already attached, so treat it as attached and carry on; otherwise the
      # attach count stays at zero and publish is skipped on every rerun.
      info "Data agent source '$key' is already attached; reusing it."
      DATA_AGENT_SOURCES_ATTACHED="$((DATA_AGENT_SOURCES_ATTACHED + 1))"
      source_ref="$artifact_id"
    else
      warn "Data agent source '$key' was not attached: $output"
      FABRIC_ITEM_WARNINGS=1
      continue
    fi

    if data_agent_fewshots_uploadable "$fewshots_uploadable"; then
      if [ -z "$fewshot" ]; then
        warn "Data agent source '$key' is marked fewShotsUploadable=true but has no fewShotFile."
        DATA_AGENT_FEWSHOT_STATUS="failed"
        FABRIC_ITEM_WARNINGS=1
      elif [ ! -f "$fewshot" ]; then
        warn "Data agent source '$key' is marked fewShotsUploadable=true but few-shot file was not found at $fewshot."
        DATA_AGENT_FEWSHOT_STATUS="failed"
        FABRIC_ITEM_WARNINGS=1
      else
        # upload-fewshots appends, so re-running the deployment would accumulate
        # duplicate examples on every pass. Clear first to make the upload a
        # replace, which is what an idempotent deployment needs.
        run_fabio_optional_capture data-agent clear-fewshots --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --datasource "$source_ref" >/dev/null || true
        if ! output="$(run_fabio_optional_capture data-agent upload-fewshots --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --datasource "$source_ref" --file "$fewshot")"; then
          warn "Few-shot upload for data agent source '$key' did not complete: $output"
          DATA_AGENT_FEWSHOT_STATUS="failed"
          FABRIC_ITEM_WARNINGS=1
        else
          verify_data_agent_fewshots "$key" "$source_ref"
        fi
      fi
    elif [ -n "$fewshot" ]; then
      info "Skipping few-shot upload for data agent source '$key' because agent.json marks fewShotsUploadable=false."
    fi

    if [ -n "$selected" ]; then
      if ! output="$(run_fabio_optional_capture data-agent select-tables --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID" --datasource "$source_ref" --elements "$selected")"; then
        warn "Data agent selected elements for source '$key' were not applied: $output"
        FABRIC_ITEM_WARNINGS=1
      fi
    fi
  done <<< "$sources"

  if [ "$DATA_AGENT_SOURCES_ATTACHED" -eq 0 ]; then
    warn "No data agent data sources were attached; publish was skipped."
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi

  if output="$(run_fabio_optional_capture data-agent publish --workspace "$WORKSPACE_ID" --id "$DATA_AGENT_ID")"; then
    DATA_AGENT_PUBLISHED="yes"
  else
    warn "Data agent publish did not complete: $output"
    DATA_AGENT_PUBLISHED="no"
    FABRIC_ITEM_WARNINGS=1
    return 0
  fi

  verify_data_agent_act1_answer
  evaluate_data_agent
}

deploy_fabric_items() {
  deploy_ontology
  deploy_semantic_model
  deploy_data_agent
}

expected_shortfall_units() {
  node -e 'const fs=require("node:fs"); const path=require("node:path"); const root=process.argv[1]; const scenario=JSON.parse(fs.readFileSync(path.join(root,"scenario.json"),"utf8")); let expected={}; const p=path.join(root,"evaluation","expected-results.json"); if (fs.existsSync(p)) expected=JSON.parse(fs.readFileSync(p,"utf8")); const value=expected.shortfallUnits ?? expected.capacityShortfallUnits ?? expected.capacity?.shortfallUnits ?? expected.capacityModel?.shortfallUnits ?? scenario.capacityModel?.expected?.shortfallUnits; if (value === undefined || value === null) process.exit(2); console.log(value);' "$DATA_DIR"
}

preferred_sql_csvs_for_verification() {
  local dir="$STAGING/fabric-sql"
  local count=0
  local name
  local file
  [ -d "$dir" ] || return 0

  for name in regions products campaigns launch_plans decision_cases; do
    file="$dir/$name.csv"
    if [ -f "$file" ]; then
      printf '%s\n' "$file"
      count="$((count + 1))"
      [ "$count" -ge 3 ] && return 0
    fi
  done

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$(basename "$file")" in
      regions.csv|products.csv|campaigns.csv|launch_plans.csv|decision_cases.csv) continue ;;
    esac
    printf '%s\n' "$file"
    count="$((count + 1))"
    [ "$count" -ge 3 ] && return 0
  done < <(find "$dir" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

record_check() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf 'PASS: %s (%s)\n' "$label" "$actual"
  else
    printf 'FAIL: %s expected %s, got %s\n' "$label" "$expected" "${actual:-<empty>}" >&2
    VERIFICATION_FAILED=1
  fi
}

verify_sql_counts() {
  local csv
  local table
  local expected
  local actual
  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="$(basename "$csv" .csv)"
    is_identifier "$table" || continue
    expected="$(csv_row_count "$csv")"
    actual="$(sql_row_count "$table")"
    record_check "SQL table $table row count" "$actual" "$expected"
  done < <(preferred_sql_csvs_for_verification)
}

verify_sql_shortfall() {
  local expected
  local actual
  expected="$(expected_shortfall_units || true)"
  [ -n "$expected" ] || {
    warn "No expected shortfall value was found in expected-results.json or scenario.json."
    return 0
  }

  # Read the purpose-built stage view rather than guessing at a CSV column. This
  # is the same number the Act 3 demo puts on screen.
  actual="$(sql_scalar "SELECT TOP 1 shortfallUnits AS value FROM dbo.vw_capacity_conflict;")"
  if [ -z "$actual" ]; then
    warn "Could not read shortfallUnits from dbo.vw_capacity_conflict; skipping shortfall assertion."
    return 0
  fi
  record_check "SQL campaign shortfall value" "$actual" "$expected"
}

verify_kql_line_signals() {
  local dir="$STAGING/eventhouse"
  local csv
  local table
  local expected
  local actual
  csv="$(find_first_matching_file "$dir" '*line*signals*.csv')"
  if [ -z "$csv" ]; then
    csv="$(find_first_matching_file "$dir" '*LineSignals*.csv')"
  fi
  [ -n "$csv" ] || {
    warn "No LineSignals CSV found; skipped KQL LineSignals verification."
    return 0
  }
  table="$(kql_table_for_csv "$csv" "$dir")"
  expected="$(csv_row_count "$csv")"
  actual="$(kql_scalar "$table | summarize value=count()")"
  record_check "KQL table $table row count" "$actual" "$expected"
}

verify_lakehouse_dashboard_tables() {
  local dashboard="$STAGING/lakehouse/dashboard"
  local csv
  local table
  [ -d "$dashboard" ] || return 0
  while IFS= read -r csv; do
    [ -n "$csv" ] || continue
    table="dash_$(to_snake_table_name "$(basename "$csv" .csv)")"
    is_identifier "$table" || continue
    if lakehouse_table_exists "$table"; then
      printf 'PASS: Lakehouse table %s exists\n' "$table"
    else
      printf 'FAIL: Lakehouse table %s was not found\n' "$table" >&2
      VERIFICATION_FAILED=1
    fi
  done < <(find "$dashboard" -maxdepth 1 -type f -name '*.csv' -print | sort)
}

verify_ontology_entity_types() {
  local output
  local count
  if [ "$ONTOLOGY_STATUS" = "skipped" ] || [ "$ONTOLOGY_STATUS" = "failed" ] || [ -z "$ONTOLOGY_ID" ]; then
    return 0
  fi
  # The API returns {values:[...]}, so length(@) counts object keys and always
  # reports 1. Count the array itself, falling back for any future shape change.
  if output="$(run_fabio_optional_capture ontology list-entity-types --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --query 'length(values)' --output plain)"; then
    count="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -z "$count" ] || [ "$count" = "null" ]; then
      if output="$(run_fabio_optional_capture ontology list-entity-types --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --query 'length(@)' --output plain)"; then
        count="$(printf '%s' "$output" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
      fi
    fi
    if [ -n "$count" ] && [ "$count" != "0" ] && [ "$count" != "null" ]; then
      printf 'PASS: Ontology %s reports %s entity type(s)\n' "$ONTOLOGY_NAME" "$count"
    else
      warn "Ontology '$ONTOLOGY_NAME' exists but did not report entity types."
      FABRIC_ITEM_WARNINGS=1
    fi
  else
    warn "Ontology entity type verification did not complete: $output"
    FABRIC_ITEM_WARNINGS=1
  fi
}

verify_semantic_model_query() {
  local output
  if [ "$SEMANTIC_MODEL_STATUS" = "skipped" ] || [ "$SEMANTIC_MODEL_STATUS" = "failed" ] || [ -z "$SEMANTIC_MODEL_ID" ]; then
    return 0
  fi
  if output="$(run_fabio_optional_capture semantic-model query --workspace "$WORKSPACE_ID" --id "$SEMANTIC_MODEL_ID" --dax 'EVALUATE ROW("ok", 1)')"; then
    printf 'PASS: Semantic model %s answered a trivial DAX query\n' "$SEMANTIC_MODEL_NAME"
  else
    warn "Semantic model DAX verification did not complete: $output"
    FABRIC_ITEM_WARNINGS=1
  fi

  # Direct Lake serves a framed snapshot of the Delta tables, and a framing that
  # fails to advance leaves the model quietly answering from pre-load data. That
  # is not cosmetic here: it once reported three executed governed actions while
  # the Lakehouse correctly reported none, which would contradict the
  # open-decision story the session depends on. Compare a table both surfaces
  # hold and fail loudly if they disagree.
  local model_rows lake_rows
  if model_rows="$(run_fabio_optional_capture semantic-model query --workspace "$WORKSPACE_ID" --id "$SEMANTIC_MODEL_ID" --dax 'EVALUATE ROW("n", COUNTROWS(capacity_plan))' --query '[0]."[n]"' --output plain)" &&
    lake_rows="$(run_fabio_optional_capture lakehouse query --workspace "$WORKSPACE_ID" --id "$LAKEHOUSE_ID" --sql 'SELECT COUNT(*) AS n FROM capacity_plan' --query '[0].n' --output plain)"; then
    model_rows="$(printf '%s' "$model_rows" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    lake_rows="$(printf '%s' "$lake_rows" | tr -d '\r' | sed '/^$/d' | sed -n '1p')"
    if [ -n "$model_rows" ] && [ "$model_rows" = "$lake_rows" ]; then
      printf 'PASS: Semantic model agrees with the Lakehouse (capacity_plan = %s rows)\n' "$model_rows"
    else
      warn "Semantic model is stale: capacity_plan reports $model_rows rows but the Lakehouse reports $lake_rows. Re-run 'fabio semantic-model refresh --type full'."
      FABRIC_ITEM_WARNINGS=1
    fi
  fi
}

run_verification() {
  info "Running post-load verification..."
  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run fabio sql-database query --workspace "$WORKSPACE_ID" --id "$SQL_DATABASE_ID" --sql "SELECT COUNT_BIG(*) AS value FROM dbo.<table>;" --query '[0].value' --output plain
    print_dry_run fabio kql-database query --workspace "$WORKSPACE_ID" --id "$KQL_DATABASE_ID" --kql "LineSignals | summarize value=count()" --query '[0].value' --output plain
    if [ "$SKIP_FABRIC_ITEMS" -eq 0 ] && [ "$ONTOLOGY_STATUS" != "skipped" ] && [ "$ONTOLOGY_STATUS" != "failed" ]; then
      print_dry_run fabio ontology list-entity-types --workspace "$WORKSPACE_ID" --id "$ONTOLOGY_ID" --query 'length(@)' --output plain
    fi
    if [ "$SKIP_FABRIC_ITEMS" -eq 0 ] && [ "$SEMANTIC_MODEL_STATUS" != "skipped" ] && [ "$SEMANTIC_MODEL_STATUS" != "failed" ]; then
      print_dry_run fabio semantic-model query --workspace "$WORKSPACE_ID" --id "$SEMANTIC_MODEL_ID" --dax 'EVALUATE ROW("ok", 1)'
    fi
    return 0
  fi
  verify_sql_counts
  verify_sql_shortfall
  verify_kql_line_signals
  verify_lakehouse_dashboard_tables
  verify_ontology_entity_types
  verify_semantic_model_query
  [ "$VERIFICATION_FAILED" -eq 0 ] || fail "One or more verification checks failed."
}

print_summary() {
  info ""
  info "Deployment summary"
  info "  Workspace: $WORKSPACE_ID"
  info "  Lakehouse: $LAKEHOUSE_NAME ($LAKEHOUSE_ID)"
  info "  Eventhouse: $EVENTHOUSE_NAME ($EVENTHOUSE_ID)"
  info "  KQL database: $KQL_DATABASE_NAME ($KQL_DATABASE_ID)"
  info "  SQL database: $SQL_DATABASE_NAME ($SQL_DATABASE_ID)"
  if [ "$WITH_COSMOS" -eq 1 ]; then
    info "  Cosmos DB database: $COSMOS_DATABASE_NAME ($COSMOS_DATABASE_ID) [documents loaded: $COSMOS_DOCUMENTS_LOADED]"
  fi
  if [ -n "$ONTOLOGY_ENTITY_BINDING_COUNT" ] && [ -n "$ONTOLOGY_CONTEXTUALIZATION_COUNT" ]; then
    info "  Ontology: $ONTOLOGY_NAME (${ONTOLOGY_ID:-<none>}) [$ONTOLOGY_STATUS; binding: $ONTOLOGY_BINDING_STATUS; entity_bindings: $ONTOLOGY_ENTITY_BINDING_COUNT; contextualizations: $ONTOLOGY_CONTEXTUALIZATION_COUNT]"
  else
    info "  Ontology: $ONTOLOGY_NAME (${ONTOLOGY_ID:-<none>}) [$ONTOLOGY_STATUS; binding: $ONTOLOGY_BINDING_STATUS]"
  fi
  info "  Ontology MCP endpoint: ${ONTOLOGY_MCP_URL:-<none>} [mcp-url: $ONTOLOGY_MCP_URL_STATUS; search: $ONTOLOGY_SEARCH_STATUS]"
  info "  Semantic model: $SEMANTIC_MODEL_NAME (${SEMANTIC_MODEL_ID:-<none>}) [$SEMANTIC_MODEL_STATUS; refresh: $SEMANTIC_MODEL_REFRESH_STATUS]"
  info "  Semantic model connection: ${SEMANTIC_MODEL_CONNECTION_ID:-<none>} [$SEMANTIC_MODEL_CONNECTION_SOURCE]"
  info "  Data agent: $DATA_AGENT_NAME (${DATA_AGENT_ID:-<none>}) [$DATA_AGENT_STATUS; sources attached: $DATA_AGENT_SOURCES_ATTACHED; published: $DATA_AGENT_PUBLISHED; few-shot verification: $DATA_AGENT_FEWSHOT_STATUS; few-shot sources verified: $DATA_AGENT_FEWSHOT_SOURCES_VERIFIED; El Nino signal: $DATA_AGENT_EL_NINO_SIGNAL_STATUS; evaluation: $DATA_AGENT_EVALUATION_STATUS]"
  info "  SQL rows loaded: $SQL_ROWS_LOADED"
  info "  Eventhouse rows loaded: $EVENTHOUSE_ROWS_LOADED"
  info "  Lakehouse files uploaded: $LAKEHOUSE_FILES_UPLOADED"
  info "  Lakehouse analytics Delta tables loaded: $LAKEHOUSE_ANALYTICS_DELTA_TABLES_LOADED"
  info "  Lakehouse analytics rows loaded: $LAKEHOUSE_ANALYTICS_ROWS_LOADED"
  info "  Lakehouse dashboard rows loaded: $LAKEHOUSE_DASHBOARD_ROWS_LOADED"
  info "  Lakehouse evidence Delta tables loaded: $LAKEHOUSE_EVIDENCE_DELTA_TABLES_LOADED"
  info "  Lakehouse evidence rows loaded: $LAKEHOUSE_EVIDENCE_ROWS_LOADED"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "  Verification: dry-run commands printed"
  elif [ "$FABRIC_ITEM_WARNINGS" -eq 1 ]; then
    info "  Verification: PASS with fabric item warnings"
  else
    info "  Verification: PASS"
  fi
  info ""
  info "Next step:"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "  Review the workspace and item names, then run the same command without --dry-run."
  elif [ "$FABRIC_ITEM_WARNINGS" -eq 1 ]; then
    info "  Resolve the warnings above before rehearsing the demo."
  else
    info "  Open $DATA_AGENT_NAME, ask the LTG243 question, and inspect the source rows."
  fi
  if [ "$SKIP_FABRIC_ITEMS" -eq 1 ]; then
    info "  Ontology, semantic model, and Data Agent deployment was skipped."
  fi
  if [ "$WITH_COSMOS" -eq 1 ]; then
    info "  Optional shared-fixture Cosmos documents were also loaded."
  fi
}

main() {
  check_prerequisites
  local_prepare
  authenticate
  resolve_workspace
  resolve_items

  if [ "$VERIFY_ONLY" -eq 0 ]; then
    check_lakehouse_overwrite_protection
    load_fabric_sql
    load_eventhouse
    load_lakehouse
    load_lakehouse_analytics
    load_cosmos_documents
    deploy_fabric_items
  elif [ "$SKIP_FABRIC_ITEMS" -eq 1 ]; then
    ONTOLOGY_STATUS="skipped"
    ONTOLOGY_BINDING_STATUS="skipped"
    SEMANTIC_MODEL_STATUS="skipped"
    SEMANTIC_MODEL_REFRESH_STATUS="skipped"
  fi

  run_verification
  print_summary
}

main
