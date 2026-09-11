# RER Palitra Delta Split Download Handover

## User Report

- Page: `https://echo-cbr.raptor-tench.ts.net/rer-palitra-neo`
- Remote host: SSH alias `echo-cbr`, hostname observed as `ct-echo-cbr`
- Symptom: downloading a palette "as is" works, but enabling `Розбити по 6500 точок (для Дельти)` downloads an empty archive.
- Local repo at start of investigation: `/home/andrii/.workspace/echo`, branch `main`, initially clean.
- No remote data or service changes were made during investigation. Only read-only SSH/SQL inspection was performed.
- Do not paste `/etc/echo/config.toml` values into notes or chat; it contains live secrets.

## Reproduced Data Shape On CBR

The deployed service is `wdintel-rs` using PostgreSQL database `wd`.

Read-only SQL inspection showed recent palettes where the original source file exists in S3, conversion status is `ready`, but parsed DB geometry has no points or lines:

```text
id 42, name "СЛОЙ БЕЗ ШТУРМ 0 (2)", has_s3 true, status ready,
geometry_id 124, source "СЛОЙ БЕЗ ШТУРМ 0 (2).kmz",
point_count 0, line_points 0, multiline_points 0,
updated_at 2026-09-11 13:37:38.277726

id 41, name "СЛОЙ БЕЗ ШТУРМ 0", has_s3 true, status ready,
geometry_id 123, source "СЛОЙ БЕЗ ШТУРМ 0.kml",
point_count 0, line_points 0, multiline_points 0,
updated_at 2026-09-11 13:17:56.867801
```

Useful query used to find this shape:

```sql
select
  p.id,
  p.name,
  p.s3_id is not null as has_s3,
  p.conversion_status,
  pg.id as geometry_id,
  pg.hex,
  pg.source_file_name,
  (
    select count(*)
    from palitra_point pp
    where pp.palitra_geometry_id = pg.id
      and pp.deleted = false
  ) as point_count,
  coalesce(ST_NPoints(pg.line_string), 0) as line_points,
  coalesce(ST_NPoints(pg.multi_line_string), 0) as multiline_points,
  pg.updated_at
from palitra p
left join lateral (
  select *
  from palitra_geometry pg
  where pg.palitra_id = p.id
    and pg.deleted = false
  order by pg.updated_at desc, pg.id desc
  limit 1
) pg on true
where p.deleted = false
order by p.id desc
limit 30;
```

## Bug Explanation

The normal download and Delta split download use different sources of truth.

Normal download:

- Frontend `downloadPalitras(..., { splitForDelta: false })` posts to `/api/palitra/download`.
- Backend path: `wdintel-rs/src/palitra/mod.rs::download_palitras`.
- It calls `collect_downloadable_palitra_files`.
- For each palette, it first tries `download_stored_palitra_bytes`.
- If the palette has `s3_id`, it streams the original stored KMZ/KML-derived file into the outer ZIP.
- This is why "download as is" works for rows like palettes `41` and `42`.

Delta split download:

- Frontend checkbox `Розбити по 6500 точок (для Дельти)` toggles `downloadSplitForDelta`.
- Frontend posts to `/api/palitra/download-delta-split`.
- Backend path: `wdintel-rs/src/palitra/download.rs::download_palitras_delta_split`.
- It calls `collect_downloadable_palitra_details`.
- It builds split KMZ files from parsed DB geometry only.
- `collect_delta_split_features` currently uses `geometry.points` and `geometry.geometry.line_strings`.
- If no DB points or line strings exist, `write_delta_split_palitra` returns `Ok(())` and skips that palette.
- If all requested palettes are skipped, the endpoint still returns HTTP 200 with a valid ZIP containing zero entries.
- That zero-entry ZIP is the empty archive the user sees.

Likely root cause for the bad stored data:

- `wdintel-rs/src/kml/types.rs::MultiGeometry` previously declared only `points` and `line_strings`.
- It did not declare nested `Polygon` elements.
- `wdintel-rs/src/palitra/kmz.rs::load_coordinates_from_kml` parsed:
  - top-level `Placemark/Point`
  - top-level `Placemark/Polygon`
  - `Placemark/MultiGeometry/LineString`
- It did not parse:
  - `Placemark/MultiGeometry/Point`
  - `Placemark/MultiGeometry/Polygon`
- Many KML/KMZ files put usable geometries under `MultiGeometry`.
- Such files can be stored in S3 and marked `ready`, but leave no rows in `palitra_point` and no line geometry in `palitra_geometry`.

This exact source-file content was not yet extracted from S3 during the interrupted turn, so treat "MultiGeometry nested point/polygon" as the strongly supported code/data hypothesis rather than a fully confirmed inspection of the uploaded file.

## Partial Fix Already Applied Locally

The interrupted implementation left these local file edits:

- `wdintel-rs/src/kml/types.rs`
  - Added `polygons: Vec<Polygon>` to `MultiGeometry` with `#[serde(rename = "Polygon", default)]`.

- `wdintel-rs/src/battle_line/cleanup.rs`
  - Added `polygons: vec![]` to the one explicit `MultiGeometry` constructor found by search.

- `wdintel-rs/src/palitra/kmz.rs`
  - Changed `load_coordinates_from_kml` to keep placemark label data without consuming the placemark too early.
  - Added helper functions:
    - `placemark_point_coordinates`
    - `placemark_polygon_coordinates`
    - `polygon_coordinates`
  - Parser now collects top-level and nested `MultiGeometry` point/polygon coordinates.
  - `placemark_has_supported_geometry` now uses those helpers, so color/top-color extraction recognizes nested points and polygons too.
  - Added regression test `load_coordinates_from_kml_reads_multigeometry_features`.

