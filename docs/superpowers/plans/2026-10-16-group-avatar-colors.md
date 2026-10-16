# Group Avatar Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a controlled color for every signal group, let administrators edit it, and render it through one accessible avatar implementation in Duty and Analysis.

**Architecture:** Add one constrained `signal_group.color_key` column whose database default covers every creation path and whose migration deterministically colors existing rows. Rust-owned API types carry the key through existing responses and updates; one shared React palette, avatar, and controlled picker provide theme-aware presentation without new requests.

**Tech Stack:** PostgreSQL pure-SQL migrations, Rust, Actix Web, SeaORM, generated Elm/TypeScript bindings, React 18, MUI, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-group-avatar-colors-design.md`

## Global Constraints

- Store exactly one of: `red`, `pink`, `purple`, `deep_purple`, `indigo`, `blue`, `light_blue`, `cyan`, `teal`, `green`, `light_green`, `lime`, `amber`, `orange`, `deep_orange`, `blue_grey`.
- Backfill existing groups deterministically from `master_key`; use the database default to choose a palette key randomly for every new group-creation path.
- Do not add `random_color`, JavaScript randomness, a color endpoint, polling, or an N+1 query.
- Use Material tone `700` in light mode and `400` in dark mode; choose the higher-contrast theme foreground and require at least 4.5:1.
- Keep `Всі групи` neutral and unchanged; color is never the only selection, unread, or identity cue.
- Give regular, orphan, and archived groups the same color model and edit behavior.
- Build the picker as a controlled dumb component; keep route components responsible for state and persistence.
- Define API types in Rust and run `just gen-front`; never hand-write backend-owned frontend types or codecs.
- Keep backend edits field-local and avoid unrelated generated or formatter-only diffs.
- Show save failures through the existing detailed API-error UI and keep the dialog open.
- Format only changed frontend files with `cd wdintel-web && npm run format:staged`.
- Update the existing `#3727` entry under `CHANGELOG.md` `NEXT`; do not add a duplicate entry.

## Review Focus

1. Inserts from admin, importers, and workers that omit `color_key` must all receive a valid database default; Task 1 tests omitted-value inserts and compiles every `signal_group::ActiveModel` path.
2. Existing rows, including orphan and archived rows, must never remain null or change color between equivalent backfills; Task 1 asserts the deterministic migration result and allowed-value constraint.
3. Regular and orphan/archived edit endpoints must update the same `signal_group` row without changing authorization; Task 2 exercises both authorized paths and invalid JSON.
4. A stale browser or mixed-version response with an unknown/missing key must render neutrally rather than crash; Task 3 tests the runtime fallback.
5. Light/dark theme contrast, keyboard selection, focus visibility, cancel behavior, and failed saves must remain usable; Tasks 3 and 4 pin these states.

---

### Task 1: Add the persisted color identity

**Files:**
- Create: `echo-migration/src/m20261016_142820_signal_group_color_key.rs`
- Modify: `echo-migration/src/lib.rs`
- Generate: `wdintel-rs/src/entities/signal_group.rs`
- Modify if required by generated-field compilation: `wdintel-rs/src/messenger/group/mod.rs`
- Modify if required by generated-field compilation: `wdintel-rs/src/messenger/worker/group.rs`
- Test: `wdintel-rs/src/sigint/zone/tests.rs`

**Interfaces:**
- Consumes: the existing `signal_group(master_key)` table and all insertion paths that currently omit unspecified fields.
- Produces: required database column `signal_group.color_key: text`, an allowed-key constraint, deterministic backfill, and a random database default.

- [ ] **Step 1: Write the failing database-backed test**

Add `new_signal_group_receives_allowed_color_key_by_default` to `wdintel-rs/src/sigint/zone/tests.rs`. Insert a `signal_group::ActiveModel` without a color, reload it, and assert its key belongs to the exact 16-value set. Add a direct invalid-value update assertion that PostgreSQL rejects.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `cargo test -p wdintel-rs new_signal_group_receives_allowed_color_key_by_default -- --nocapture`

Expected: FAIL because `signal_group::Model` has no `color_key`.

- [ ] **Step 3: Add the pure-SQL migration**

If implementation starts later than the timestamp in the proposed filename, replace `20261016_142820` with the actual local creation timestamp in the filename, module declaration, and migrator registration.

The `up` migration must:

1. add nullable `color_key text`;
2. update every existing row with `(palette[1 + deterministic_hash(master_key) % 16])` using a non-negative PostgreSQL `md5`-based integer;
3. add `signal_group_color_key_check` for the exact 16 keys;
4. set a default that indexes the same literal palette with `floor(random() * 16)`;
5. set the column `NOT NULL`.

