Implemented so far:

  - DB migration added for ORBIT hierarchy fields.
  - sigint_unit SeaORM model regenerated for new columns.
  - Backend API types updated for new unit fields/sorts/filters.
  - Main unit create/update/render/list plumbing mostly updated.
  - ORBIT echelon mapping changed to 1:1, including other.
  - ORBIT import path started using all hierarchy fields.
  - Some backend matching/fixture/legacy import code updated.

  Still left:

  - Finish Rust compile fixes from cargo check after the interruption. The last known error was fixed, but the rerun was stopped before completion.
  - Finish any remaining explicit sigint_unit::Model / ActiveModel initializer fixes found by compiler.
  - Run cargo fmt, cargo check, cargo clippy.
  - Run just gen-front.
  - Implement frontend changes:
      - /rer-units new columns hidden by default, filters/sorts/forms/duplicate hints.
      - /admin/unit-unparsed immutable label in link dialog header.
      - /admin/unit-unparsed tab styling, toggle styling, comment-as-label + edit in actions, remove/label empty actions column.
      - /admin/unit-duplicates move merge action into actions column.

  - Run frontend formatting and just build-front.
  - Migration verification still has a blocker: local just migrate-up failed because the DB has an applied migration whose file is missing:
    m20260811_174133_drop_echo_automation_coordinates_screenshot. That needs resolving before a clean migration run.

Detailed notes to continue:

- Worktree status at pause:
  - Modified Rust/backend files:
      - echo-migration/src/lib.rs
      - wdintel-rs/src/devices/devices/mod.rs
      - wdintel-rs/src/entities/sigint_unit.rs
      - wdintel-rs/src/orbit/matching.rs
      - wdintel-rs/src/orbit/mod.rs
      - wdintel-rs/src/rer_importer/reports/rer.rs
      - wdintel-rs/src/rer_importer/unit.rs
      - wdintel-rs/src/server/mod.rs
      - wdintel-rs/src/sigint/import/mod.rs
      - wdintel-rs/src/sigint/import/types.rs
      - wdintel-rs/src/sigint/network/etalon_calc/consistency.rs
      - wdintel-rs/src/sigint/signal/oneoff.rs
      - wdintel-rs/src/sigint/unit/mod.rs
      - wdintel-rs/src/sigint/unit/orbit.rs
      - wdintel-rs/src/sigint/unit/types.rs
      - wdintel-rs/src/unit/mod.rs
  - New migration file:
      - echo-migration/src/m20260813_183642_sigint_unit_orbit_echelons.rs

- New sigint_unit columns/migration:
  - other
  - team_or_crew
  - section
  - squad
  - platoon
  - brigade
  - corps
  - Migration is additive: add text columns, coalesce existing nulls to '', set default '', set not null; down drops the columns.

- ORBIT-to-Echo hierarchy mapping should be 1:1:
  - other -> other
  - teamOrCrew -> team_or_crew
  - section -> section
  - squad -> squad
  - platoon -> platoon
  - company -> company
  - battalion -> battalion
  - regiment -> regiment
  - brigade -> brigade
  - division -> division
  - corps -> corps
  - fieldArmy -> army
  - militaryDistrict -> military_district
  - armyRegion -> army_region

- Name/import hierarchy order, low-to-high:
  - other, team_or_crew, section, squad, platoon, company, battalion, regiment, brigade, division, corps, army, military_district, army_region

- Natural military sort order, high-to-low:
  - army_region, military_district, army, corps, division, brigade, regiment, battalion, company, platoon, squad, section, team_or_crew, other, id

- Important backend details already started:
  - wdintel-rs/src/orbit/mod.rs:
      - EchoEchelon now has Other, TeamOrCrew, Section, Squad, Platoon, Brigade, Corps.
      - echo_echelon maps ORBIT keys 1:1.
      - sigint_unit_full_name includes all new fields.
  - wdintel-rs/src/orbit/matching.rs:
      - Added sigint_hierarchy helper returning all 14 levels.
      - match_score/search_score/sigint_unit_identity/parent_signature should use that helper.
      - Formatting not yet run, so some line breaks may be ugly but should be handled by cargo fmt.
  - wdintel-rs/src/sigint/unit/orbit.rs:
      - create_unit_req_from_orbit now destructures 14 hierarchy fields.
      - fill_orbit_parent_chain/fill_orbit_hierarchy_level use [String; 14].
      - sigint_unit_for_orbit_matching and imported_unit_masks include all fields.
  - wdintel-rs/src/sigint/unit/types.rs:
      - Unit/CreateUnitReq/ListUnitsReq/UpdateUnitReq have new fields.
      - UpdateUnitReq uses Option<String> for newly added fields to preserve compatibility with older clients.
      - ListUnitsSortBy has new asc/desc variants for the new columns.
  - wdintel-rs/src/sigint/unit/mod.rs:
      - unit_name/unit_name_req use all 14 fields.
      - create/update/render/list filters/sorts mostly updated.
      - Need compiler verification because a mechanical edit was interrupted and only partially verified.

- Known backend follow-up:
  - Rerun cargo check after stopping background cargo work.
  - Fix remaining compiler errors, likely explicit sigint_unit::Model or sigint_unit::ActiveModel literals missing new fields.
  - Prefer ..Default::default() for test ActiveModel fixtures where existing code already uses that style.
  - For explicit Model fixtures, add new fields as String::new()/Default::default() unless the test needs a hierarchy value.
  - Check any unit relationship/report identity logic that assumes only 7 levels.

