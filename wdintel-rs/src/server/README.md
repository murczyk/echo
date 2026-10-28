# Operational monitoring

`POST /api/monitoring` returns datasource freshness, root disk space, and an
`ai` object with `callsign`, `settlement`, and `position` entries. Names use
snake case. Each AI entry contains:

| Field | Meaning |
| --- | --- |
| `enabled` | Worker configured to run. |
| `last_completed_at_ms` | Latest successful committed processing time, or `null` before first success. |
| `latest_processed_entry_created_at_ms` | Greatest original message creation time processed, or `null`. |
| `oldest_pending_created_at_ms` | Oldest eligible pending job creation time, or `null` without eligible work. |
| `pending_jobs_estimate` | PostgreSQL estimated row count, including retained excluded settlement jobs. |
| `last_error_at_ms` | Latest failed-job time, or `null`; retries are not success. |

Timestamps are UTC epoch milliseconds. Durable progress survives restarts and
advances for successful extractions with no candidates. The endpoint reads
state and caches the response for `SERVER_MONITORING_CACHE_TTL_SEC` (5 seconds).
AI snapshots have a separate `AI_WORKER_MONITORING_CACHE_TTL_SECS` (60 seconds)
cache to bound group-filtered backlog queries; allow this delay when checking
fresh progress or configuration changes. Polling does not write a heartbeat
or request AI inference.

[Echo Sergeant](https://github.com/echoua/echo-sergeant) alerts for stale
success, old processed input, and overdue eligible work. Disabled and empty
queues are not outages. Sergeant tolerates missing `ai` on older Echo versions
during rolling upgrades. See [AI queue reliability](../ai_worker/README.md)
for fallback and persistence behavior.

## Extending operational monitoring

When an incident or investigation introduces a recurring health query,
publish its useful result here under the owning section and update Echo
Sergeant's checks and corresponding README. Essential health knowledge must
not remain only in ad-hoc SQL, shell output, or task archives.

Document units, timestamp source, null/idle/disabled semantics, caching, and
alert conditions together. A loop heartbeat is not successful processing.
Keep probes read-only; use durable success records when completed queue rows
are deleted. Validate bounded/indexed plans and cover stalled, retrying,
idle, disabled, startup, and recovered cases. Do not expose message bodies,
secrets, or raw model responses in monitoring.
