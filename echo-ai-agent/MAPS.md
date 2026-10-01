# Point-map documents

Homepage answers can publish a main point map and separate submaps. Registered
`[мапа](echo-map:<uuid>)` links render a chip with a 24 px thumbnail; the latest
published main map in each answer also has a preview card with its most frequent
symbols. Either opens the map workspace. Selecting another map replaces it
without changing the draft or chat scroll. Reload restores documents and
changing conversations closes the workspace.
Published maps with no prose reference remain available as chips, including
submaps retained after a failed or cancelled response.

From the Echo 1024 px breakpoint the workspace is map-first: chat docks to a
420 px column on the left, the map fills the centre and a collapsible inspector
sits on the right. Smaller screens use a full-height drawer with the inspector
below the map. The top bar holds the editable title, counts, undo/redo, the
revision history, CSV/KMZ export and close. Markers are APP-6(D) symbols drawn
with milsymbol; records sharing exact coordinates fan out so each stays
clickable. Click selects one record, Ctrl/Cmd/Shift-click toggles, and
Shift-drag selects with a box. Records changed by the latest revision pulse
briefly.

The inspector lists records grouped by symbol, with a text filter and a
show/hide toggle per group; a group header selects all its records. The
selection tab shows the record details and a symbol editor: affiliation,
symbol type (searchable by Ukrainian aliases and English catalog names), status
and echelon. Applying changes only the edited SIDC components of every selected
record, as one revision. Delete/Backspace inside the workspace removes the
selection and offers undo; Ctrl/Cmd+Z and Ctrl/Cmd+Y (or Shift+Z) undo and redo
outside text fields. Escape closes the workspace, also while it is loading.
Failed retrievals and downloads show toasts; KMZ is disabled when no record has
geometry.

While a map is open the composer shows «Редагую: …» with the selection count.
Only then does a chat request carry the map, its revision and the selected point
ids, so the agent can edit it; clicking the chip switches to asking questions
without edits. With a selection, prompt starters prefill the draft.

## Runner and persistence

`echo_map_create` prepares a draft with a title and `isMain` flag.
`echo_map_append` accepts 1–128 ordered records per call and automatically splits
preparation into batches of at most 32. All batches must succeed before the draft
changes; a failure or cancellation leaves the entire append retryable without
duplicate records. Verbose tickets/tables use about 16 source rows per call,
including every event/subgroup in those rows. Echo's preparation API is pure.
Canonical records live in a registry outside generic response compaction.
Tool results contain a reference, counts, and warnings. Repeated coordinates
remain separate events. A document is limited to 512 records and a request to
16 documents and 32 comment cells per record; the existing 256 KiB event limit
also applies. Tickets with more fields must combine fields in cells, preserving
all values rather than dropping fields to meet the cell limit.

When the request names an open map, `echo_map_edit` applies one atomic patch to
it and saves the result as a new revision. The tool is registered only for that
editing target. Operations are `add`, `update`, `remove`, `setComponents`,
`setSidc` and `setTitle`; selectors use ids, exact names, a SIDC, `all`, or the
user's selection. The result returns counts and at most 32 detailed changes,
not the document, and the runner drops removed ids from its selection.
`echo_map_get` reads the current revision of every map. A retried call reuses its
idempotency key and returns the stored result; a stale expected revision is
rejected and writes nothing. A new point needs explicit coordinates or exactly
one unambiguous accessible source that already contains the location. An
ambiguous name is clarified instead of guessed. Component edits preserve every
component that was not supplied; a full 20-digit SIDC may still replace the
symbol. Either removes the missing-SIDC warning.

