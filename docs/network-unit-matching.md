# Network matching by parsed units (#3842)

Frequency, interception time, overlapping group/network areas, and post
restrictions determine eligible networks. Among those candidates, exact
`kind = parsed` unit IDs take precedence over stored unit names. Only
non-deleted network units participate. Keep every candidate with a matching
parsed unit, including multiple matches. If no parsed unit matches, apply the
existing name/hierarchy heuristics; missing or unrecognized units do not remove
otherwise eligible networks.

Changes to parsed links on messages with saved networks recalculate those
networks in the caller's transaction, replace derived `kind = network` unit
links, invalidate frequency activity, and queue group statistics. Normal message
imports calculate networks after resolving units. Unchanged parsed IDs avoid
replacing links or recalculating networks during ordinary resolution.

The inbox-unit backfill recalculates networks once per 500-item transaction,
even when parsed IDs remain unchanged. This repairs existing stale assignments
without running a network calculation per item. Its creation-time bounds,
resume cursor, and source-row locking remain as documented in
[the unit-resolution backfill](ORBIT.md#resolve-unparsed-unit-labels-through-orbit-links).
Parsed-link reads use existing indexes and project only item/unit IDs in
chunks of at most 500; see
[scale-plan evidence](query-plans/3842-network-parsed-units.md).

## Historical reconciliation

An upgrade does not rewrite stored assignments. After approval for the named
host, enqueue the existing network backfill on that host:

```sh
sudo wdintel-rs --mode=live oneoff-backfill-inbox-networks
```

The command queues repair for the last 367 days, clipped to the current time.
It does not process records synchronously. To start with a smaller interval,
pass explicit UTC interception-time bounds, for example:

```sh
sudo wdintel-rs --mode=live oneoff-backfill-inbox-networks \
  --start 2026-10-19T00:00:00 --end 2026-10-20T00:00:00
```

Both bounds are inclusive; adjacent windows may overlap safely. Bounds older
than the retention window are clipped. The recent worker handles the latest
40 days; older work follows the configured old-worker hours. Network calculation
must be enabled. This operation changes assignments, derived units, frequency
activity caches, and queued statistics; it does not require migrations or an
analytics resnapshot.

Watch `wdintel-rs --mode=live network-invalidation-tui` and background-worker
logs until both recent and old queues finish. Confirm representative ambiguous
messages now contain only the expected networks and derived units, while
messages without a matching parsed unit retain the legacy fallback. Wait for
queued group statistics and frequency recalculation before comparing counts
and activity. The daily consistency checker reports mismatches for today's
messages; it is diagnostic and does not repair them.

If errors or database load become unacceptable, stop submitting additional
ranges and investigate the failing task. Successful batches remain committed;
failed work is retried by the existing worker. Re-enqueueing a reviewed range
is idempotent. Any service stop, rollback, or further real-environment repair
requires approval for that operation and host. Rolling back code alone does
not restore assignments already recalculated.
