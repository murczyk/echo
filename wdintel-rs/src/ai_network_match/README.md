# AI network match

Network matching (`sigint/network/etalon_calc`) links a message to every
network whose frequency, AOR and active period fit, then narrows by post, unit
and settlement. On busy bands one message can still match up to eight
networks. This worker scores each candidate network so the message card can
show the most likely network and fold the rest under «і ще N»
([#4095](https://github.com/echoua/echo/issues/4095)).

## Gating

The system setting `ai_network_match_enabled` («ШІ: головна мережа
повідомлення», off by default) gates everything. When it is off, no jobs are
queued or processed, the inbox API returns no `network_match`, and the network
drawer hides «Опис для ШІ»: Echo behaves as before.

The worker uses the AI callsign parsing worker's primary and fallback engines
(usually Luna, with `ai_worker::with_fallback`), so that worker must be enabled
with an engine selected. There is no separate engine or prompt setting. The
compiled prompt lives in
[`ai-eval/2026-11-09-network-match-prompt`](../../../ai-eval/2026-11-09-network-match-prompt/README.md).

## Queueing

Both writers of message–network links call `enqueue_for_calculated` with the
new links: `calculate_sigint_inbox_item_networks` and the direct-submit copy of
a source message's links (`copy_inbox_networks`). A message is queued in
`ai_network_match_worker_job` when it has 2–12 distinct networks and both its
receive time and intercept time are within the last 48 hours. The age limit
stops network edits, which recalculate old messages in bulk, and historical
imports from flooding the engine.

A recalculation queues the message even when it already has scores, because a
frequency, unit or post edit can change a candidate network without changing
the candidate set. The worker drops such a job without an AI call when the
stored candidate set and input hash still match.

Message edits (body, frequency, post) delete the stored result before the
links are recalculated, so the message is queued again. Editing a network's
name, description fields or «Опис для ШІ» (`update_network`) relinks nothing,
so it queues a recalculation of the network's messages intercepted in the
last 48 hours (`request_network_rescore`, a network invalidation task). The
network edit itself takes no message locks; the invalidation worker queues the
jobs in batches. Callsign edits take effect at the next recalculation or for
new messages.

## Processing

`worker.rs` runs one instance across processes (advisory lock
`AI_NETWORK_MATCH_WORKER_LOCK`). For each job it sends the message text,
frequency, time, post, unit and DMR metadata parsed from the text, plus each
candidate's name, location, purpose, modes, radio station, frequencies, units,
posts, callsigns and «Опис для ШІ». Candidates are numbered keys, so the model
cannot name a network outside the set. A reply with unknown or duplicate keys
fails the attempt; a candidate the model leaves out scores 0.

Before storing, the worker locks the message and the job, rebuilds the model
input, and checks that its hash and the candidate set did not change during the
call, so edits to the message, its metadata or a candidate network are not
lost. If they did, the job runs again without counting an attempt.
Re-queueing a pending job bumps its `generation`, and the worker deletes a job
only at the generation it read, so a request made during scoring runs again. Failures
back off exponentially (5 s doubling to 300 s) and the job is dropped after 8
attempts. Progress and the last error are recorded in `ai_worker_progress`
under `network_match` and published in `POST /api/monitoring` as
`ai.networkMatch`.

## Display

`InboxMessage.network_match` is filled only when the stored candidate set
equals the message's current networks. `confident_network_id` is set when the
best certainty is at least 80 and leads the runner-up by at least 20
(`AI_NETWORK_MATCH_CONFIDENT_*` in `config.rs`). The React card behaviour is
described in the
[message card contract](../../../docs/frontend/react-behavior-contracts/message-card.md#ai-network-match).
Classic Elm views ignore the scores and list every network.

## Rollout

1. Deploy with the migration `m20261109_104428_ai_network_match`. Both new
   tables are excluded from analytics replication.
2. Make sure the callsign parsing worker is enabled, and check on that server
   that its engine accepts the strict `response_format` used here.
3. Enable «ШІ: головна мережа повідомлення» in the system settings. Analysts
   can then fill «Опис для ШІ» on networks; an edit rescores the network's
   messages from the last 48 hours.

Tests: `ai_network_match/tests.rs`, `ai_network_match/inference.rs`,
`system_settings/mod.rs` (`issue_4095_*`), and the React specs listed in the
contracts above.
