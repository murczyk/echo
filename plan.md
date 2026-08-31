# Etalonka Report Performance Plan

## Done

- Investigated `report_history.id = 5071` on `echo-skhid`: total runtime was about 18m27s; normal etalonka data chunks took about 3m17s; peleng map loading consumed roughly 15m before `geo-screenshot`.
- Identified the main remaining bottleneck: `load_pelengs_map` called `bl_get_network_points` once per report chunk, which meant 730 SQL calls for the one-year 12h-chunk report.
- Fixed applicable review comments in `wdintel-rs/src/sigint/etalonka/query.rs`: removed the forced `MATERIALIZED` barrier from the network messages CTE and added missing error context at new fallible period-filter helper boundaries.
- Changed peleng-map loading to merge adjacent report chunk filters before calling `bl_get_network_points`.
- Replaced the fixed 7-day peleng-map batch window with `RER_ETALONKA_PELENGS_MAP_QUERY_CHUNK_MULTIPLIER = 14`; the max map query span is now derived from the actual report chunk span times 14, so 12h chunks batch to 7 days, 13h chunks to 182h, and 18h chunks to 252h.
- Added/updated unit tests for peleng-map batching and etalonka query SQL shape.

## Remaining Work

- Re-run focused tests after the final multiplier change:
  - `cargo test -p wdintel-rs build_pelengs_map_filters -- --nocapture`
  - `cargo test -p wdintel-rs build_network_freqs_query_ -- --nocapture`
- Re-run `cargo check`.
- Re-run `cargo clippy --all-targets --all-features -- -D warnings`.
- Optionally validate production-scale behavior on `echo-skhid` after deploy by regenerating an etalonka report comparable to `report_history.id = 5071`.
- No commit has been made.