The `down` migration drops the column, which also removes its check and default. Follow the error-context structure in `m20261014_172633_user_group_feed_read_state.rs` and register the migration last in `echo-migration/src/lib.rs`.

- [ ] **Step 4: Apply the migration and regenerate the entity**

Run:

```bash
source deploy/setup_test_database.sh 3727-group-colors
just migrate-up
just gen-seaorm
```

Expected: `signal_group::Model` gains only `pub color_key: String`; no unrelated generated entity changes remain.

- [ ] **Step 5: Verify backfill determinism and constraints against the migrated test database**

Run SQL against `$DB_NAME` that:

- asserts `count(*) filter (where color_key is null) = 0`;
- asserts `count(distinct color_key) <= 16` and no value lies outside the exact palette;
- evaluates the hash expression for 160 synthetic keys and reaches all 16 palette entries;
- records `(master_key, color_key)`, repeats the documented hash expression in a transaction, and asserts the pairs are unchanged;
- inserts several groups without `color_key` and asserts every result satisfies the constraint;
- asserts an invalid explicit key fails.

Expected: all assertions pass and the invalid insert/update is rejected by `signal_group_color_key_check`.

- [ ] **Step 6: Keep explicit ActiveModel construction narrow**

Run `cargo check -p wdintel-rs`. Where a complete `signal_group::ActiveModel` literal no longer compiles, add only `color_key: NotSet` so the database default remains authoritative. Do not touch literals already using `..Default::default()`.

- [ ] **Step 7: Run focused verification**

Run:

```bash
cargo fmt --all
cargo test -p wdintel-rs new_signal_group_receives_allowed_color_key_by_default -- --nocapture
cargo check -p wdintel-rs
```

Expected: PASS with no unrelated Rust formatting diff.

- [ ] **Step 8: Commit**

```bash
git add echo-migration/src wdintel-rs/src/entities/signal_group.rs \
  wdintel-rs/src/messenger/group/mod.rs wdintel-rs/src/messenger/worker/group.rs \
  wdintel-rs/src/sigint/zone/tests.rs
git commit -m "feat(3727): added group color persistence"
```

### Task 2: Carry the color through existing backend contracts

**Files:**
- Modify: `wdintel-rs/src/messenger/group/types.rs`
- Modify: `wdintel-rs/src/messenger/types.rs`
- Modify: `wdintel-rs/src/messenger/group/mod.rs`
- Modify: `wdintel-rs/src/messenger/group/handlers.rs`
- Modify: `wdintel-rs/src/messenger/bl.rs`
- Modify: `wdintel-rs/src/messenger/mod.rs`
- Modify: `wdintel-rs/src/messenger/tests.rs`
- Modify: `wdintel-rs/src/sigint/types.rs`
- Modify: `wdintel-rs/src/sigint/zone/bl.rs`
- Modify: `wdintel-rs/src/sigint/zone/mod.rs`
- Modify: `wdintel-rs/src/sigint/zone/tests.rs`
- Modify: `wdintel-rs/src/rer_importer/group_feed_state.rs`
- Modify: `wdintel-rs/src/rer_importer/analysis/mod.rs`
- Modify: `wdintel-rs/src/elm.rs`
- Generate: `wdintel-web/src/Bindings.elm`
- Generate: `wdintel-web/src/Bindings.ts`
- Modify: `wdintel-web/src/ts/react/services/api/messenger.ts`
- Modify: `wdintel-web/src/ts/react/services/api/zones.ts`
- Test: `wdintel-web/src/ts/react/services/api/__tests__/messenger.spec.ts`
- Create: `wdintel-web/src/ts/react/services/api/__tests__/zones.spec.ts`
- Modify typed fixtures under: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/`

**Interfaces:**
- Consumes: Task 1 `signal_group.color_key`.
- Produces: Rust/Elm/TypeScript `SignalGroupColor`, `color_key`/`colorKey` on group DTOs, and authorized edits through `GroupUpdateReq` and `ZoneDatasourceGroupUpdateReq`.

- [ ] **Step 1: Write failing serialization and backend behavior tests**

Add tests with these assertions:

```rust
signal_group_color_serializes_as_snake_case();
signal_group_color_rejects_unknown_json();
group_feed_state_returns_persisted_color();
test_bl_szd_group_update_persists_color();
test_bl_group_update_persists_color_for_orphan_or_archived_group();
```

The two update tests must also assert existing admin authorization/setup remains unchanged and the returned DTO contains the saved key.

- [ ] **Step 2: Run backend tests to verify failure**

Run:

```bash
cargo test -p wdintel-rs signal_group_color -- --nocapture
cargo test -p wdintel-rs group_feed_state_returns_persisted_color -- --nocapture
cargo test -p wdintel-rs persists_color -- --nocapture
```

Expected: FAIL because the API type and fields do not exist.

- [ ] **Step 3: Define the backend-owned color type and shared persistence helper**

In `wdintel-rs/src/messenger/group/types.rs`, define:

```rust
#[serde(rename_all = "snake_case")]
pub enum SignalGroupColor { /* exact 16 variants from the spec */ }

