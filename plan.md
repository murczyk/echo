# GOI commented-message CSV unescape follow-up

## Current state

- `comments_goi.csv` was inspected locally.
- The malformed export is in the `body` column: literal Excel escape markers like `_x000d_` appear in exported message text.
- Local CSV inspection found `_x000d_` in 1928 `body` values and not in `comment`, `source_login`, or `source_organism`.
- The issue is not the Rust `csv` writer. The GOI fallback message body path exported raw GOI row cell text without applying the Excel unescaper.

## Implemented changes

- Added shared `goi_echo_worker::row::unescape_excel_text`.
- Applied it when reading GOI association string cells.
- Applied it when reading GOI knowledge string cells.
- Reused it in `wdintel-rs/src/organism/goi/message_uid.rs` instead of the private `_x000d_`-only normalization.
- Applied it in `wdintel-rs/src/sigint/comments.rs` for:
  - GOI association note comments.
  - fallback original-message bodies from stored GOI row JSON.
  - mapped GOI export bodies loaded from `signal_message.body`.

## Files changed

- `goi-echo-worker/src/row.rs`
- `goi-echo-worker/src/knowledge.rs`
- `wdintel-rs/src/organism/goi/message_uid.rs`
- `wdintel-rs/src/sigint/comments.rs`

## Verification completed

- `cargo fmt` completed successfully.
- `cargo test -p goi-echo-worker unescapes_excel -- --nocapture` passed.
- `cargo check -p wdintel-rs` completed successfully.

## Interrupted or pending verification

- `cargo test -p wdintel-rs goi_association_original_message_for_export_unescapes_excel_body -- --nocapture` was interrupted after a long cold backend build.
- Still need to run:
  - `cargo test -p wdintel-rs goi_association_original_message_for_export_unescapes_excel_body -- --nocapture`
  - optionally `cargo clippy` if preparing a final branch check.

## Remaining functional check

- Re-export `oneoff-export-commented-messages --kind goi-associations` against `echo-pivnich`.
- Verify the regenerated CSV has no literal Excel escapes in exported text, especially `_x000d_`, `_x000A_`, and `_x005F_`.
- Compare a few rows against `comments_goi.csv` to ensure row counts and intended line breaks are preserved.

## Repository notes

- Existing untracked files observed and left untouched:
  - `comments_goi.csv`
  - `chumak_qna.md`
- No commit was made.
