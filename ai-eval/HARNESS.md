# Harness evaluation workflow

`catalog.json` groups evaluation collections by stable category. Existing dated
corpora retain their paths, commands and B2 prefixes. `callsign-search` is the
first suite using the shared harness runner.

```sh
just ai-eval list
just ai-eval-sync-from-cloud 2026-09-28-callsign-search
just ai-eval validate --suite callsign-search
cargo build -p wdintel-rs
cd echo-ai-agent && npm ci --ignore-scripts
```

Run the remaining commands from the repository root. Use a private engine JSON
file with `url`, `model_name`, and optional `token`; never commit it. Optional
runtime fields are `contextWindow`, `maxTokens`, `compactionReserveTokens` and
`compactionKeepRecentTokens`. Fixture searches need a local PostgreSQL connection:
set `fixturePsql` to an argument array such as `["psql", "-d", "postgres"]`.
Normal libpq environment variables and `.pgpass` work. On this development host,
`["sudo", "-n", "-u", "postgres", "psql", "-d", "wd"]` is also supported.
Every fixture SQL transaction is read-only; no application tables are modified.

```sh
just ai-eval run --engine /private/sol.json --run candidate-sol --repeat 3
just ai-eval run --engine /private/luna.json --run candidate-luna --repeat 3
just ai-eval run --engine /private/sol.json --run baseline-sol \
  --runner-ref <commit> --repeat 3
just ai-eval compare \
  ai-eval/2026-09-28-callsign-search/raw/runs/baseline-sol/report.json \
  ai-eval/2026-09-28-callsign-search/raw/runs/candidate-sol/report.json
```

Use `--case <id>` repeatedly or `--split development|validation` for a narrower
run. Development runs and `validate --split development` verify tracked fixtures
without requiring private `raw/` artifacts. Full/validation runs require every
declared checksum. The defaults are three repetitions, two concurrent workers, and a 300-second
deadline per case. Runs are immutable: choose a new `--run` name for every attempt.
Exit codes are 0 for all hard checks passing, 1 for observed case failures, and 2
for invalid configuration or infrastructure errors. Partial traces remain on
disk when individual cases fail; do not hide failed repetitions.

## What runs

Each isolated Node worker imports the real runner and executes its Pi agent loop.
Only HTTP transport is injected: tool requests operate on frozen authorized
records, and provider requests go to the configured engine. Historical commits
use their original runner sources. Current sources are snapshotted before a run,
so editing the checkout cannot change its later repetitions.

`wdintel-rs ai-eval-search-query` compiles requests using the production search
parser and filters. The fixture transport runs that SQL over read-only CTEs in
PostgreSQL, including the real stemming and prefix behavior. It applies the
fixture's group scope, dates and cursors before returning standard inbox pages.
Unsupported fixture routes fail visibly. The initial suite deliberately supplies
the current-user, inbox, message-ID and context tools; local integration uses the
installed harness's complete tool inventory. Fixture authorization is synthetic;
it does not replace backend authorization tests or authenticated integration.

The [point-map suite](2026-09-29-ai-maps/README.md) uses the same runner with
pure production Rust preparation/export endpoints. Its private supplied inputs
are independently audited; grading checks ordered records, map references,
coordinate warnings, and parsed CSV/KMZ. Its scores use fixture mode, with
ownership and revoked-source checks covered separately by backend regressions.

Reports include category and per-case results, latency, provider token usage when
available, prompt hashes, runner identity, dataset checksums, tool errors and
private traces. Comparisons require the same dataset, mode, cases and repetitions;
changes to engine or runtime profile are printed explicitly. Scores describe
this small regression suite, not general model accuracy.

## Grading and review

Hard checks cover both independent search paths, required evidence, registered
citations, inaccessible evidence, date restrictions and complete pagination when
requested. Add `--judge-engine /private/judge.json` to grade groundedness,
usefulness, ambiguity and unnecessary clarification. The judge sees retrieved
evidence and the answer, with no candidate engine label. Its verdict and rubric
hash are retained; judge errors are recorded, and judge scores never override a
failed hard check. Human reviewers should read representative answers against
their traces and record disagreements before trusting judge scores.

## Unit search suite

