# General project info

- Read README.md to understand the general project purpose

## Code style and checking

- keep code formatted with `cargo fmt`
- keep front-end code formatted with Prettier via `cd wdintel-web && npm run format:staged`
  after editing TS/TSX/JS/CSS/JSON files; use `npm run format:all`
  only when intentionally formatting the whole front-end tree
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

## Git

- **Never Commit or Push Without Permission**
- **NEVER** run `git commit` without explicitly asking the user first
- **NEVER** run `git push` without explicitly asking the user first
- Always show the user what changes you've made and ask for permission before committing
- Use `git status` and `git diff` to show what will be committed
- Even for urgent fixes or reverts, always ask before committing/pushing. The user needs to be aware of what's being changed in their repository.
- When proposing commit messages, use Conventional Commits with a past-simple summary (for example: `fix(navbar): redirected login correctly`).
- When asked to suggest or draft a commit message, ALWAYS use `.github/skills/conventional-commit-branch-scope/SKILL.md`.
- Derive commit scope from the current branch name when possible, and do not replace a branch-derived ticket scope with ad hoc module scopes like `palettes` or `navbar`.
- Do not mention Cursor (or other editor/assistant products) in commit messages; keep summaries about the codebase only.

## Changelog

- Every new `CHANGELOG.md` entry must include a GitHub reference in the beginning: issue (`[#123](https://github.com/echoua/echo/issues/123)`).
- Before asking the user for a GitHub issue number, try to extract it from the current git branch name. If the branch contains project key + number (for example `ABC-123`), use both when reporting the detected issue reference. If the branch contains only a number (for example `123`), use the number only.
- Prefer following `.github/skills/changelog-next-update/SKILL.md` for exact `NEXT` formatting and phrasing style.
- If the GitHub issue number is unknown, ask the user for it and do not add placeholder markers like `TODO` to `CHANGELOG.md`.

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
- migration names contain the datetime of when the migration was created, use current datetime when creating one if you create it manually (for example, `m20250615_135039_battle_unit_is_flight_journal_enabled` means it's created in 15 JUN 2025, at 13:50:39 local time)

## Code gen

- run `just gen-seaorm` after you've made some schema changes in the database to regenerate sea-orm models
- run `just gen-front` to generate Elm front-end bindings from back-end definitions (types listed in elm.rs)

## Constants

- Keep constants in central config.rs, prefixed by their overall module or logical group. Avoid hard-coding inlined constants when possible
- Don't reuse constants too much, better keep separate, same-prefix different constants

## Fail fast

- Don't overly-obsess yourself with failing via AppError::BL with clear error messages. Most of the time, fail fast via `.c(h!())?`, let the developer see the line where the error happened
- add context with data value when needed but only in rare cases
- when writing function that must not fail (like infinite loop workers), move out inner loop body in regular AppError-Result function, and call it from the no-fail one, use `.c(h!())?` in AppError one for errors, don't fill the code with too many `match ... Err ...` blocks

## Frontend (Elm)

### Type generation

- **NEVER** manually write backend types, encoders, or decoders on the frontend
- All backend types are defined in `wdintel-rs/src/elm.rs`
- Run `just gen-front` to generate Elm bindings from backend definitions
- Generated types, encoders, and decoders appear in `wdintel-web/src/Bindings.elm`
- When you need a new type on frontend - add it to `elm.rs` first, then regenerate
- Front-end is using the Elm Land framework https://elm.land/guide/ ,
  use its `elm-land` command-line utility to manage pages etc.

### Compilation and checking

- Check the modified file(s) using: `elm make path/to/file.elm --output=/dev/null`
- This is much faster and sufficient to verify syntax and type checking
- Example: `cd wdintel-web && elm make src/Pages/RerPalitra.elm --output=/dev/null`
- Once you're fully done with changes, verify yourself with `just build-front` to check full front-end build

### HTTP error handling

- **ALWAYS** handle API errors and show them to users via toasts
- Use `Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails` for Shared toasts (no need to add toasts to model):
  ```elm
  SomeApiResponse (Err err) ->
      ( model
      , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка опису" err
      )
  ```
- This automatically:
  - Handles 401 errors (triggers logout)
  - Shows user-friendly Ukrainian error messages
  - Displays error details in toast notifications
- **NEVER** silently ignore API errors - users must see what went wrong

# Token-efficient Codex policy

## Goal
Solve tasks correctly with strong reasoning, but minimize visible output tokens.

## Default behavior
- Keep reasoning effort unchanged unless I explicitly ask to lower it.
- Be concise by default.
- Do not restate the task.
- Do not explain reasoning unless I explicitly ask.
- Prefer the smallest complete answer.

## For coding tasks
- Output only one of:
  - the exact changed code, or
  - a unified diff/patch
- Do not print full files unless explicitly requested.
- Do not add comments unless necessary for correctness.
- Do not include examples, alternatives, or summaries unless asked.

## For edit tasks
- Make the narrowest correct change.
- Preserve existing style and structure.
- Avoid unrelated refactors.
- Do not rename symbols unless required.
- Do not modify unrelated files.

## For question-answering
- Answer in 1–4 short sentences unless I ask for detail.
- Prefer direct answers over background explanation.
- Use bullets only when they save tokens.

## When assumptions are needed
- Choose the most conservative reasonable assumption and proceed.
- Mention assumptions only if they materially affect correctness.

## Output formatting
- If I ask for code: output code only.
- If I ask for a fix: output patch or changed code only.
- If I ask for commands: output commands only.
- If I ask for JSON: output valid JSON only.

## Quality guardrail
- Never trade correctness for brevity.
- Optimize visible output tokens, not solution quality.

## Markdown formatting
- Start markers such as `**A.**` and `**B.**` in new paragraphs.
- Separate them from preceding text with a blank line.
- Never rely on a single source newline to create a visible line break.
