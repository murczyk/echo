# BattleLine consolidation plan

## Findings

- The red geometry displayed by default on `/rer-analysis-neo` is the legacy
  Delta KMZ layer, not a regular palette and not the new BattleLine.
- The analysis map loads the latest successful `enemy_units_geojson` KML from
  `/api/delta/kml/latest`. The layer is enabled by default and appears in the
  collapsed layer control as `KMZ підкладка`.
- The ordinary palette layer is also enabled by default, but its initial list
  of visible palette geometry IDs is empty. A palette is displayed only after
  it has been selected and persisted in the browser.
- On echo-staging, the latest successful legacy layer is
  `enemy_units_geojson.id = 5`, created on 2026-03-23. Its KML contains 117
  placemarks, 14,555 red LineStrings, and 117 Points.
- Echo-staging currently has no rows in `battle_line_version`. Therefore the
  newly deployed BattleLine functionality cannot be the source of the red
  layer.
- A possible legacy LBZ palette exists as palette `591`, named
  `ЛБЗ_тест_25кві26`, with source file `ЛБЗ_6кві26.kmz`. It is archived, uses a
  cyan color, and contains 20,830 line geometries. It is a different dataset
  from the currently visible red Delta KMZ and cannot appear in the active map
  palette list.
- The legacy Delta upload is performed from the units workflow through
  `/api/delta/convert-kmz-to-geojson`. It stores the converted GeoJSON and KML,
  then the analysis map treats the most recent successful row as its KMZ
  overlay.
- Before this consolidation, the new BattleLine admin upload independently
  parsed KML/KMZ files, replaced the active `battle_line_version`, rebuilt
  AOR-specific geometry, and requeued settlement links.
- The new BattleLine geometry is not currently rendered on
  `/rer-analysis-neo`. Removing the legacy KMZ layer without adding an active
  BattleLine map endpoint and layer would remove the visible line completely.

## Action items

Implementation status (2026-08-20): items 1–6 are implemented locally. The
focused backend and frontend tests, full frontend build, `cargo check`,
`cargo clippy`, and catalog-aware migration validation pass. The exact staging
dry-run and apply in item 7 remain post-deployment operations; no staging data
has been changed.

### 1. Use the approved initial source

- Use `enemy_units_geojson.id = 5` as the only source for BattleLine v0.
- Import all Point and LineString features in source order.
- Do not filter by color, folder, placemark name, or style.
- Report the source checksum, feature counts, coordinate count, and bounds in
  oneoff dry-run and apply output.

### 2. Add import provenance and idempotency

- Add `source_kind`, `source_identifier`, and `source_sha256` provenance to
  `battle_line_version`.
- Record direct admin uploads as `admin_upload` and the oneoff source as
  `delta_kml` with identifier `enemy_units_geojson:5`.
- Prevent the same Delta source identifier and checksum from being imported
  more than once.
- Preserve provenance for direct admin uploads as a distinct source type.
- Add and register a pure SQL migration, regenerate SeaORM entities, declare
  the analytics impact, and run the catalog-aware migration check against a
  restored test database.

### 3. Create one shared BattleLine importer

- Extract parsing and activation from the HTTP upload handler into a reusable
  internal service.
- Accept the file bytes, filename, uploader, and source provenance as inputs.
- Validate size, extension, non-empty geometry, coordinate validity, and the
  approved Point/LineString rules before changing the active version.
- Under the existing BattleLine advisory lock, idempotently retire the prior
  version, activate the new version, and rebuild AOR geometry in one database
  transaction.
- Keep the current active BattleLine unchanged if parsing, validation, AOR
  generation, or database work fails.
- Use the shared importer from the existing `/api/battle-line/upload` handler.
- Do not requeue existing settlement links when a BattleLine version changes;
  the new version applies only to newly queued data.

### 4. Add the v0 oneoff

- Add `oneoff-import-battle-line-from-delta-kml`, defaulting to source row `5`.
- Support a dry-run mode that resolves the requested source and reports its
  checksum, feature counts, geometry types, bounds, and validation result
  without writing.
- In apply mode, fetch the chosen stored source, call the shared importer, and
  create the initial BattleLine version.
