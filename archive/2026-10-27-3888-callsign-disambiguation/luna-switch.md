# Approved queue clear and Luna switch

On 2026-10-27 the user explicitly approved clearing the pending work and then
switching to Luna on `echo-skhid`, `echo-siversk`, `echo-pivnich`, and `echo-zp2`.
This supersedes the earlier read-only investigation scope for these operations.
The subsequent approved recovery switch is recorded in
[gemma-switch.md](gemma-switch.md).

## Completed changes

Each server committed one transaction that:

1. Verified the expected GLM and Luna settings and absence of active callsign
   reparse runs. Preflight found no incoming foreign keys or custom triggers on
   the three queue tables.
2. Truncated `ai_callsign_worker_job`, `ai_settlement_worker_job`, and
   `ai_position_worker_job`, without `CASCADE`.
3. Enabled the existing `GPT-6 Luna` engine's `callsign_enabled` capability and
   selected that engine for callsign, settlement, and position workers. The
   configured backend identifier is `gpt-6-luna`.
4. Updated settings timestamps and notified the settlement worker through its
   existing settings-change channel.

All three queue counts were exactly zero inside each committed transaction.
Message tables and existing extraction result tables were not changed by these
transactions. Ordinary ingestion and already-running work continued; no service
restart, software deployment, grant change, or credential change was performed.

| Server | Commit time UTC | Selected Luna engine ID |
| --- | --- | --- |
| echo-skhid | 15:13:02.628925 | `01a12aa3-59d2-7d50-81db-37a2f2f32465` |
| echo-siversk | 15:14:11.871623 | `01a11c1f-ea3c-74f8-83cb-829a336443e4` |
| echo-pivnich | 15:14:12.943711 | `01a12ab9-2424-7fe1-a12b-678f41ce2e99` |
| echo-zp2 | 15:14:13.889528 | `01a129fe-b5db-7461-9779-d88f3a7ddf78` |

## Verification and remaining provider failure

Read-only checks at approximately 15:15:03 UTC confirmed all twelve worker
settings selected an enabled Luna engine with callsign capability enabled.
Remaining jobs were new arrivals; none of the three queues on any server
contained a job created before 15:00 UTC.

| Server | Callsign jobs | Settlement jobs | Position jobs |
| --- | ---: | ---: | ---: |
| echo-skhid | 180 | 180 | 180 |
| echo-siversk | 16 | 16 | 16 |
| echo-pivnich | 57 | 57 | 58 |
| echo-zp2 | 5 | 5 | 5 |

Successful Luna inference was not established. Fresh settlement failures on
all four servers contained:

```text
HTTP 429 Too Many Requests: error code: 1015
```

Fresh position failures on skhid and pivnich contained the same response.
Skhid already had jobs at five failed attempts approximately two minutes after
the switch. The selected engine configuration is confirmed; provider acceptance
of its model identifier and successful extraction remain unverified behind
this gateway rate limit. The gateway's earlier `gpt-luna` grant label does not
by itself establish whether `gpt-6-luna` is an accepted alias.

A direct model-list probe from the operator workspace was separately rejected
by the gateway edge with HTTP 403 / Cloudflare 1010. No further direct provider
probes were made after that denial; verification used existing worker results.
Credentials and tokens were kept in memory and were not copied to this archive.

The queue clear and worker switch are complete, but AI service health is not
restored. The configured workers continue accepting and retrying fresh jobs.
Further recovery, such as a provider-level cooldown, pausing outbound work
while retaining incoming jobs, changing a backend alias, or changing the grant,
must be separately scoped and approved. Repeatedly clearing the newly forming
queues would discard new work and is not part of this completed operation.
