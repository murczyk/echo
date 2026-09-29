# Homepage point-map evaluation (#3064)

This suite uses the shared harness category `map-documents`. It exercises the
actual Pi runner and typed map tools. Preparation and CSV/KMZ export invoke
`wdintel-rs ai-eval-maps`, which calls the production Rust routines. The fixture
transport supplies these pure endpoints without writing conversations or maps
to a running Echo instance. Existing search/citation categories stay unchanged.

`cases.json` contains synthetic development fixtures for multiple batches,
coincident events, malformed coordinates, no geometry, date rules, escaped
metadata, position priority, and main/submap publication. Supplied production
inputs, independently extracted expectations, and all run traces stay under
ignored `raw/`. Do not put their contents in commits or PR comments.

## Capture and independent audit

```sh
python3 ai-eval/2026-09-29-ai-maps/capture.py /var/tmp/map-data-eval.txt
python3 ai-eval/harness/cli.py validate --suite ai-maps
```

Capture refuses to replace differing immutable artifacts. The manifest records
SHA-256 checksums for the input, private cases/audit, and tracked synthetic cases.
The audit independently extracts event order, unit hierarchy, dates, and position
priority and compares the supplied CSV core fields. Coordinate expectations use
the existing frontend СК-42 converter, independently of the backend PROJ routine.

Verified row counts are 25, 10, 3, 22, 19, 19, and 107. The table has two extra
subgroups within numbered rows and a record with no supplied unit name. Case 5
has 19 CSV rows, 17 valid points, and two six-digit Y components; no digits are
invented. Supplied output for that case does not contain a usable CSV, so its
expectations come directly from input. Original values remain in the document.
The audit also checks unused table positions against the input: one supplied CSV
comment changed an eight-digit component. Expectations retain the original
component in comments, and selected coordinates need not be repeated there.

## Run and grade

Build the backend first. Supply a private engine JSON using the existing
[shared harness](../HARNESS.md) contract; keep credentials out of git.
On a checkout without private data, use `--split development` for validation and
runs; it verifies the tracked synthetic fixtures and does not load `raw/`.

```sh
cargo build -p wdintel-rs
python3 ai-eval/harness/cli.py run --suite ai-maps \
  --engine /private/engine.json --run maps-acceptance-v1 \
  --repeat 3 --timeout 600
python3 -m unittest discover -s ai-eval/harness -p 'test_*.py'
```

Each run freezes its runner and dataset fingerprint under `raw/runs/<run>/`.
Reusing a run name with different inputs is rejected. The grader verifies every
ordered record, SIDC/name/date/platform metadata, original and normalized
coordinates, independent WGS-84 positions, invalid-row warnings/counts, preserved
comment values, registered map references, and 1–32 record preparation batches.
It parses the production CSV and KMZ, including padded comments, placemark
geometry, explicit SIDC metadata, escaping, styles, and embedded icons. Zero
valid records must produce CSV and no KMZ. Selected coordinates need not also
be duplicated in comments; unselected positions must be retained.

Cloud publication of ignored artifacts uses the repository's LFS workflow and
requires write-capable credentials. `LFS_RO` credentials can retrieve artifacts
but cannot publish this dataset. Keep local frozen inputs/runs until an authorized
write credential is available. The checksum manifest supports later retrieval
and verification without exposing operational contents.