- Safely no-op when the source checksum has already been imported.
- Refuse to replace any active BattleLine unless `--force` is supplied.
- Document that `--force` is the only way the Delta oneoff may overwrite an
  existing manually uploaded BattleLine.
- Verify that AOR geometry is generated without requeueing historical
  settlement links.

### 5. Keep Delta and BattleLine independent

- Do not invoke BattleLine imports from Delta upload or conversion code.
- Do not make Delta upload success depend on BattleLine parsing or activation.
- Do not let later Delta KML uploads overwrite BattleLine automatically.
- Keep the existing admin-only `/api/battle-line/upload` flow and its current
  permissions.

### 6. Consolidate the analysis-map layer

- Stop loading `/api/delta/kml/latest` in analysis and small map components.
- Remove the `KMZ підкладка` feature flag, persisted state, toggle, renderer,
  and now-unused frontend KML/KMZ rendering utilities.
- Do not add an active BattleLine endpoint or render BattleLine on
  `/rer-analysis-neo`.
- Continue rendering BattleLine only in the existing admin LBZ panel.
- Retain the stored Delta KML and backend access needed by the explicit oneoff;
  it is no longer a map layer.

### 7. Verify and deploy

- Keep tests for nested KML `MultiGeometry`, approved Point/LineString import,
  invalid input, and representative legacy files.
- Add tests for import summaries, idempotent Delta imports, force protection,
  one active version, rollback on failure, version retirement, AOR rebuilding,
  and preservation of existing settlement-link results.
- Update frontend tests for the removed KMZ toggle and stored state.
- Run `cargo fmt`, `cargo check`, and `cargo clippy`.
- Format changed frontend files with `cd wdintel-web && npm run format:staged`,
  check modified Elm files if applicable, and run `just build-front`.
- Run the oneoff against echo-staging source row `5` with `--dry-run` and verify
  the reported 117 Points and 14,555 LineStrings without changing staging.
- After deployment, apply v0 with
  `oneoff-import-battle-line-from-delta-kml --source-id 5`; use `--force` only
  when intentionally replacing an existing BattleLine.
- Verify that later Delta uploads do not create BattleLine versions and that
  the legacy red map overlay is absent.
- Update the relevant architecture/process documentation.
- Add a `CHANGELOG.md` entry with the GitHub issue reference and the required
  oneoff/deployment instructions.

## Q&A

### Q1. Which existing dataset is the authoritative source for BattleLine v0?

**Answer:** use `enemy_units_geojson.id = 5`

### Q2. Which geometries should be imported?

**Answer:** import LineStrings and also the 117
Point features in the current Delta KML; color or folder/name rules
must not be used to select BattleLine features.

### Q3. Who may replace BattleLine through the legacy upload flow?

**Answer:** The current Delta upload accepts RER users, while the new
BattleLine upload is admin-only, let's keep it this way. if we already have some BattleLine - any changes to Delta KML does not change battle line. basically we want to use Delta KML as initial import value, and then those 2 things live in the system as completely independent modules.

### Q4. Should direct uploads on `/admin/battle-line` remain available?

**Answer:** they remain. a later legacy upload may not
overwrite a manually uploaded BattleLine, you may only do tat via manually calling oneoff with --force flag to overwrite existing battle line. please document this.

### Q5. Should the `ЛБЗ` analysis-map layer be enabled by default?

**Answer:** for now we don't show BattleLine as layer anywhere except for ЛБЗ admin panel. if you have contradicting requirements - add a follow-up question on that requirements, and we will sort it out.

### Q6. Can the legacy `KMZ підкладка` layer be removed entirely?

**Answer:** yes, it only exists as possible source of initial value fill-in.

### Q7. Should a BattleLine import failure fail the entire legacy upload?

**Answer:** no because BattleLine upload should not affect legacy flow in any way, it should not be there. only import-battle-line-from-delta-kml oneoff links the two, they are comletely independent across the rest of the system.

### Q8. Is a full settlement-link requeue acceptable after every new version?

**Answer:**  This is the current BattleLine behavior, but we don't actually want to do that. if new BattleLine is uploaded - it only affects new data, we do not re-queue exisging data up for recalculation at all.

### Q9. Which GitHub issue should be used for the changelog and branch scope?

**Answer:**  3221. checked out to a new branch
