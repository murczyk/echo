- [x] Add DB migration for `interseption_kind`, migrate `signal_group.is_rer`, drop `is_rer`, and rename `sigint_network.unit_tags` to `unit_mask`.
- [x] Register the migration and regenerate SeaORM entities.
- [x] Update Rust DTOs, business logic, tests, and non-RER matching code to use `interseption_kind` and `unit_mask`.
- [x] Regenerate front-end bindings after backend type changes.
- [x] Update signal group create/edit UI to use an `interseption_kind` dropdown with the requested tooltip.
- [x] Update `/rer-networks-neo` create/edit drawer to show unit mask naming with the requested tooltip.
- [x] Add `/admin/system-settings-neo` checkbox for `support_non_rer_interceptions` with the requested tooltip.
- [x] Run formatting and checks: `cargo fmt`, `cargo check`, `cargo clippy`, and `just build-front`.