impl SignalGroupColor {
    pub const ALL: [Self; 16];
    pub const fn as_db_value(self) -> &'static str;
    pub fn from_db_value(value: &str) -> anyhow::Result<Self>;
}
```

Derive the repository's standard `Elm`, encoder/decoder, Serde, `Copy`, `Clone`, `Eq`, and debug traits. Add `set_signal_group_color<C: ConnectionTrait>(db: &C, master_key: &str, color: SignalGroupColor) -> anyhow::Result<SignalGroupColor>` beside the existing signal-group helpers; it performs one authorized caller-controlled update and returns the saved value.

- [ ] **Step 4: Extend only the required DTOs and queries**

Add `color_key: SignalGroupColor` to:

- `SignalGroupEntry` and `OrphanSignalGroupEntry` (including their manual serializers);
- `GroupEntryF1` and `GroupUpdateReq`;
- `ZoneDatasourceGroup` and `ZoneDatasourceGroupUpdateReq`;
- `GroupFeedState` and its internal record/row.

Select `signal_group.color_key` in the existing set-based group-feed query and zone/admin group queries. Convert database strings through `from_db_value` at Rust boundaries. Add the key to all constructors in `messenger/group`, `messenger/group/handlers.rs`, and `rer_importer/analysis/mod.rs`; do not introduce a separate color query.

- [ ] **Step 5: Persist both edit paths**

Call the shared setter from:

- `bl_szd_group_update` for regular zone groups;
- `bl_group_update` for orphan and archived groups.

Return the persisted key in both endpoint responses. Invalid wire values must fail Serde deserialization before mutation; existing admin checks stay in place.

- [ ] **Step 6: Regenerate bindings and update API normalizers**

Register/export `SignalGroupColor` through `wdintel-rs/src/elm.rs`, then run `just gen-front`.

Update `toGroupUpdateReqBody`, `normalizeGroupEntry`, `ZoneDatasourceGroupLike`, zone request bodies, and zone response normalization to preserve snake/camel conversion for `color_key`. Update typed `GroupFeedState` fixtures with valid keys so the generated contract compiles.

- [ ] **Step 7: Write and run frontend API tests**

Assert `editGroup` and `updateZoneDatasourceGroup` send `color_key`, and both normalizers return `colorKey`. Also assert group-feed transformation preserves the key.

Run:

```bash
cd wdintel-web
npx vitest run \
  src/ts/react/services/api/__tests__/messenger.spec.ts \
  src/ts/react/services/api/__tests__/zones.spec.ts \
  src/ts/react/services/api/__tests__/group-feed-state.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run backend and binding verification**

Run:

```bash
cargo fmt --all
cargo test -p wdintel-rs signal_group_color -- --nocapture
cargo test -p wdintel-rs group_feed_state -- --nocapture
cargo test -p wdintel-rs sigint::zone::tests -- --nocapture
cargo check -p wdintel-rs
just build-front
```

Expected: PASS; generated changes are limited to the new type/fields.

- [ ] **Step 9: Commit**

```bash
git add wdintel-rs/src wdintel-web/src/Bindings.elm wdintel-web/src/Bindings.ts \
  wdintel-web/src/ts/react/services/api wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__
git commit -m "feat(3727): exposed group colors in APIs"
```

### Task 3: Build the shared accessible palette and avatar UI

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-colors.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupColorPicker.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupAvatar.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupIdentity.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/GroupList.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/group-navigation.css`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/index.ts`
- Create: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-colors.spec.ts`
- Modify: `wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx`

**Interfaces:**
- Consumes: generated `SignalGroupColor` and `GroupFeedState.colorKey` from Task 2.
- Produces: `GROUP_COLOR_OPTIONS`, `resolveGroupColor(theme, colorKey)`, color-aware `GroupAvatar`, and controlled `GroupColorPicker`.

- [ ] **Step 1: Write failing palette and component tests**

Add tests asserting:

```ts
it('maps all 16 keys in light and dark themes');
it('keeps every foreground/background pair at or above 4.5 contrast');
it('falls back to neutral theme colors for an unknown runtime key');
it('keeps the all-groups icon neutral');
it('renders the selected swatch, preview initial, and accessible labels');
it('changes only through onChange and supports keyboard radio navigation');
it('disables every swatch while saving');
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd wdintel-web
npx vitest run \
  src/ts/react/routes/shared/group-navigation/__tests__/group-colors.spec.ts \
  src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx
