# Point-map documents

Homepage answers can publish a main point map and separate submaps. Registered
`[мапа](echo-map:<uuid>)` links render a chip with a 24 px thumbnail; the latest
published main map in each answer also has a 120 px preview. Either opens that
document. Selecting another map replaces the panel without changing the draft
or chat scroll. At the Echo 1024 px breakpoint the available chat/map space is
split equally; smaller screens use a full-height drawer. Panel selection is
local to the current view. Reload restores documents and changing conversations
closes the panel.
Published maps with no prose reference remain available as chips, including
submaps retained after a failed or cancelled response.

The panel provides base-layer selection, record counts, coordinate warnings,
record details and source chips, and a CSV/KMZ menu. Invalid rows remain available
in the record selector. CSV remains available when there is no geometry; KMZ is
disabled with an explanation. Failed retrievals and downloads show existing
toasts. Escape closes the panel and returns focus to its opener; an open menu
handles Escape first.

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

All four endpoints accept POST JSON and require a login:

| Endpoint | Body | Result |
| --- | --- | --- |
| `/api/ai-agent/maps/prepare` | `{records: [...]}` | Normalized records; no database writes |
| `/api/ai-agent/maps/get` | `{requestId, mapId}` | Full published document |
| `/api/ai-agent/maps/csv` | `{requestId, mapId}` | Quoted UTF-8 CSV |
| `/api/ai-agent/maps/kmz` | `{requestId, mapId}` | KMZ containing `doc.kml` and SIDC icons |

Managed runner accounts can call only preparation/retrieval through the route
registry and their active request credentials. Downloads require a human login.
Retrieval and both downloads check request ownership, a nondeleted owned
conversation, and current access to every cited source and its exact identifier.
Revoking source access therefore blocks the document and both exports. Downloads
use `private, no-store` and an attachment filename containing the document UUID.

Records retain supplied SIDC, name, observation datetime, coordinate system,
original X/Y, normalized X/Y, WGS-84 latitude/longitude, comments, optional sources,
and warnings. Supplied MSK-2000 pairs use the same Krassovsky/transformation
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
existing normal/highlight SIDC icon conventions. If a supplied valid SIDC has no
packaged icon, its metadata remains intact and its image uses Echo's existing
fallback infantry icon in both the panel and KMZ. The supplied delivery and
assault SIDCs have packaged SVG/PNG assets generated with
[milsymbol 2.2.0](https://github.com/spatialillusions/milsymbol/tree/v2.2.0),
using `new ms.Symbol(sidc, {size: 100}).asSVG()` and transparent PNG rendering.
The asset directory includes the renderer's MIT license. Lines, polygons and
attachment generation are follow-up work.

## Rollout

Release `2026.09.29.7` requires migration
`m20260929_152018_ai_agent_map_artifacts` and the matching backend/frontend.
Deploy the migration and Echo build, restart backend/workers, then upgrade the
selected idle namespace. Do not run the new runner against an older backend.
The migration extends the request-event constraint and adds the summary column
and partial index. This table is excluded from analytics replication, as declared
in the migration impact manifest.

```sh
just ai-control-panel upgrade --host local --release 2026.09.29.7 --dry-run
just ai-control-panel upgrade --host local --release 2026.09.29.7
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
- `wdintel-rs/src/ai_agent/maps/tests.rs`
- `wdintel-rs/src/ai_agent/bootstrap_tests.rs`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/maps.spec.tsx`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/src/ts/react/services/api/__tests__/ai-agent.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-maps.spec.ts`