`echo_map_script` runs a short agent-written Python script with the
[`echomap` library](template/python/echomap/__init__.py) instead of having the
model type every record. The script sees the prompt and the full text of
messages retrieved in this request, parses them (`parse.split`, `parse.kv`,
`parse.pair`, `parse.dt`), chooses symbols (`sidc.find`, `sidc.set`,
`sidc.retype`, `sidc.describe`) and either emits records for a draft or edits the
open map (`current_map`, `emit_patch`, saved as one revision of up to 512
operations). Emitted values go through the same preparation and patch code as
the other tools. Comments are copied from parsed source blocks, so long tickets
are not retyped. The runner executes the script with `python3 -I` in separate
user, network, mount and PID namespaces: the work directory becomes `/dev/shm`
with the library bound read-only, `/tmp`, `/var/tmp`, `/run` and `/proc` are empty
tmpfs mounts (hiding the runner's credential files and processes), and
`run.py` drops every capability before user code runs. The environment is clean,
with a 30 s wall clock, CPU/memory/file limits and capped output; timeout or
cancellation kills the whole PID namespace, including subprocesses.
The tool is not registered when the library is missing or namespaces are
unavailable; the template build warns in that case. A failed script returns its
traceback for the agent to fix.

### Reliability on small models

Small models (Gemma 4 26B on staging) struggled with nested edit operations and
free-form scripts, so the runner adds simpler paths and checks:

- `echo_map_from_reports {id, symbol?}` fills a draft from a known report format with no
  model-written code. [`echomap.recipes`](template/python/echomap/recipes.py)
  currently recognizes «Детали полета» UAV flight reports: one record per
  report, unit name from the smallest unit to the regiment without divisions,
  event date/time (the posting header or the message's Kyiv date fills a
  missing `Дата`), target coordinates as written (malformed components are
  kept for validation) and the full report as comment. A SIDC in the report is
  kept; `symbol` (a SIDC or words such as «дружній БпЛА») applies to the rest.
  Units keep qualifiers («104 гв. дшп»); without a unit field, unit
  designations from the posting header are used; operator callsigns and
  poster names are never used as names. A block counts
  as a report only when it has report fields, not when a sentence merely names
  the format. Its `sourceCount` becomes the expected record count for that
  draft. When the prompt contains such reports, the system prompt names their
  count and the recipe tool, and a failed script repeats that hint.
- `echo_map_set_symbol {target, sidc | type/identity/status/echelon}` changes
  symbols in one flat call; `type` is resolved through the APP-6(D) catalog by
  [`sidc-resolver.ts`](runner/sidc-resolver.ts). A target given as a point name
  must match exactly one point; otherwise Echo asks to clarify.
- Tool arguments are normalized before validation (`prepareArguments`):
  special tokens such as `<|"|>` are stripped and stray `key: value` strings are
  lifted out of operation arrays. Edit operations infer a missing or misnamed op
  (`retype`, `setComponents` with only a SIDC) and errors are Ukrainian with a
  valid example.
- Every script run reports the known report formats it detected. Publishing a
  draft whose record count differs from the detected reports is refused until
  the agent passes `confirmMismatch` with a reason; a draft linked in the answer
  is not auto-published in that case and the answer says so.
- After the answer, the runner checks outcomes: failed edit calls are counted
  from the tool lifecycle (including calls rejected during argument
  validation); when an editing request saved no change, it asks the model once
  to restate the answer truthfully, with the usual citation checks, and
  otherwise appends «⚠️ Зміни до мапи не збережено.»; a published count
  mismatch is always appended as a notice.
- Failed map tools show a fixed category in the activity list (invalid
  parameters, conflict, script error, invalid symbol, unknown point) instead of
  the generic loading message; the raw error is never shown there.

`echo_map_publish` explicitly seals a nonempty document and emits `map_artifact`.
The backend recomputes normalization, projection, warnings, and counts from the
original values before writing the event. Identical replays are idempotent;
published IDs cannot be changed. Drafts are discarded on failure/cancellation.
An event committed before cancellation remains with its request, including
failed/cancelled requests with no answer text.

Conversation responses and runner history contain summaries, with empty defaults
for old conversations. Browser event replay also exposes summaries, never the
full records. Each event stores its summary atomically in a separate nullable
`map_summary` column. History selects this column through the partial map-event
index, avoiding full-document JSON reads when opening long conversations.
`echo_map_list` recovers references after compaction;
`echo_map_get` retrieves records in windows of at most 32, including published
maps from previous conversation turns. Full documents are fetched only when
needed. Optional source citations must come from retrieved message citations.

## API and exports

Map endpoints accept POST JSON and require a login:

| Endpoint | Body | Result |
| --- | --- | --- |
| `/api/ai-agent/maps/prepare` | `{records: [...]}` | Normalized records with new ids; no database writes |
| `/api/ai-agent/maps/get` | `{requestId, mapId, revision}` | Current revision, or the named one |
| `/api/ai-agent/maps/csv` | same identity | Quoted UTF-8 CSV of the current revision |
| `/api/ai-agent/maps/kmz` | same identity plus `icons` | KMZ containing `doc.kml` and SIDC icons |
| `/api/ai-agent/maps/workspace` | `{requestId, mapId}` | Current document, history flags, latest changes, revision list |
| `/api/ai-agent/maps/edit` | expected revision, idempotency key, optional summary, operations | Compact diff of the new revision |
| `/api/ai-agent/maps/undo` | `{requestId, mapId, expectedRevision}` | Workspace at the parent revision |
| `/api/ai-agent/maps/redo` | same | Workspace at the newest child revision |

Opening the workspace creates the editable map on first use, storing the
published artifact as revision 1 (legacy records receive their deterministic id
then). Reading or exporting never creates it: without one, `get` and exports
return the published artifact. Every edit appends a revision with its parent,
origin (`artifact`, `agent` or `user`), request and summary, and moves the head.
Undo moves the head to the parent; redo follows the newest revision created on
the current head, so editing after undo starts a new branch while older rows
remain. Writes lock the map row; a mismatched expected revision returns HTTP 409
with the current revision and writes nothing. A patch that changes nothing
creates no revision. Published `map_artifact` rows stay unchanged; chat previews
show the current revision.

The editable map belongs to the human and the source conversation, and is
deleted with them. Managed runner accounts can prepare, read and edit only the
map their request declared as target; the workspace, undo, redo and downloads
require a human login. Retrieval and both downloads check request ownership, a
nondeleted owned conversation, and current access to every cited source and its
exact identifier. Revoking source access therefore blocks the document and both
exports. Downloads use `private, no-store` and an attachment filename containing
the document UUID.

Records retain a stable id, supplied SIDC, name, observation datetime, coordinate
system, original X/Y, normalized X/Y, WGS-84 latitude/longitude, comments,
optional sources, and warnings. The id does not follow coordinates or array
position. Legacy records receive a deterministic id the first time the panel
opens them, and that id is stored. CSV does not include it. Workspace edits
recompute coordinates only for an added record or a coordinate change. Untouched
coordinates, comments, sources, order, duplicate coordinates, and invalid rows
stay as stored. Supplied MSK-2000 pairs use the same Krassovsky/transformation
parameters as Echo's existing СК-42 conversion. Supported labels are `msk2000`,
`msk-2000`, `мск-2000`, `sk42`, and `ск-42`; these pairs are not USK-2000.
Coordinate separators are removed without supplying digits. Components other
than seven digits become `INVALID`. Projection failures have no geometry;
coordinates outside the expected Ukraine bounds retain geometry with a warning.

Extraction preserves input order, supplied SIDCs and exact naming overrides.
Unit names run from the smallest unit to the regiment without mission text or
invented missing units. Event dates/times take precedence over posting headers;
a header supplies the date only when absent in the event. A date without time
uses `T00:00:00`, no date uses an empty CSV cell, and time alone supplies no date.
Table position priority is real, changed, previous; other positions and columns
remain in comments. Comment normalization removes double/typographic quotes and
collapses whitespace.

CSV begins with `sidc,name,observation_datetime,platform_type,x,y`, followed by
`comment 1` through the maximum comment count, padded with empty cells.
`platform_type` is `CAPDOC`. Every cell is quoted, and every row is retained.
KMZ includes only valid records, with longitude/latitude geometry, escaped
metadata, observation time, platform, original coordinates, and comments.
`sidc`, `app6d`, and `app6d sidc` explicitly retain the SIDC. Styles follow the
existing normal/highlight SIDC icon conventions. The browser renders each
distinct SIDC to PNG with milsymbol and sends it with the KMZ request
(`icons`, at most 512, 64 KiB each, PNG signature checked). Without a rendered
icon KMZ embeds the packaged PNG when one exists and otherwise an
identity-colored PNG. A record with no SIDC is stored as `10061000001211020000`
with a warning; a non-empty value that is not 20 digits is rejected. Citations
that were not retrieved are omitted. Unpublished tool results do not include the
markdown link. A successful answer that links a nonempty draft publishes that
draft; links to empty or unknown drafts are removed.

Symbol names come from the generated
[APP-6(D) catalog](../scripts/symbology/README.md), shared by the map UI and the
`echomap` library. Lines, polygons and attachment generation are follow-up work.attachment generation are follow-up work.

## Rollout

Release `2026.09.29.8` requires migration
`m20260929_152018_ai_agent_map_artifacts` and the matching backend/frontend.
That migration extends the request-event constraint and adds the summary column
and partial index. It remains required. Release `2026.10.01.5` adds map editing
and scripts and also requires `m20260929_195200_ai_agent_map_workspace`
(`ai_agent_map`, `ai_agent_map_revision`, `ai_agent_request_map_target`). Deploy
the migrations and Echo build, restart backend/workers, then upgrade the selected
idle namespace. Do not run the `2026.10.01.5` runner against an older backend. Until the namespace is upgraded, chat requests fail with «ШІ-агент оновлюється. Повторіть запит за кілька хвилин.»; upgrade the namespace right after restarting the backend.
Runners `2026.10.01.1`–`.4`, `2026.09.29.8` and `.9` remain in the compatible set. The map tables are excluded
from analytics replication; the migration impact manifest and
`deploy/clickhouse/env/tables-exclude.txt` both record that exclusion.

```sh
just ai-control-panel upgrade --host local --release 2026.10.01.5 --dry-run
just ai-control-panel upgrade --host local --release 2026.10.01.5
```

Replace `local` with each explicitly selected installation. The
[control panel](CONTROL_PANEL.md#upgrade-and-recovery) stores immutable bundles
and previous templates. Rescan after upgrading, publish a map with one invalid
row, reload the conversation, and inspect both downloads before expanding rollout.
Recover from the retained bundle/template if needed; keep the event migration
and published documents. Its SQL down migration deletes map events and is not a
routine harness rollback. Backend release pinning must match the recovered runner.

## Verification

The shared [map evaluation](../ai-eval/2026-09-29-ai-maps/README.md) runs the real
runner and production Rust normalization/export routines against three synthetic
cases and seven privately captured examples. Regression coverage is maintained in:

- `echo-ai-agent/runner/maps.test.ts`
- `echo-ai-agent/runner/map-script.test.ts`
- `echo-ai-agent/tests/test_echomap.py`
- `wdintel-rs/src/ai_agent/maps/edit.rs`
- `wdintel-rs/src/ai_agent/maps/workspace.rs`
- `wdintel-rs/src/ai_agent/maps/tests.rs`
- `wdintel-rs/src/ai_agent/bootstrap_tests.rs`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/maps.spec.tsx`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/map-markers.spec.ts`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/map-symbol.spec.ts`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/src/ts/react/services/api/__tests__/ai-agent.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-maps.spec.ts`