- Frontend /rer-units work still not implemented:
  - Run just gen-front first after Rust types compile enough for generation.
  - Update wdintel-web/src/ts/react/services/api/units.ts DEFAULT_LIST_UNITS_REQ with new filter nulls.
  - Update wdintel-web/src/ts/react/routes/rer-units-neo/helpers.ts:
      - UNIT_SORTS for other/teamOrCrew/section/squad/platoon/brigade/corps.
      - buildUnitsListReq sends new filters.
      - EMPTY_UNIT_FORM/unitToForm/trimUnitForm/unitNameParts/findPotentialDuplicates include all 14 hierarchy fields.
  - Update wdintel-web/src/ts/react/routes/rer-units-neo/index.tsx:
      - DEFAULT_COLUMN_ORDER includes new hierarchy columns.
      - DEFAULT_COLUMN_VISIBILITY hides all new columns by default.
  - Update wdintel-web/src/ts/react/routes/rer-units-neo/components/UnitsTable.tsx:
      - Add columns for new fields.
      - Keep existing visible columns as-is, but split collapsed labels:
          - company label should no longer imply platoon/squad/section if those have separate columns.
          - regiment label should no longer imply brigade.
          - army label should no longer imply corps.
  - Update wdintel-web/src/ts/react/routes/rer-units-neo/components/UnitFormDialog.tsx:
      - HIERARCHY_FIELDS includes all 14 fields.
      - duplicate hint filters/table include all hierarchy fields.
  - Update wdintel-web/src/ts/react/routes/rer-units-neo/search-mode.ts and any unit search helpers to include new fields.
  - Update wdintel-web/src/ts/react/routes/rer-unit-details/OrbitUnitLinkDialog.tsx sigintUnitDescription to include new fields.
  - Update wdintel-web/src/ts/react/routes/admin-unit-duplicates/index.tsx and /admin-unit-unparsed unit segment helpers to include all hierarchy fields.

- Frontend /admin/unit-unparsed requested changes still not implemented:
  - Linking dialog:
      - Label/unmatched text must be immutable.
      - Remove editable "Синонім підрозділу" field.
      - Dialog title should include the row text, e.g. "Прив'язати до підрозділу 2 мсб 45 мсп 66 за".
      - Submit resolveUnresolvedUnitLabel with label equal to resolveState.row.unitTxt.
      - Save button disabled condition should only require a selected SIGINT unit and no processing.
      - Update tests: old "edited label" test should expect immutable original label and absence of the synonym input.
  - Table/layout:
      - If row-actions column is empty in any state, remove it or give it a proper title.
      - Tab display should match /admin/ai/callsigns: PageHeader titleActions with MUI Tabs/Tab.
      - "Всі / Нові / Архів" toggles should match /rer-units PowerChip status filter styling.
      - Comment/note column should render as a label/read-only text, not an editable TextField.
      - Move note editing into row actions.
      - The existing NoteCell blur-save flow/tests need replacement with explicit action/dialog or row-action edit flow.

- Frontend /admin-unit-duplicates requested change still not implemented:
  - Remove the standalone anonymous/merge column.
  - Move merge action to renderRowActions using MrtRowActions/MrtRowActionButton, matching "Нерозпізнані підрозділи" tab layout.
  - Include mrt-row-actions in default column order/visibility only when actions are rendered.

- Verification sequence expected by AGENTS.md:
  - cargo fmt
  - cargo check
  - cargo clippy
  - just gen-front
  - cd wdintel-web && npm run format:staged
  - just build-front
  - Migration verification:
      - just migrate-up is currently blocked by local DB state:
        "Migration file of version 'm20260811_174133_drop_echo_automation_coordinates_screenshot' is missing, this migration has been applied but its file is missing"
      - After DB state is fixed, run just migrate-up and then just gen-seaorm.
      - For full migration catalog check, follow AGENTS.md with deploy/setup_test_database.sh and scripts/ci/check_analytics_migration_catalog.sh.

- Tooling notes:
  - apply_patch failed repeatedly in this sandbox with:
    bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
  - Existing edits were made with scoped escalated python3 scripts because of that sandbox failure.
  - Do not commit or push without explicit user permission.
  - No MATTERMOST_NOTIFICATION_HOOK was found in .env earlier, so no completion notification was sent.

Double-check addendum:

- Current git state when rechecked:
  - git status --short shows only plan.md modified.
  - git diff --name-only shows only plan.md.
  - git diff --cached --name-only is empty.
  - The backend ORBIT/schema/type changes listed above are present in the current branch files, but not as local uncommitted diffs in this workspace anymore. A handoff should treat them as current branch state and continue from there.

- Current process state:
  - No cargo check/clippy/test/build or wdintel rustc background process is running.

- Current frontend verification from source scan:
  - /rer-units frontend still does not include other/teamOrCrew/section/squad/platoon/brigade/corps columns, filters, default request fields, form fields, or search text fields.
  - /admin/unit-unparsed still has the editable "Синонім підрозділу" field and static "Прив'язати до підрозділу" dialog title.
  - /admin/unit-unparsed still uses NoteCell as an editable text input in the table.
  - /admin-unit-duplicates still has a standalone merge column with an empty header instead of row actions.

- Practical next step from this exact workspace:
  - Start with cargo check to discover whether current backend branch state compiles.
  - Then implement the frontend tasks listed above, regenerate bindings, format, and run checks.