`2026-10-10-unit-search` covers unit/formation questions where the unit lives in
message metadata, not in the text. Fixture messages may carry `unit` (header
string) and `unitIds`; cases may list `units` for the unit lookup route. The
`unitSearch` expectation requires a unit-only inbox request. The private
`raw/cases-v1.json` is captured by `capture.py` (read-only over ssh). To score a
runner that predates `unit_lookup`, pass `--exclude-skill unit_lookup`.

## Group scope suite

`2026-11-06-group-scope` covers requests naming a source group: a chat, channel or
group must be read alone, and a group name used as a subject must not become a
scope. Everything in it is synthetic, written by `build_cases.py`, because the
check is about what was asked of Echo, not about message content. Regenerate the
cases and checksum with that script rather than editing `cases.json`.

Cases give each key a display name in `groupNames`, since real keys reveal nothing.
`expect.groupScope` accepts `{keys}`, `{keys, all: true}` when every key must be
read, `{keys, optional: true}` when clarifying without reading is acceptable, and
`{forbid: true}`. It judges the request as well as the results, so a guessed value
fails even when the fixture returns nothing:

- `group_scope_not_applied`: no scoped read, or a read outside `keys`.
- `group_scope_incomplete`: `all` was set and a key was never selected.
- `out_of_scope_retrieval`, `out_of_scope_citation`: a message from another group
  was read or cited.
- `group_scope_applied_to_subject`: a `forbid` case was scoped.

Add `executionPolicy` to the private engine file to run the bounded-research loop
that GLM-5.3 and Gemma use in production; `provider-failure-then-retry` needs it.
Use the production policy with `--timeout` above its `maxRuntimeSeconds`. The fixture
matches current production, where an unmatched selection finds nothing. To reproduce
the widening from before #4053, score the older runner with
`--runner-ref <commit> --legacy-group-fallback`:

```sh
just ai-eval run --suite group-scope --engine /private/glm.json \
  --run baseline --runner-ref <commit> --legacy-group-fallback --repeat 3 --timeout 700
just ai-eval run --suite group-scope --engine /private/glm.json \
  --run candidate --repeat 3 --timeout 700
```

`compare` prints a changed fallback or execution policy, so the comparison above is
explicit about which behaviour each side ran. Local mode needs captured real cases,
so this suite is fixture-only.

## Local integration

Local mode accepts only captured real cases and a loopback HTTP backend. Add
`localLogin` naming an authorized local test user to the private engine file;
`localBaseUrl` defaults to `http://127.0.0.1:8081`. It uses the local checkout's
private config, PostgreSQL (`pg_dbname` in `deploy/config.toml`) and Redis to create a short-lived session, invokes
normal authenticated chat APIs, and removes the session afterward. Local chat
notifications are temporarily disabled under an evaluation lock and restored
in `finally`, preventing benchmark prompts from reaching the chat channel.
The integration checker uses delivered citation events and real request states;
its results are reported separately from frozen-fixture scores.

```sh
just ai-eval run --mode local --engine /private/sol.json --run local-sol \
  --case bek-production-regression --repeat 3
```

## Adding cases

Add a dated dataset directory, a catalog entry, and a versioned `dataset.json`.
Its `caseFiles` must all appear in the SHA-256 `artifacts` map. Cases contain an
ID, category, development/validation split, fixed `asOf` time, authorized groups,
conversation turns, fixture messages, and explicit `expect` criteria. Each
message has a numeric ID, UID, timestamp in milliseconds, group key, parsed body
text, and extracted callsigns; `indexed: false` models a missing index entry.

Keep related paraphrases and source messages in the same split. Put synthetic
cases in Git; production-derived messages, expected IDs, answers and reviews
belong in gitignored `raw/`. Preserve source provenance and review expected
evidence independently of the model. Revise private artifacts under new names,
bump the dataset revision and update checksums; never overwrite synced objects.
Old run directories contain their cases and manifest for audit.

The first corpus's `capture.py` captures only the reviewed local-clone regression
and refuses to overwrite it. Synchronize the corpus and raw runs with:

```sh
just ai-eval-sync-to-cloud 2026-09-28-callsign-search
python3 -m unittest discover -s ai-eval/harness -p 'test_*.py'
```

The SQL regression checks require the built binary and local PostgreSQL. They
exercise the production parser over bounded fixtures without calling a model.
