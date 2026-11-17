#!/usr/bin/env bash
# Fails when echo-ai-agent/ changes without a new harness release ID.
#
# Release IDs are immutable: the agent VMs keep the first bundle uploaded under
# an ID, and the bundle digest covers every file under echo-ai-agent/,
# documentation included. Any later byte change under the same ID blocks
# upgrades with "Release ID contains different bundle bytes"
# (echo-ai-agent/CONTROL_PANEL.md).
#
# Usage: check_harness_release_id.sh <base-ref>
# On a pull request, HEAD is the merge result, so the diff is the PR's change.
set -euo pipefail

base=${1:?usage: check_harness_release_id.sh <base-ref>}

release_at() {
  git show "$1:echo-ai-agent/release.json" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["release"])'
}

if git diff --quiet "$base" HEAD -- echo-ai-agent; then
  echo "echo-ai-agent/ is unchanged; no harness release ID bump needed."
  exit 0
fi

base_release=$(release_at "$base")
head_release=$(release_at HEAD)
if [[ "$base_release" == "$head_release" ]]; then
  echo "echo-ai-agent/ changed, but the harness release ID is still $head_release." >&2
  echo "Bump it everywhere it appears, as in earlier releases:" >&2
  echo "  release.json (release and supportedRunnerReleases), versions.env," >&2
  echo "  the dispatcher, runner.ts, runner.test.ts and wdintel-rs/src/config.rs." >&2
  git diff --stat "$base" HEAD -- echo-ai-agent >&2
  exit 1
fi

for file in \
  echo-ai-agent/versions.env \
  echo-ai-agent/dispatcher/echo_ai_agent_dispatcher.py \
  echo-ai-agent/runner/runner.ts \
  echo-ai-agent/runner/runner.test.ts \
  wdintel-rs/src/config.rs; do
  grep -qF "$head_release" "$file" \
    || { echo "$file does not mention harness release $head_release." >&2; exit 1; }
done
echo "Harness release ID changed: $base_release -> $head_release."
