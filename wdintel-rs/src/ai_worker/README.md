# AI queue reliability

Callsign, settlement, and position workers share primary/fallback execution and
durable progress reporting. Each worker's existing engine remains the primary;
the optional fallback is configured in its admin settings. Select distinct,
enabled text-extraction engines, for example Luna as primary and Gemma as
fallback. Enabled workers protect both selected engines against disable/delete.

With fallback configured, each attempt has a 20-second deadline. Errors,
timeouts, and invalid extraction responses trigger fallback for the same entry.
A successful primary never calls fallback. Without fallback, existing
single-engine deadlines remain. Direct-submit previews retain their existing
outer preview deadline. Admin evaluation still tests each selected engine alone.

Both attempts must fail before the job is retried. Existing parser results,
user overrides, settlement group restrictions, reviewed/manual locations,
source freshness checks, and transactional persistence still apply. Position
results record the engine that supplied the accepted extraction. Failure
records retain bounded error chains and log the first failed attempt.

## Progress

`ai_worker_progress` holds one row per queue. Success updates progress in the
same transaction as results, including valid empty or unchanged results.
Failed, stale, cancelled, or rolled-back completions cannot advance success.
Callsign reparse runs keep their separate run status and do not advance the
normal queue's success clock.

- `last_completed_at`: latest successful committed processing time.
- `latest_processed_entry_created_at`: greatest original
  `signal_message.created_at` processed, rather than a retry or extracted event
  timestamp; this detects a live worker processing old messages.
- `last_error_at` and `last_error`: latest failed job, independent of success.
  Older errors may remain after recovery.

Monitoring also returns estimated depth and oldest pending creation time.
Settlement age considers only eligible jobs under the saved group filter;
the depth estimate includes retained excluded jobs. Creation-time indexes
support oldest-job lookups. PostgreSQL statistics are approximate, so the
nullable oldest timestamp determines whether eligible work exists.
AI snapshots are cached for 60 seconds, including the group-filtered backlog
lookup, to keep monitoring polls from repeatedly scanning excluded history.

## API and rollout

Existing `POST /api/admin/ai-*/worker/save` endpoints retain `aiEngineId` for
primary and add `fallbackAiEngineId`. Omission preserves a saved fallback for
older clients; explicit `null` clears it. Prompt-only saves preserve the pair.

Apply `m20261027_153932_ai_worker_fallback_monitoring` before the backend update.
New columns are nullable, existing primary IDs and enabled flags are preserved,
and no historical completion time is invented. Settings, queue tables, and
progress are excluded from analytics replication; sync the packaged exclusion
list through the normal deployment procedure before migration. Configure
fallback after deployment; migration does not change engines or requeue history.

Publish future recurring queue-health query results in shared monitoring and
corresponding Sergeant alerts, following the
[monitoring contract](../server/README.md), rather than leaving them only in
one-off SQL or archives.

Regression coverage: `wdintel-rs/src/ai_callsign/worker/fallback_tests.rs`,
`wdintel-rs/src/ai_settlement/worker.rs`,
`wdintel-rs/src/ai_position/worker.rs`, and
`wdintel-web/tests/e2e/admin-ai-worker-fallback.spec.ts`.
