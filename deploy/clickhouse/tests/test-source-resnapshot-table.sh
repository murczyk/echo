#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT_DIR=$(cd "$TEST_DIR/../bin" && pwd)
case_dir=$(mktemp -d /tmp/echo-source-resnapshot-test.XXXXXX)

cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

manifest=$case_dir/migration-impact.json
cat >"$manifest" <<'JSON'
{
  "migrations": {
    "echo:m1": {
      "changes": [
        { "table": "public.empty", "strategy": "empty_table_resnapshot" }
      ]
    },
    "echo:m2": {
      "changes": [
        {
          "table": "public.nonempty",
          "strategy": "replicated_snapshot",
          "targeted_resnapshot": true
        },
        { "table": "public.created", "strategy": "replicated_snapshot" }
      ]
    },
    "echo:m3": {
      "changes": [
        { "table": "public.empty", "strategy": "cdc_backfill" }
      ]
    }
  },
  "dependencies": {
    "echo-im:new": {
      "changes": [
        {
          "table": "public.dependency",
          "strategy": "replicated_snapshot",
          "targeted_resnapshot": true
        }
      ]
    }
  }
}
JSON

baseline_manifest=$case_dir/deployment-baseline-migration-impact.json
cat >"$baseline_manifest" <<'JSON'
{
  "migrations": {
    "echo:m1": {
      "changes": [
        { "table": "public.empty", "strategy": "empty_table_resnapshot" }
      ]
    },
    "echo:m2": {
      "changes": []
    }
  },
  "dependencies": {}
}
JSON

export ECHO_SOURCE_RESNAPSHOT_TEST_MODE=true
export ECHO_PEERDB_MIGRATION_IMPACT_FILE=$manifest
export ECHO_PEERDB_DEPLOYMENT_BASELINE_MANIFEST_FILE=$baseline_manifest
export ECHO_PEERDB_LIB=$SCRIPT_DIR/lib.sh
# shellcheck disable=SC1090
source "$SCRIPT_DIR/source-resnapshot-table.sh"

expected=$'replicated_snapshot\tpublic.dependency\nreplicated_snapshot\tpublic.nonempty'
[[ $(manifest_resnapshot_entries) == "$expected" ]]
deployment_baseline_manifest_file=$manifest
[[ -z $(manifest_resnapshot_entries) ]]
deployment_baseline_manifest_file=$baseline_manifest
[[ $(manifest_resnapshot_strategy public.empty) == empty_table_resnapshot ]]
[[ $(manifest_resnapshot_strategy public.dependency) == replicated_snapshot ]]
[[ $(manifest_resnapshot_strategy public.nonempty) == replicated_snapshot ]]
if manifest_resnapshot_strategy public.created >/dev/null 2>&1; then
  printf 'ordinary replicated snapshot unexpectedly received targeted authorization\n' >&2
  exit 1
fi
if manifest_resnapshot_strategy public.unknown >/dev/null 2>&1; then
  printf 'unknown table unexpectedly received resnapshot authorization\n' >&2
  exit 1
fi

printf 'Source table resnapshot authorization tests passed\n'
