# RER duty callsign highlight handoff

## Done

- Investigated echo-pivnich data for `Авіа Бар'єр`.
- Confirmed sample message `sigint_inbox_item.id = 25613251` already has `callsign_tokens` for `44549` and `Саксофон`.
- Found nearby same-group messages with active `sigint_inbox_item_callsign` rows but empty `sigint_inbox_item.callsign_tokens`, for example `25628266` and `25644962`.
- Identified likely cause in `wdintel-rs/src/ai_callsign/worker.rs`: AI callsign worker cleared `callsign_tokens` to `[]` when replacing primary callsigns.
- Locally changed the worker to regenerate `callsign_tokens` from the updated callsign list and message body, and to refresh stale empty stored tokens.
- Ran `cargo fmt`.

## Pending

- Re-run validation:
  - `cargo test -p wdintel-rs ai_callsign::worker`
  - `cargo check`
  - `cargo clippy`
- Review `git diff -- wdintel-rs/src/ai_callsign/worker.rs`.
- Decide whether to backfill production rows where callsigns exist but `callsign_tokens` is empty.
- If backfilling, prefer using existing `oneoff-reprocess-callsign-tokens` or a small targeted reprocess for affected echo-pivnich IDs/groups.
- Deploy after checks pass and confirm new/updated AI callsign worker jobs keep highlights visible on `/rer-duty-neo`.

## Notes

- The long `cargo test -p wdintel-rs ai_callsign::worker` and later `cargo check -p wdintel-rs` were interrupted before completion.
- The leftover compiler process from the interrupted check was stopped.
