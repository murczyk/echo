# Durable research memory

With `ai_agent_work_memory_enabled: true`, every delivered read-tool result is
stored in PostgreSQL before the runner continues. Validated compaction summaries
are saved before replacing context. Records survive cancellation, worker restart,
and effort changes; a stopped request is never silently resumed. Published maps
keep their existing independent storage.

A new request receives a bounded recap from the latest preceding run with saved
work, including its latest readable checkpoint and newest record. It can use `echo_work_list` to discover older runs and `echo_work_read` to
retrieve their records. Retrieval is optional: saved findings are dated,
potentially incomplete evidence, and the new request decides what to reuse or
verify. No hidden model reasoning is stored. History also retains failed and
cancelled user prompts and labels partial assistant output as unverified.

## Storage and access

`ai_agent_work_record` belongs to a request and is deleted when its request is
physically deleted. Conversation deletion immediately prevents retrieval. Records
are excluded from analytics replication. Each request permits 512 records,
512 KiB per record, and 64 MiB total. Reaching a limit or failing durable storage
stops further research explicitly; it does not report unsaved work as preserved.
Retries use the same sequence and payload, making a lost acknowledgement safe.
Cancellation wins the request lock before any subsequent append.

The append endpoint requires a live, request-bound agent session. It cannot write
another request and does not consume research-tool calls. Retrieval is restricted
to earlier terminal requests of the same human and conversation. Role, group,
zone, and device visibility changes invalidate saved access scopes. Message and
file references are rechecked when recalled; a checkpoint is withheld if any of
its recorded dependencies is unavailable. Tool output without verifiable source
references is kept but withheld on recall, except the current-user profile.
This conservative rule also applies to summaries derived from those outputs.

`echo_work_read` returns one record at a time and at most 24,000 Unicode characters
of content. Follow both `nextAfter` and `nextOffset`; a nonzero offset continues
the same record. `unavailable` records advance the cursor without exposing their
content. Work-list pagination uses `nextBeforeRequestId`. Recaps are limited to
8,000 characters and never replace the authoritative journal.

## Rollout and recovery

The option defaults to disabled so old deployments continue normally. Deploy the
application and both #3770 migrations, upgrade each selected namespace to the
matching immutable harness release with `just ai-control-panel upgrade`, verify
connectivity, then set `ai_agent_work_memory_enabled: true` in its Echo config and
restart the API and background worker. Use the control panel's maintenance lease
to drain requests before changing a namespace; never interrupt a user's research
to force an upgrade. See `echo-ai-agent/CONTROL_PANEL.md` for recovery journals and
namespace backups. Exclusions must be synchronized before migrations by the
normal deployment process.

Harness `2026.10.11.2` retains the dispatcher concurrency guards already deployed
on the Ukrainian agent host: per-container locks, bounded lifecycle waits, and
shared deployment leases. Runtime preparation preserves those lock files.

To disable, drain current requests, set the option to false, and restart both
services. Stored records remain available for later re-enablement. Keep the
schema when rolling back application or runner code; migration down deletes the
journal table and must not be used as a routine rollback. Previously interrupted
runs have only whatever snapshots, citations, and maps were already saved; their
old unsaved tool output cannot be reconstructed.

## Validation

Database regressions in `wdintel-rs/src/ai_agent/bootstrap_tests.rs` cover cancelled
work, sequence retries, source revocation, pagination, request isolation, and live
session binding. `echo-ai-agent/runner/work-memory.test.ts` checks persistence
failure and lost acknowledgements. `echo-ai-agent/runner/checkpoint-recovery.test.ts`
exercises saved tool results and validated checkpoints through the actual SDK
provider/recovery flow.