```

Expected: FAIL because palette resolution and picker do not exist and avatars ignore `colorKey`.

- [ ] **Step 3: Implement the palette resolver**

Define:

```ts
export type GroupColorPresentation = { backgroundColor: string; color: string };
export const GROUP_COLOR_OPTIONS: readonly {
  value: SignalGroupColor;
  label: string;
}[];
export function resolveGroupColor(
  theme: Theme,
  colorKey: SignalGroupColor | string | null | undefined,
): GroupColorPresentation;
```

Map the 16 keys to the corresponding exports from `@mui/material/colors`. Use tone `700` for light mode and `400` for dark mode. Compare contrast against `theme.palette.common.white` and `theme.palette.grey[900]`, choose the higher value, and keep the tested minimum at 4.5. Unknown values use `action.selected`/`text.primary`.

- [ ] **Step 4: Make the avatar color-aware without changing all-groups behavior**

Add optional `colorKey` to `GroupAvatar`, apply `resolveGroupColor` only for `kind="group"`, and pass `group.colorKey` from `GroupIdentity` and `GroupList`. Keep the current grapheme logic, sizes, icon, aria behavior, and structural selected marker unchanged.

- [ ] **Step 5: Implement the controlled dumb picker**

Define:

```ts
type GroupColorPickerProps = {
  name: string;
  value: SignalGroupColor;
  disabled?: boolean;
  onChange: (value: SignalGroupColor) => void;
};
```

Render `Колір групи`, one `GroupAvatar` preview, and a wrapping MUI radio group of the 16 circular swatches. Each option has a Ukrainian accessible name, selected check mark, `aria-checked`, native arrow-key behavior, and `:focus-visible` outline. The component holds no server or dialog state.

- [ ] **Step 6: Run component tests and scoped formatting**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run \
  src/ts/react/routes/shared/group-navigation/__tests__/group-colors.spec.ts \
  src/ts/react/routes/shared/group-navigation/__tests__/group-navigation-ui.spec.tsx
```

Expected: PASS.

- [ ] **Step 7: Run the Impeccable detector required for the changed UI**

Run:

```bash
/home/ubuntu/.codex/plugins/cache/openai-curated-remote/impeccable/4.3.1/skills/impeccable/scripts/impeccable detect --json \
  wdintel-web/src/ts/react/routes/shared/group-navigation/GroupAvatar.tsx \
  wdintel-web/src/ts/react/routes/shared/group-navigation/GroupColorPicker.tsx \
  wdintel-web/src/ts/react/routes/shared/group-navigation/group-navigation.css
```

Expected: no unresolved high-confidence accessibility, theming, or interaction finding.

- [ ] **Step 8: Commit**

```bash
git add wdintel-web/src/ts/react/routes/shared/group-navigation
git commit -m "feat(3727): colored shared group avatars"
```