- `wdintel-rs/src/palitra/download.rs`
  - Only import changes were started before interruption.
  - Current imports include `palitra_entity`, SeaORM traits, `HashMap`, `Path`, and `download_stored_palitra_bytes`.
  - These imports are currently unused until the split fallback implementation is completed.
  - As-is, the repo likely will not pass `cargo check` because of unused-import warnings if warnings are denied by the build/lints.

Current local status after interruption:

```text
 M wdintel-rs/src/battle_line/cleanup.rs
 M wdintel-rs/src/kml/types.rs
 M wdintel-rs/src/palitra/download.rs
 M wdintel-rs/src/palitra/kmz.rs
```

## Remaining Fix Steps

1. Finish the split-download fallback in `wdintel-rs/src/palitra/download.rs`.

   Recommended behavior:

   - Build split features from DB geometry first.
   - If a requested palette has zero DB split features and has an original stored source file, download/decrypt the stored source and reparse it on the fly.
   - Convert parsed source points and line strings into `DeltaSplitFeature`.
   - Then run the existing 6500-point chunking code.

   Suggested structure:

   ```rust
   struct DeltaSplitPalitra {
       palitra: Palitra,
       features: Vec<DeltaSplitFeature>,
   }
   ```

   Add helper functions along these lines:

   - `collect_delta_split_palitras(env, palitras) -> Result<Vec<DeltaSplitPalitra>, AppError>`
   - `collect_source_palitras(dbx, palitra_ids) -> Result<HashMap<i64, palitra::Model>, AppError>`
   - `collect_stored_source_delta_split_features(...) -> Result<Vec<DeltaSplitFeature>, AppError>`
   - `stored_source_file_name(palitra, source_palitra) -> String`
   - `collect_delta_split_features_from_upload(upload) -> Vec<DeltaSplitFeature>`

   Use the already imported `download_stored_palitra_bytes` so existing file and total byte limits still apply.

2. Stop returning empty successful archives.

   Current problematic code in `write_delta_split_palitra`:

   ```rust
   let chunks = collect_delta_split_chunks(&palitra_read);
   if chunks.is_empty() {
       return Ok(());
   }
   ```

   Replace this with an `AppError::BL` that includes at least `palitra_id`.

   Recommended error:

   ```rust
   return Err(AppError::BL {
       msg: format!(
           "Palitra has no geometry to split for Delta: palitra_id={}",
           palitra.id
       ),
   });
   ```

   Product choice to confirm if needed: for multi-palette downloads, failing the whole request is simpler and safer than silently omitting one palette because the endpoint has no partial-warning response shape.

3. Add/finish tests in `wdintel-rs/src/palitra/download.rs`.

   Suggested tests:

   - Existing DB-feature split tests should continue passing.
   - Add `empty_delta_split_palitra_is_rejected`.
   - Add a small unit test for `collect_delta_split_features_from_upload` if the helper is added.
   - If practical, add a test that a source parse with points creates non-empty chunks.

4. Validate compile impact from `MultiGeometry` shape change.

   Search for constructors:

   ```bash
   rg -n "MultiGeometry \\{" wdintel-rs/src
   ```

   Any constructor must include `polygons: vec![]`.

5. Run formatting and checks.

   Required by project policy:

   ```bash
   cargo fmt
   cargo check
   cargo clippy
   ```

   Focused test commands to run before the heavier checks:

   ```bash
   cargo test -p wdintel-rs palitra::kmz::tests::load_coordinates_from_kml_reads_multigeometry_features
   cargo test -p wdintel-rs palitra::download::tests
   ```

   Adjust package name if Cargo reports a different package selector is needed.

6. Retest on CBR after deployment.

   Manual scenario:

   - Open `https://echo-cbr.raptor-tench.ts.net/rer-palitra-neo`.
   - Pick a palette with the zero-DB-feature shape, for example ID `42`.
   - Download without split: should still work.
   - Download with `Розбити по 6500 точок (для Дельти)`: should download a ZIP with one or more `.kmz` entries, not an empty ZIP.
   - Inspect the ZIP entry count with `unzip -l` locally if needed.

## Optional Data Repair

The endpoint fallback will make split downloads work for existing bad rows, but it does not repair persisted geometry.

If palettes `41`, `42`, or similar should also show points in map/preview/search/highlight flows, add a repair path:

- Locate palettes with `s3_id is not null`, status `ready`, and zero DB points/line points.
- Download/decrypt their stored source.
- Reparse with the fixed parser.
- Rewrite points/line strings into the current `palitra_geometry` records using existing palette rewrite helpers.
- Recalculate center and convex hull.

This can be a one-off script or maintenance command. It is separate from fixing the empty split download response.

## Handover Notes

- The frontend likely does not need changes for error display: `confirmDownload` catches errors and surfaces `formatErrorMessage(downloadError)` in page status.
- The split endpoint should continue enforcing `PALITRA_DOWNLOAD_MAX_FILES`, `PALITRA_DOWNLOAD_MAX_FILE_BYTES`, `PALITRA_DOWNLOAD_MAX_TOTAL_BYTES`, and `PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE`.
- Keep generated frontend bindings untouched; this change is backend-only.
- No migrations are expected.
- No commit was made, per repository policy.
- `.env` was checked for `MATTERMOST_NOTIFICATION_HOOK`; it was absent, so no completion notification was sent.
