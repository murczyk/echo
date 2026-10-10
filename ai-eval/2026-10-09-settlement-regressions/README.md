# Settlement regressions — #3383

`messages.json` contains the nine exact original message bodies linked in
`idea.md`, captured read-only from `echo-kharkiv2`. Case numbers match that
file. Production messages, saved locations and links were not repaired.

`expected_ai_settlements` preserves source spelling and order, including
misspellings. `expected_rust_settlements` describes catalog-backed header
extraction in the captured AOR. Canonical PostgreSQL resolution is a separate
boundary. `original_location_v2` records the observed result.

Case 2 has no linked message. `controls.json` and the Rust regressions cover
both old/new spellings, genuine Українка and Південне mentions, three-word
names, source-post/callsign/dialogue exclusions and forest boundaries.

Case 10 names two forests: «ліс Верхнє Горіхове-ліс Заливний». The AI retains
ВЕРХНЄ ГОРІХОВЕ and ЗАЛИВНИЙ as full location text with undefined settlement
links. Neither name is in the settlement catalog; matching ГОРІХОВЕ from the
forest phrase or creating fictitious settlement rows would be incorrect.
New link rows start pending; the settlement worker marks them undefined
after catalog resolution. An independently mentioned н.п. Горіхове remains
recognizable.

`baseline-prompt.txt` is the exact effective saved prompt override;
`baseline.json` records the engine and dictionary selection. AOR 2 uses the
server default: Харківська, Донецька, Луганська and Білгородська. Курська is
absent: ГОПТАРОВКА and КОНДРАТОВКА remain text without catalog candidates,
rather than being replaced by similarly spelled names in another region.
These artifacts contain no engine credentials.

The old/new prompt results are saved separately in `baseline-results.json`
and `revised-results.json`, with corresponding `*-controls-results.json`.
These are live `glm-5.3` responses, not expected-response mocks. The original
Rust parser reproduced all nine reported failures; the original AI prompt
passed eight reported cases, omitting ЗАЛИВНИЙ, and five of seven controls.
The revised prompt passed all nine reported cases and all seven controls;
`evaluation.json` records the engine, counts and prompt hashes.
Thus most reported errors were Rust/catalog errors, while forest extraction
and source spelling also required prompt changes. AI evaluation is a sampled
quality check, not a guarantee of deterministic responses.

To repeat the AI evaluation from an environment allowed by the inference
provider, supply a private token file; no token is written to the result:

```sh
python3 ai-eval/2026-10-09-settlement-regressions/evaluate.py \
  --prompt ai-eval/2026-08-28-settlement-prompt/prompt.txt \
  --token-file /private/path/token --output /tmp/settlement-results.json
```

Add `--fixtures ai-eval/2026-10-09-settlement-regressions/controls.json` for
the controls, or use `baseline-prompt.txt` to reproduce the old prompt.
Each request uses the worker's 300-second timeout. HTTP/parse errors are
recorded per case, separately from extraction mismatches.

The operational regression entry points are:

- `wdintel-rs/src/unit/parser.rs`: `settlement_header_regressions_3383`.
- `wdintel-rs/src/location/mod.rs`: `settlement_context_and_spellings_3383`.
- `wdintel-rs/src/battle_line/mod.rs`: rename resolution and migration safeguards.
- `wdintel-rs/src/ai_settlement/worker.rs`: transactional append/reconciliation,
  including unchanged results, forest text, stale-result rejection and retries.
- `wdintel-rs/src/battle_line/settlement_queue.rs`: pending renamed aliases
  resolve to legacy SQL IDs; forest names become undefined and retain their
  text and link identity across reconciliation retries. Reconciliation locks
  existing links in ID order, so removing a concurrently resolved row still
  invalidates group statistics.

The #3383 parser fixtures also preserve army/corps suffixes before hyphenated
location lists and complete catalog names containing context/country words,
including Лесной, Нова Україна, Вільна Україна and Рідна Україна. Bare country
names remain excluded. A named forest ends at an explicit settlement marker
or phrase separator; a hyphen within its name does not expose a partial
settlement match.

## Dictionary generation

`milgeo-settlement-names.patch` contains the generator/input change for the
owning `milgeo-rs` project, based on revision `b0e5d90`. The rename pairs
are listed in the [parliamentary committee record](https://komsamovr.rada.gov.ua/meeting/stenogr/print/4220.html)
for [Resolution 4483-IX](https://zakon.rada.gov.ua/laws/show/4483-20).
Alias insertion preserves any existing upstream entry with the same name.
Apply the patch there and run:

```sh
cd overpass_geojson_data_gen
mkdir -p out
cargo run -p overpass-geojson-data-gen
```

The generated `out/kharkivska_oblast.json` and `out/settlements.json` are
installed in `wdintel-rs/data/`. Compared with the prior artifacts, each has
exactly five added entries and no removed or changed rows: Анищине, Іващине,
Рибалкине, Рибалчине and operational spelling Рибалкіне. Existing IDs and
coordinates are retained for old/new physical aliases. JSON IDs are separate
from PostgreSQL IDs; coordinate resolution maps all variants to legacy SQL
IDs 79948, 98911 and 65447.

## Rollout and recovery

1. Back up the current effective settlement prompt, engine/enabled settings
   and both installed dictionaries. Apply
   `m20261009_144937_settlement_renamed_names` through the normal migration
   command. It only adds three catalog names, preserving legacy rows and
   references. Existing identical names in the same administrative area are
   skipped; a reserved-ID collision fails instead of overwriting data.
2. Install the corrected code and regenerated dictionaries, including both
   `/etc/echo/settlements_json/kharkivska_oblast.json` and the legacy
   `/etc/echo/settlements.json`. Restart affected ECHO processes so their
   in-memory dictionaries and compiled fallback are refreshed.
3. In **Admin → AI settlements**, inspect the effective prompt. For the
   captured unchanged override, use **Reset prompt** to adopt the reviewed
   compiled fallback, or paste/save `../2026-08-28-settlement-prompt/prompt.txt`.
   Reconcile unrelated custom prompt changes manually. Prompt save/reset
   preserves worker engine/enabled settings; reset clears obsolete admin
   evaluation results, not inbox messages. Verify the effective prompt after
   saving.
4. Keep AOR selections unchanged for this rollout. Replay these fixtures in
   tests/admin evaluation and verify subsequent new messages. Changing AOR
   selections can enqueue historical reconciliation, so it is outside this
   no-repair rollout. Do not run historical reparse/relink commands.
5. Confirm the inserted catalog rows reach analytics through normal CDC and
   run the deployment's analytics health check. This is a data-only migration
   with an empty analytics `changes` declaration; no schema resync is needed.

For recovery, restore the saved prompt/code/dictionaries and restart affected
processes. Migration `down` intentionally leaves catalog enrichment in place:
rows may have existed before migration or acquired message references. Do
not delete them or rewrite message history during rollback.
