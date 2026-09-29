# #3064 AI map documents: implementation handoff

Recorded on 2026-09-29 for [#3064](https://github.com/echoua/echo/issues/3064).
This records the implemented feature, subsequent capacity/cancellation fixes,
verification evidence, and machine-local artifacts needed to continue elsewhere.
It contains no supplied operational records or credentials.

## Start here

- Checkout: `/home/ubuntu/workspace/echo-main`.
- Branch: `3064-ai-map-response`; base: `main`.
- Implementation HEAD: `df8f39f446ddb099929b70132c2df76ce0a47d35`.
- Open PR: [#3636](https://github.com/echoua/echo/pull/3636).
- The implementation was committed and pushed; the working tree was clean before
  adding this archive. This archive will be a subsequent documentation commit.
- Read [map behavior/API/rollout](../../echo-ai-agent/MAPS.md),
  [chat component contract](../../wdintel-web/src/ts/react/routes/ai-agent-chat/README.md),
  [evaluation instructions](../../ai-eval/2026-09-29-ai-maps/README.md), and
  [control-panel recovery](../../echo-ai-agent/CONTROL_PANEL.md).

On another checkout, fetch and check out `3064-ai-map-response`. Git contains the
implementation, tests, synthetic fixtures, and checksum manifests. It does not
contain the private dataset, run traces, engine credentials, local release
archives, frozen backend executable, or development database.

## What is implemented

The runner builds ordered point-map documents through typed create, append,
publish, list, and get tools. Canonical records stay outside generic response
compaction. Publication is explicit, immutable, and replay-idempotent; unpublished
drafts are discarded after failure/cancellation. Published documents remain with
their request, including cancelled or failed requests.

Current limits differ from the initial plan's 16-record preparation batch:

| Limit | Final value |
| --- | --- |
| Records accepted by one append tool call | 128 |
| Records in one backend preparation batch | 32 |
| Records per document | 512 |
| Documents per request | 16 |
| Comment cells per record | 32 |
| Characters per comment cell | 2,000 |
| Sources per record | 16 |
| Existing event payload limit | 256 KiB |

Append splits preparation into batches internally, preserving order and duplicate
coordinates. It updates the draft only after every batch succeeds and cancellation
is checked. A later-batch failure leaves the whole append safely retryable.
Verbose tables/reports are guided toward about 16 source rows per tool call,
including all events/subgroups; this is guidance, not a 16-record tool limit.
Retrieval uses windows of at most 32 records.

The backend provides pure preparation and guarded retrieval/CSV/KMZ endpoints
under `/api/ai-agent/maps`. Ownership, conversation state, and current access to
every cited source are checked before retrieval/export. Original X/Y values are
retained, using Echo's existing СК-42 conversion for the supplied MSK-2000 pairs.
Invalid components remain CSV rows and are omitted from map/KMZ geometry.
Metadata, warnings, naming/date rules, position priority, SIDCs, comments, and
source citations are covered by the focused contract and evaluations.

`map_artifact` events store full documents and a separate small `map_summary`
atomically. Conversation history and SSE expose summaries, fetching full records
only when needed. The partial event index and separate summary column avoid
reading/detoasting large documents on conversation load.

The chat renders lazy 24 px inline map chips and a 120 px main-map preview.
Selection opens/replaces a map panel, splitting available chat/map space equally
at 1024 px and using a full-height drawer below that breakpoint. It includes
layers, warnings/counts, source chips, record details, and downloads. Invalid
records remain selectable; maps without valid geometry allow CSV and explain
why KMZ is disabled. Draft text and chat scroll survive selection; conversation
changes clear selection, reload restores map summaries, stale loads are ignored,
and API errors use existing toasts.

The composer has a `Зупинити` button that cancels all active queued/running
requests in the current conversation, including after reload or stream failure.
The existing per-request cancellation control remains. Pending cancellations
prevent duplicate calls; failures show a toast and permit retry. Completion races
preserve completed answers, and cancellation retains published maps and draft text.
This uses the existing cancellation endpoint and worker/runner abort path.

Main ownership locations:

- [Runner registry/tools](../../echo-ai-agent/runner/maps.ts).
- [Backend normalization, exports, authorization, and tests](../../wdintel-rs/src/ai_agent/maps/).
- [Central backend configuration](../../wdintel-rs/src/config.rs).
- [Backend binding definitions](../../wdintel-rs/src/elm.rs); frontend bindings
  were generated with `just gen-front`, not handwritten.
- [Migration](../../echo-migration/src/m20260929_152018_ai_agent_map_artifacts.rs),
  registered in migration `lib.rs`, with analytics impact declared as excluded.
- [Chat UI and tests](../../wdintel-web/src/ts/react/routes/ai-agent-chat/).
- [Shared map evaluation](../../ai-eval/2026-09-29-ai-maps/).

## Commits and review

| Commit | Change |
| --- | --- |
| `da3ef30b5` | Initial point-map feature |
| `79bd5079e` | Merged current main |
| `c00158d0f` | Stored summaries separately and added indexed history retrieval |
| `a1756383c` | Increased preparation batches and added composer Stop |
| `df8f39f44` | Accepted bulk appends and split preparation atomically |

PR review comment `4136018183` identified long-conversation full-JSON read cost.
It was addressed in `c00158d0f`; reply `4136124587` records the evidence.
Thread `PRRT_kwDOLaknQ86nNISK` was resolved. A temporary benchmark with 20,000
requests, 400,000 events, and 1,600 map events containing 343 MB of documents
reduced the summary query from approximately 151 ms to 1.3 ms. A regression
checks that history summaries work independently of the full payload.
No other outstanding review feedback was observed at this handoff.

CI snapshot for implementation HEAD, before the archive commit:

- `36607533616`: Pull Request Checkboxes succeeded.
- `36607536105`: CI Build Test and Publish (amd64) still running.
- `36608604175`: another Pull Request Checkboxes run queued.

Recheck CI and reviews on the latest PR head before merging. The PR has not been
merged, and staging/production deployment has not been performed.

## Live failure investigation and capacity fix

The reported conversation was
`01a0ee2d-7ea9-7e53-b2a1-4b8cc455d6a1` on the local development site at
`https://ziggy-dev-echo.atlas-broadnose.ts.net:8300/`.

An earlier request (`01a0ee2d-7ea9-7e53-b2a1-4b950f202100`) failed because the
local runner release 3 did not meet backend-required release 5. Upgrading the
local namespace and restarting managed development services resolved that mismatch.

The subsequent request (`01a0ee32-7fc1-7131-b2a4-468e9238f93f`) initially tried
an 18-record append against the then-16-record tool limit. It recovered using
15 and 10 records, completing at 2026-09-29 17:28:47 UTC with map
`ffd89a25-4d73-4cd0-94d3-ec00e26d271c`: 25 total/valid records, zero invalid.
The progress text's estimate of 20 was inaccurate; the canonical result was 25.

The generic Ukrainian tool-error text hid the schema-limit cause. That generic
tool error presentation in the runner has not been changed. Inspect backend and
runner logs for the actual error rather than inferring it from that progress label.

The first capacity increase used a hard 32-record append limit. Real evaluation
showed that 32 source rows could expand into 33 map records; repeated model
retries still exceeded the limit. The final 128-record tool limit with internal
32-record preparation batches removes that transport constraint from the agent.
A dedicated regression exercises 107 records in one append and atomic failure.

## Verification evidence

The final real-runner evaluation `maps-acceptance-v13` passed **30/30** cases:
three repetitions of seven supplied cases and three synthetic cases. It invokes
production Rust preparation/export routines and parses generated CSV/KMZ.
Verified supplied row counts are 25, 10, 3, 22, 19, 19, and 107. Case 5 has 19 CSV
rows, 17 valid points, and two invalid rows. The 107-row case took approximately
238, 269, and 271 seconds across its repetitions.

- Dataset revision: `2026-09-29.6`.
- Dataset SHA-256: `df630670390d6e9764f1682fb9fbce1963112e87f2d8943cc1fae0742767674d`.
- Runner fingerprint: `c629c0cbe5481550858bebe2a8a901321fb165cb3bc3cf8fa1d1819bbbf9e45f`.
- Frozen backend SHA-256: `bbc0d4cbfd2518d9f5033761c27635162abad59951ab57fd7eba1b72f821d395`.

Earlier runs remain available as evidence: v10 passed 30/30; v11 passed 28/30
and exposed the hard-32 limit. v12 passed 28/30: one export invocation failed
with ENOENT while cargo-watch replaced the executable, and one table repetition
selected the wrong position pair in row 55. v13 used the same final runner with
a frozen backend and passed all cases. These results establish the tested run,
not a guarantee that every future model extraction will be correct.

Recorded checks for the affected implementation:

| Check | Result |
| --- | --- |
| Backend AI-agent tests against restored test databases | 79 passed |
| Runner tests | 56 passed |
| Full harness check (`echo-ai-agent/bin/check.sh`) | Passed, including 61 Python tests |
| Shared evaluation harness tests | 16 passed |
| Affected frontend Vitest | 35 passed |
| Affected map/navigation/citation Playwright | 10 passed, including 320 px layout |
| Full frontend Vitest after main merge | 2,490 passed |
| `cargo check`, Clippy with warnings denied | Passed |
| Formatting, binding generation, `just build-front` | Passed |
| Catalog-aware migration check with restored standard dump, base main | Passed |

The full frontend suite was run before the later Stop/bulk changes; the affected
frontend/browser suites and build cover Stop. The final bulk change only touched
backend/harness code. No DDL changed after the recorded migration catalog check.

Useful repeat commands, after privately restoring the engine/data and test DBs:

```sh
TEST_DB_NAME=wd_test_3064_map_summary_review \
TEST_WDFILE_DB_NAME=wd_files_test_3064_map_summary_review \
cargo test -p wdintel-rs ai_agent --all-features
cargo check -p wdintel-rs --all-targets --all-features
cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings
cargo fmt --all -- --check --config reorder_modules=false
bash echo-ai-agent/bin/check.sh
python3 -m unittest discover -s ai-eval/harness -p 'test_*.py'
just build-front
```

The format option preserves existing module order. Do not introduce unrelated
formatter changes. An empty/default test database is not a valid migration
baseline: the local default `wd_test` was incomplete and failed on missing
`intel_product`. Restore the standard test dump. For changed migrations, use
`deploy/setup_test_database.sh` and the catalog check with `GITHUB_BASE_REF=main`
as required by AGENTS.md; do not edit this already-applied migration.

Final evaluation command on this machine:

```sh
python3 ai-eval/harness/cli.py run --suite ai-maps \
  --engine .dev-runtime/maps-eval-engine.json --run maps-acceptance-v13 \
  --repeat 3 --concurrency 8 --timeout 600 \
  --binary /home/ubuntu/workspace/echo-main/.dev-runtime/maps-eval-backend-2026.09.29.7
```

Use a new run name for new inputs, runner code, or configuration. Snapshots are
immutable. Build/copy a stable backend executable for evaluation rather than
using the executable cargo-watch may replace. Without private inputs, use the
suite's `--split development` option.

## Deployment and immutable release

Release **2026.09.29.7** was packaged from implementation HEAD with 71 tracked
harness files, published through the managed control panel, and installed in
the local namespace. The backend required release and runner/dispatcher pins
match. Older runner compatibility is retained for other namespaces.

| Installation | Recorded runtime | State |
| --- | --- | --- |
| Local `echo-ziggy-dev` | `2026.09.29.7`, two runners | Current |
| `echo-cbr-staging` | `2026.09.29.3`, two runners | Requires matching Echo build before upgrade |
| `echo-cbr` | `2026.09.29.3`, eight runners | Requires matching Echo build before upgrade |

Release bundle digest:
`ee2269e10f2811ed86310b17de21f6d5b269cbc7b95fe827f6ef914f4efc8f62`.
Release tar archive SHA-256:
`80abfc7191bede88fb3d3180147956f24ca391cc001130ce48af896635fc2f89`.

The release directory and archive are immutable. Any further harness changes,
including bundled harness documentation, require a new release after `.7`.
This archive lives outside that bundle and does not require a harness release.
Use the control panel to manage bundles/templates/pins; do not hand-edit the
installed immutable release. Roll out migration and matching backend/frontend
before upgrading each selected idle runner namespace. Do not treat SQL down as
a routine rollback: it removes map events. See the focused rollout contract.

Local services were running in tmux session `echo-main-dev`: `dev-back` pane
`%15`, `dev-bgworker` `%16`, `dev-front` `%17`, and `dev-py` `%18`. Pane numbers
are machine-local and may change. The backend ping was healthy at
`http://127.0.0.1:8081/api/ping`. Use `just dev-tmux-restart` for a managed
restart and `just ai-control-panel scan` to inspect current runner state.

## Files to transfer securely or recreate

These paths are local/ignored and will not arrive with a clone. Transfer only
through an authorized private channel; do not commit their contents here.

| Local path | Purpose |
| --- | --- |
| `/var/tmp/map-data-eval.txt` | Seven supplied source examples |
| `ai-eval/2026-09-29-ai-maps/raw/` | Frozen private input, audit/expectations, runs and traces |
| `.dev-runtime/maps-eval-engine.json` | Private engine settings and credentials; recreate securely |
| `.dev-runtime/maps-eval-backend-2026.09.29.7` | Frozen backend executable used for v13 |
| `.dev-runtime/ai-map-release/2026.09.29.7/` | Read-only release directory |
| `.dev-runtime/ai-map-release/manifest-2026.09.29.7.json` | Per-file release manifest |
| `.dev-runtime/ai-map-release/echo-ai-agent-2026.09.29.7.tar.gz` | Packaged release archive |
| `.dev-runtime/package-map-release.py` | Local packaging helper |
| `.dev-runtime/maps-pr-body.md` | Current detailed PR body |
| `.env` and ignored development configs | Environment credentials; recreate securely |

Each `raw/runs/maps-acceptance-v10` through `v13` directory contains frozen
manifests, results, report, and per-case traces. The final report is
`ai-eval/2026-09-29-ai-maps/raw/runs/maps-acceptance-v13/report.md`.
Tracked `dataset.json` provides checksum verification without exposing private
inputs. Keep failed runs as well as the passing final run.

Final logs under `.dev-runtime/`:

- `maps-eval-acceptance-v13.log`.
- `maps-bulk-harness-check.log`, `maps-bulk-backend-tests.log`,
  `maps-bulk-cargo-check.log`, `maps-bulk-clippy.log`, and
  `maps-bulk-eval-harness-tests.log`.
- `maps-stop-frontend-tests.log`, `maps-stop-browser-tests-v2.log`,
  `maps-stop-citations-browser-tests.log`, and `maps-stop-build-front.log`.
- `maps-bulk-local-upgrade-dry-run.log` and `maps-bulk-local-upgrade.log`.

The last control-panel detailed log was `/tmp/echo-ai-control-panel-j5MSXj.log`;
temporary files may disappear. Test databases
`wd_test_3064_map_summary_review` and `wd_files_test_3064_map_summary_review`
can be recreated from the standard dump instead of transferred.

## Remaining work and continuation constraints

1. Recheck latest PR CI and review feedback, verify claims against the code,
   address applicable feedback, and resolve addressed review threads.
2. Merge/release only through the project's normal approved process. Staging and
   production still need a matching Echo build before runner `.7` rollout.
3. Private evaluation cloud upload is pending write-capable credentials. Existing
   credentials named `LFS_RO` permit retrieval, not publication.
4. GitHub project membership verification could not be completed with the current
   token because it lacks `read:project`.
5. Lines, polygons, and attachment generation remain follow-up work. Improving
   generic tool-error progress text was not included in this implementation.

Completion notifications were already sent for implementation, incident analysis,
and the final capacity/Stop work through the configured Mattermost hook. The
local marker `.dev-runtime/maps-stop-completion-notification-sent` prevents
resending that completion. This archive task uses a separate notification marker.
