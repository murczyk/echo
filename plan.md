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
