# network-last-activity timeout investigation

Date: 2026-09-12
Host checked: `echo-siversk`

## Investigation

- The endpoint is `POST /api/sigint/network-last-activity` in
  `wdintel-rs/src/sigint/network/mod.rs`.
- The endpoint currently deduplicates up to
  `NETWORK_LAST_ACTIVITY_BATCH_MAX_NETWORKS` network IDs, then calls
  `load_network_last_activity` from `wdintel-rs/src/sigint/network/bl.rs`.
- `load_network_last_activity` runs a raw aggregate over linked inbox items,
  messages, datasource groups, signal groups, and active network frequencies.
  This is a fresh PostgreSQL aggregate per requested page/batch.
- The React RER networks page calls this endpoint asynchronously from
  `wdintel-web/src/ts/react/routes/rer-networks-neo/use-rer-networks-neo-page.load.ts`
  when the main list response did not already include last activity.
- Live `echo-siversk` state during checks:
  - load average was very high, around `160-172`;
  - memory was not the bottleneck: 32 GiB total, around 18 GiB available;
  - sampled `pg_stat_activity` did not show a single stuck
    `network-last-activity` query or long-running active app query;
  - analytics health was unhealthy, so some routes were falling back to
    PostgreSQL, adding background pressure;
  - `network_freq_last_datetime_in_aor` had `0` rows;
  - `network_recalculation_task` had no pending rows at the sampled time;
  - `sigint_network_freq` had 841 active frequency rows, with 209 having
    `last_seen_dt`.

Likely cause: the endpoint is doing expensive raw activity aggregation on a
loaded host and bypassing the existing per-login/per-frequency AOR cache.
The timeout is likely burst/load related rather than one permanently stuck
query.

## Existing Cache

The relevant existing cache is `network_freq_last_datetime_in_aor`.

- Key: `(network_freq_id, login_id)`.
- Scope: stores `group_master_keys` and `last_datetime_in_aor`.
- Freshness: controlled by
  `NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES`.
- Loader: `recalculation::load_cached_last_datetime_in_aor`.
- Current users: network frequency list/mutation responses that fill
  `NetworkFreq.last_datetime_in_aor`.

Important semantic difference: the current endpoint returns last linked
interception in the user's allowed SIGINT groups, while this cache returns last
interception inside the network/user AOR. If the RER network list should match
the frequency row's `last_datetime_in_aor`, using this cache is the right
direction. If the endpoint must preserve the old non-AOR-scoped meaning, we need
a separate cache.

## Fix Plan

1. Add a batch cache reader near
   `recalculation::load_cached_last_datetime_in_aor`.
   - Accept `network_ids`, `login_id`, and `group_master_keys`.
   - Deduplicate network IDs.
   - Load cache rows for all active frequencies in those networks in one query.
   - Reuse the existing invalidation, pending-task, TTL, and group-key checks.
   - Enqueue refresh tasks for missing, stale, or group-mismatched frequency
     rows.

2. Add an endpoint-facing rollup helper.
   - Aggregate cached `last_datetime_in_aor` rows with `max(...)` per
     `network_id`.
   - Return milliseconds keyed by network ID.
   - Keep null when no fresh cached value exists.

3. Update `/api/sigint/network-last-activity`.
   - Keep the request/response shape and duplicate/order behavior.
   - Replace `load_network_last_activity` with the cache-backed network rollup.
   - Keep role/access loading unchanged.

4. Handle cold-cache behavior.
   - `echo-siversk` currently has zero rows in
     `network_freq_last_datetime_in_aor`, so the first cache-backed responses
     would be fast but mostly null until recalculation warms the rows.
   - Preferred follow-up: teach the frontend/backend response to distinguish
     "cache pending" from "no activity" before showing "Немає перехоплень".
   - Lower-risk first deploy: return fresh cached values only and rely on
     on-demand queue warming; expect timestamps to appear after refresh.

5. Add tests.
   - Unit/functional test for batch cache rollup:
     multiple frequencies in one network, duplicate network IDs, null cache
     values, and missing frequency rows that enqueue refresh tasks.
   - Regression test that response order still follows request order.

6. Verify.
   - `cargo fmt`
   - targeted Rust test for the new helper/endpoint behavior
   - `cargo check`
   - `cargo clippy` if time allows

## Operational Follow-Up

After deploying the fix to `echo-siversk`, watch:

- `network_freq_last_datetime_in_aor` row count and freshness;
- `network_recalculation_task` backlog for
  `network_freq_last_datetime_in_aor`;
- `/api/sigint/network-last-activity` latency;
- host load and PostgreSQL active query count.
