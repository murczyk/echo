# Automatic network cleanup (#4093)

Cleanup rechecks each selected frequency after locking its network and current
frequency rows. Moved or renamed candidates wait for the next pass. Recent
activity uses interception datetime, then message timestamp, then message
creation time; deleted messages do not count.

A non-deleted frequency created less than two hours ago defers network shutdown
when its activity interval overlaps the ten-day lookback. Deferred shutdown
rolls back frequency closures, location deletion, and shutdown audit entries.
An earlier network-start correction still commits and queues frequency-scoped
reconciliation, including interceptions without an existing network link.
Location deletion otherwise commits atomically with frequency shutdown, with
location rows locked in ID order across all affected frequencies.
The activity recheck uses separate dated and undated probes; see its
[query plans and limits](query-plans/4093-network-cleanup.md).

## Previously incorrect shutdowns

Deployment applies the new cleanup safeguards; it does not reopen
historical network or frequency closures. Existing synthetic-inactivity repair
retains its narrower audit-based criteria. No migration, analytics resnapshot,
or full-mirror rebuild is required by this change.

1. Inspect the network and frequency activity logs and interception timestamps.
   Identify the cleanup decision, intended activity interval, and any later
   manual changes. Preserve later manual closures and interval corrections.
2. Obtain approval naming the environment, affected network/frequency IDs, and
   intended activity changes before repairing real data. Restore the reviewed
   activity ranges through the existing network/frequency editing or
   reactivation UI. Reactivation records a user activity decision; activity
   changes enqueue assignment reconciliation and frequency-activity
   recalculation.
3. Watch `network-invalidation-tui` and worker logs until assignment and activity
   queues finish. Check representative interceptions, derived units, frequency
   activity, and counts after queued statistics refresh. Reopening activity does
   not restore deleted frequency locations; review and restore those separately
   if needed and approved.

Do not run a broad inbox-network backfill as a substitute for correcting the
activity ranges: matching still excludes interceptions outside those ranges.
Any additional backfill, rollback, or environment repair needs approval for its
operation and target. Code rollback alone does not reverse committed repairs.
