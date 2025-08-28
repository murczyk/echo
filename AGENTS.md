## General project info

- Read README.md to understand the general project purpose

## CODE STYLE AND CHECKING

- keep code formatted with `cargo fmt`
- keep `cargo clippy` clean
- run `cargo check` for rust check
- run `just build-front` to build front-end code
- Avoid big functions. If a function becomes too big -- turn it into a
  chain of calls for smaller functions with a clear self-descriptive
  name
- Avoid naming variables `model`. Name them after their entity, prefer
  reusing the same name by redefining it, if it is not needed in the
  rest of the function. If you need both active and regular model
  value -- use suffix, like `let datasource = ...` (for type
  `datasource::Model`), `let datasource_act =
  datasource.into_active_model()`, but prefer same `datasource` for
  both if possible

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
- run `just gen-seaorm` after you've made some schema changes in the database to regenerate sea-orm models

## Code gen

- run `just gen-seaorm` after you've made some schema changes in the database to regenerate sea-orm models
- run `just gen-front` to generate Elm front-end bindings from back-end definitions (types listed in elm.rs)

