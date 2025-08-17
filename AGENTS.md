## General project into

- Read README.md to understand the general project purpose

## CODE STYLE

- keep code formatted with `cargo fmt`
- keep `cargo clippy` clean

## GIT

- **Never Commit or Push Without Permission**
- **NEVER** run `git commit` without explicitly asking the user first
- **NEVER** run `git push` without explicitly asking the user first
- Always show the user what changes you've made and ask for permission before committing
- Use `git status` and `git diff` to show what will be committed
- Even for urgent fixes or reverts, always ask before committing/pushing. The user needs to be aware of what's being changed in their repository.

## Migrations

- When you want to change the database schema -- create new file in
  `echo-migration/src` and use the style of one of existing files
- make pure sql migrations, see
  `echo-migration/src` for examples, don't write sea orm style migrations
- Add new migrations to `echo-migration/src/lib.rs`
- Afterwards run `just migrate-up` to apply the migration locally, you can undo last migration via `just migrate-down`
- If you want to manually un-apply a migration -- don't forget to
  delete it from the table like this `delete from seaql_migrations
  where
  version='m20250615_135039_battle_unit_is_flight_journal_enabled';`
- NEVER edit old and existing migrations (unless not committed yet)