### Task 4: Add color editing to every Administration group form

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/admin-directions-neo/index.tsx`
- Create: `wdintel-web/tests/e2e/group-color-admin.spec.ts`

**Interfaces:**
- Consumes: Task 2 update contracts and Task 3 `GroupColorPicker`.
- Produces: identical regular, orphan, and archived group color-edit behavior on `/admin/directions-neo`.

- [ ] **Step 1: Write failing mocked-browser tests**

In `group-color-admin.spec.ts`, mock the existing Directions APIs and cover:

```ts
test('regular group previews, cancels, and saves a selected palette color');
test('orphan group sends the selected color through edit-group');
test('archived group uses the same picker and update request');
test('failed color save keeps the dialog open and shows the API error');
test('picker is keyboard-operable and disabled while save is pending');
```

For cancel, reopen the dialog and assert the persisted value is restored. For save, inspect the request body for the exact `color_key` and fulfill with the updated color.

- [ ] **Step 2: Run the E2E file to verify failure**

Run: `cd wdintel-web && npm exec -- playwright test tests/e2e/group-color-admin.spec.ts`

Expected: FAIL because the forms have no `Колір групи` field and omit `color_key`.

- [ ] **Step 3: Add color to local edit state**

Add `colorKey: SignalGroupColor` to `GroupEditState` and `OrphanEditState`. Initialize it from `ZoneDatasourceGroup.colorKey` or `OrphanSignalGroupEntry.colorKey`. Since archived rows open `openOrphanEditDialog`, they automatically use the same state path.

- [ ] **Step 4: Render the shared picker in both dialogs**

Place `GroupColorPicker` near the group identity at the top of the regular and orphan edit content. Pass the group name, local value, `isSaving`, and a state-only `onChange`. Do not duplicate swatch markup in the page.

- [ ] **Step 5: Save and reconcile the returned color**

Include `colorKey` in `ZoneDatasourceGroupUpdateReq` and `GroupUpdateReq`. On success, update `zoneGroups`, `groupInfos`, `orphanGroups`, and `archivedGroups` with the returned/persisted key so every visible representation changes without a full reload. On failure, preserve the chosen local value, clear `isSaving`, keep the dialog open, and show the existing error UI.

- [ ] **Step 6: Run E2E and frontend verification**

Run:

```bash
cd wdintel-web
npm run format:staged
npm exec -- playwright test tests/e2e/group-color-admin.spec.ts
npx vitest run src/ts/react/routes/shared/group-navigation/__tests__
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wdintel-web/src/ts/react/routes/admin-directions-neo/index.tsx \
  wdintel-web/tests/e2e/group-color-admin.spec.ts
git commit -m "feat(3727): added group color picker"
```

### Task 5: Lock cross-route behavior and complete verification

**Files:**
- Modify: `wdintel-web/tests/e2e/group-feed-navigation-analysis.spec.ts`
- Modify: `wdintel-web/tests/e2e/group-feed-navigation-duty.spec.ts`
- Modify: `wdintel-web/tests/e2e/group-feed-unread-state.spec.ts` only if its typed response fixture requires `color_key`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: persisted API colors and the shared avatar from Tasks 1–4.
- Produces: cross-route regression coverage and release-facing documentation.

- [ ] **Step 1: Extend failing Analysis and Duty assertions**

Give mocked groups different `color_key` values. In both routes, assert list rows and selected group identity use the expected resolved backgrounds, the same key resolves consistently, switching groups changes the avatar without changing feed/filter behavior, and `Всі групи` remains neutral.

- [ ] **Step 2: Run the focused browser tests**

Run:

```bash
cd wdintel-web
npm exec -- playwright test \
  tests/e2e/group-feed-navigation-analysis.spec.ts \
  tests/e2e/group-feed-navigation-duty.spec.ts \
  tests/e2e/group-feed-unread-state.spec.ts \
  tests/e2e/group-color-admin.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Update the existing changelog entry**

Extend the first `#3727` entry under `NEXT` to state that groups have stable automatically assigned avatar colors and administrators can choose a prepared color in Directions. Do not add another `#3727` bullet and do not edit README overviews.

- [ ] **Step 4: Run migration and backend gates**

Run:

```bash
source deploy/setup_test_database.sh 3727-group-colors
just migrate-up
GITHUB_BASE_REF=main TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh
cargo fmt --all -- --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p wdintel-rs group_feed_state -- --nocapture
cargo test -p wdintel-rs sigint::zone::tests -- --nocapture
```

Expected: PASS. If repository-wide pre-existing failures occur, record them separately and still prove every changed module with its focused command.

- [ ] **Step 5: Run frontend gates**

Run:

```bash
cd wdintel-web
npm run format:staged
npx vitest run \
  src/ts/react/services/api/__tests__/messenger.spec.ts \
  src/ts/react/services/api/__tests__/zones.spec.ts \
  src/ts/react/services/api/__tests__/group-feed-state.spec.ts \
  src/ts/react/routes/shared/group-navigation/__tests__
cd ..
just build-front
```

Expected: PASS with no unrelated formatting diff.

- [ ] **Step 6: Perform visual and interaction verification**

At desktop and mobile widths, inspect `/admin/directions-neo`, `/rer-analysis-neo`, and `/rer-duty-neo` in both theme modes. Verify swatch wrapping, 4.5:1-readable initials, focus rings, pending-save disabled state, long group names, regular/orphan/archived editing, independent Duty columns, and the neutral `Всі групи` icon.

- [ ] **Step 7: Commit**

```bash
git add wdintel-web/tests/e2e/group-feed-navigation-analysis.spec.ts \
  wdintel-web/tests/e2e/group-feed-navigation-duty.spec.ts \
  wdintel-web/tests/e2e/group-feed-unread-state.spec.ts CHANGELOG.md
git commit -m "test(3727): covered group avatar colors"
```
