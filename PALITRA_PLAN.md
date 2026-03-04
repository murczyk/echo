# Palitra Multi-Geometry Plan

## Goal
Add a backend endpoint `create-palitra-basic` that creates exactly one `palitra` record and, for one uploaded KMZ/KML document, stores points in multiple `palitra_geometry` records (one geometry per detected color hex).

## Current Implementation Status

### Done now
- [x] Added new backend endpoint: `POST /api/palitra/create-palitra-basic`.
- [x] Registered endpoint in Actix server routes.
- [x] Reused existing permission flow (`access_type` + `access_values` + scope checks).
- [x] Reused KMZ/KML parser, then grouped parsed points by normalized color hex.
- [x] Created one `palitra` record only.
- [x] Ensured one active geometry per color for that palitra (upsert-by-color in request transaction).
- [x] Rewrote points per geometry color (each color group written into its own geometry).
- [x] Kept existing `create-with-kmz` behavior unchanged (single selected color flow).
- [x] Refactored multipart parsing into shared helper used by both create endpoints.

## Contract (Backend)

### `POST /api/palitra/create-palitra-basic`
Multipart fields:
- `name` (required)
- `access_type` (required): `logins` | `organisms` | `aor`
- `access_values` (optional string, comma-separated)
- `kmz` (required file; supports `.kmz` and `.kml`)
- `color_hex` (ignored by basic flow; accepted for payload compatibility)

Response:
- Existing `Palitra` JSON structure.

## Data/Schema Considerations
- No new migration required for this endpoint:
  - `palitra_geometry` already references `palitra(id)` without unique constraint on `palitra_id`.
  - existing schema already supports 1:N (`palitra` -> many `palitra_geometry`).

## Remaining Backend Work to Fully Normalize Multi-Geometry Behavior

### 1) Clarify "primary geometry" semantics
Several existing reads still pick only the latest geometry and log warnings when multiple exist.
- Decide stable primary selection policy for single-row `Palitra` view:
  - latest updated,
  - max point count,
  - first created,
  - or explicit `is_primary` flag (would require schema change).
- Apply that policy consistently in all `Palitra` render paths.

### 2) Upload endpoint behavior
Current `upload-points/{palitra_id}` rewrites only one (latest) geometry.
- Decide desired behavior when a palitra has multiple geometries:
  - upload replaces all geometries by color,
  - upload targets one geometry (`palitra_geometry_id`/color param),
  - or keep legacy single-geometry replacement and document it clearly.

### 3) Update endpoint behavior
`update/{palitra_id}` currently updates/creates geometry by `color_hex`.
- Confirm this is still desired with multi-geometry palitras.
- If needed, split palitra-metadata update from per-geometry update to avoid accidental geometry creation.

### 4) Response model evolution (optional but likely needed)
Current `Palitra` response returns one color and one optional geometry object.
- Consider adding a detailed endpoint payload that returns geometry list:
  - geometry id,
  - color hex,
  - per-geometry center/perimeter,
  - optional source/last_uploaded_at per geometry.
- Keep old payload for backward compatibility if frontend migration is staged.

### 5) Logging cleanup
Warnings like "has N active geometries; using latest" now happen in expected scenarios.
- Downgrade/remove noisy warnings once multi-geometry policy is finalized.

### 6) Test coverage
Add/extend automated tests for:
- basic-create with multiple colors => one palitra + many geometries + correct point distribution,
- tie/empty-color fallback handling,
- no-point files,
- permission checks by access type,
- compatibility checks for legacy `create-with-kmz` path.

### 7) API docs / Postman updates
- Add request example for `create-palitra-basic`.
- Document how multi-geometry is represented and how legacy endpoints behave with it.

## Non-Goals (for this change)
- Frontend integration for `create-palitra-basic` (explicitly deferred).
- Changing existing list payload shape in this task.
