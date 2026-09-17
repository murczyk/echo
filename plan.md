# SIGINT unit parsing on echo-cbr

## Reported failure

On `/rer-duty-neo`, open the `+` drawer, paste this message, and press
`РОЗПАРСИТИ`. The unit field remains empty:

```text
24 обБпС рБпЛА вБпЛА КТ  | 2026-09-16
17-45
- С тест
```

## Findings

- Read `README.md` and `CODE_REVIEW.md`. The working branch is `main`, with
  no issue number in its name.
- Connected to `echo-cbr` over SSH for read-only inspection. Its hostname is
  `ct-echo-cbr`; inspected PostgreSQL database `wd`.
- Labels are stored in `sigint_unit_label`, not a `label` column on
  `sigint_unit`.
- The exact label exists: ID `8`, created at
  `2026-09-17 12:16:23.473897`, linked to unit ID `50207`.
- Unit `50207` is active and not deleted. Its canonical name is
  `взвБпЛА КТ рБпЛА 24 обБпС 7 дшд`; battalion is `24 обБпС`, company is
  `рБпЛА`, and platoon is `взвБпЛА КТ`.
- No unit has the exact label text as its canonical `name`. This is normal
  for a synonym; the production mapping is valid.
- Frontend file
  `wdintel-web/src/ts/react/routes/shared/manage-message/useMessageParser.ts`
  fills `network_name` from `parsed.unit`, but fills the unit field only
  from `parsed.unit_v2`.
- Backend file `wdintel-rs/src/sigint/direct_submit/bl.rs` extracts the unit
  with `unit::parser::extract_unit_with_aor`, then calls
  `inbox::parse_unit_v2` to obtain `unit_v2`.
- Before the local change, extraction had no explicit support for
  `<unit label> | YYYY-MM-DD`. Generic recognition uses known unit notation
  and `has_unit`, which requires more than one recognized library segment
  and does not consult registered labels.
- `inbox::parse_unit_v2` calls `unit::parse_unit`. Its cached existing-unit
  names come from `sigint_unit.name`, not `sigint_unit_label`. Merely
  extracting this header therefore would not reliably resolve the synonym.
- The existing inbox resolver in `wdintel-rs/src/inbox/unit_resolution.rs`
  already supports normalized exact label matching: whitespace collapsing,
  case folding, deleted-unit exclusion, and ambiguity rejection.
- `wdintel-rs/src/rer_importer/body_noheader.rs` already recognizes
  pipe-separated ISO-date headers, including `_HH-MM-SS` suffixes.
- Diagnosis is based on local source and confirmed production data. No
  authenticated production parse API request or browser reproduction was
  performed. The deployed source revision was not compared with local `main`.

## Fix suggestions and implementation — done locally

1. Extract the unit text explicitly from the first nonempty line for
   `<unit> | YYYY-MM-DD`, also allowing `_HH-MM-SS` after the date.
   Implemented in `wdintel-rs/src/unit/parser.rs`. Date text is excluded;
   this header itself supplies no locality.
2. Resolve the extracted text using the existing exact unit name/label
   resolver and return the canonical unit name as `unit_v2`.
   Implemented in `wdintel-rs/src/sigint/direct_submit/bl.rs`. Existing
   parsing remains the fallback when exact resolution finds no unit.
   No frontend change or global cached-parser change is needed.
3. Add operational regressions. Added parser fixture
   `extract_unit_dated_label_header` for both date variants. Extended
   `direct_submit_parse_suggests_inbox_fields` to seed the canonical unit
   and label, parse the reported message, and assert the extracted label
   and canonical `unit_v2`.

The local fix changes only these two Rust files. No schema, frontend,
production data, deployment, commit, or push changes were made.

## Validation — completed

- `cargo check -p wdintel-rs` passed in approximately five minutes.
- `cargo fmt --all -- --check` passed after narrowly applying reported
  formatting corrections. No whole-file formatting rewrites were applied.
- `just build-front` passed.
- `git diff --check` passed before writing this document.
- Cargo reported a future Rust compatibility warning for dependency
  `proc-macro-error2 v2.0.1`; it did not fail `cargo check`.

## Validation — blocked / incomplete

These commands were started, but both ultimately exited with code `101`:

```bash
cargo test -p wdintel-rs direct_submit_parse_suggests_inbox_fields -- --nocapture
cargo clippy -p wdintel-rs --all-targets -- -D warnings
```

- The test spent several minutes compiling, then failed during linking:
  `collect2: fatal error: ld terminated with signal 7 [Bus error], core dumped`.
  The filesystem was subsequently confirmed full. Disk exhaustion is a likely
  contributor, but the linker diagnostic itself did not explicitly report it.
  The regression did not execute; this is not a passing test result.
- Clippy waited for the build lock and then failed creating its fingerprint
  directory with `No space left on device (os error 28)`. No Clippy pass was
  obtained.
- The standalone `extract_unit_dated_label_header` fixture has not run.
- Writing `plan.md` initially failed because `/dev/nvme0n1p2` had zero
  available space. Removed only the abandoned approximately 2.2 GB linker
  temporary file from this test build:
  `target/debug/deps/wdintel_rs-50f1d4d1ac5da0f9.tmp463b70a`.
- Both Cargo processes had already exited when cleanup was attempted.
  Previous tool sessions were `4928` (test) and `79104` (Clippy); previous
  process IDs were `54600` and `54667`. No validation build is still running.

## In progress

- Local implementation is ready for review, but validation is incomplete.
- This document records the handoff; further builds were not restarted while
  documenting the findings.

## Remaining work

1. Ensure sufficient disk space before retrying Rust validation. The removed
   temporary file alone may not provide enough for another debug test link.
   Do not delete unrelated user data. Consider targeted build-cache cleanup
   or running validation on a build machine with sufficient space.
2. Re-run the functional regression and Clippy commands above. Run the parser
   fixture with:
   `cargo test -p wdintel-rs extract_unit_dated_label_header -- --nocapture`.
   Update this document with actual results; fix any patch-related failures.
3. Review the final diff and assess dated-header behavior against existing
   operational parser fixtures. Repeat relevant checks if code changes.
4. Compare the deployed echo-cbr revision with the intended release. The
   local patch has not been deployed.
5. If adding a changelog entry, obtain the GitHub issue number first because
   `main` provides none. Do not add placeholder references. Follow
   `.github/skills/changelog-next-update/SKILL.md`.
6. Obtain explicit permission before committing or pushing, showing
   `git status` and `git diff` first. Use
   `.github/skills/conventional-commit-branch-scope/SKILL.md` when drafting
   the commit message.
7. With deployment authorization, ship through the normal release process.
   Repeat the exact `+` → paste → `РОЗПАРСИТИ` flow on echo-cbr; the unit
   field should contain `взвБпЛА КТ рБпЛА 24 обБпС 7 дшд`.

Do not recreate or change the production label: its mapping is already correct.
