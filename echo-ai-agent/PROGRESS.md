# Live request activity

The chat shows one current activity line and elapsed time from submission.
Earlier activity can be expanded when needed. Preparation appears before the
agent environment starts. Each retrieval then shows its actual scope and
results while work continues.

For a multi-step request, the agent reports a brief action when moving to
comparison, grouping, or answer drafting. Each sentence adds a concrete period,
subject, source scope, or selection objective. Generic repeated working
messages add no useful information. Hidden reasoning is never forwarded.
Context compaction, provider retries, and citation checking retain their public
status messages when those actions occur.

## Event contract

The existing protocol remains version 1, with no new event types or migrations.
Partial tool names and provider-turn transitions do not generate speculative or
generic statuses. A concrete retrieval result stays current while the agent
reviews it, until the next real action or substantive progress sentence.

Each `tool_start`, `tool_update`, and `tool_end` is emitted as its Pi lifecycle
event arrives. `tool_call_id` identifies one invocation; repeated invocations
remain separate. Echo route calls execute sequentially, and one call's end is
emitted before the next call starts. Forwarding never waits for the full batch.

After request validation, `tool_update` supplies a public `toolLabel` with the
Kyiv time range, source-group names or group count, bounded search terms or
callsigns, and the retrieval number when known from an actual continuation.
Shortened name lists state how many additional names were selected.
Source names come only from successful authorized group metadata. Unknown
group keys, message identifiers, raw continuation values, URLs, and routes are
excluded. Source groups are not presented as verified enemy units.

A successful `tool_end` carries a result-specific label. A retrieval first
states the messages delivered in that collection, then the cumulative unique
messages delivered for the whole request. The following date, source, and
search scope describes the current call. Counts reflect actual compacted
responses, not requested events or completed analysis. When retrieval and
delivery counts differ, both are stated; a withheld response is never described
as an empty search. Source-group results state the records delivered for
review rather than the total number of accessible groups. A detailed call
label is retained through later updates or errors so a generic route title
cannot replace its scope. Lifecycle payloads retain their existing audit
identity and arguments. Progress sentences remain separate from answer text;
private thinking and citation-repair text remain excluded. The final cited
snapshot still replaces the streamed draft.

## Verification

Submit **знайди 20 головних подій за тиждень, по підрозділах противника** in a new
conversation on the development instance. Check one visible current-status
line, elapsed time updating while active, actual weekly dates on retrievals,
and growing delivered-message counts as successive collections arrive. Any
named groups must be described as sources. Earlier steps stay folded until
expanded. The agent's selection or grouping update should add information
rather than merely repeat that it is working. Completion, failure, or
cancellation stops the timer; reloading an active request replays its recorded
activity.

Regression coverage:

- `echo-ai-agent/runner/runner.test.ts` checks incremental Pi forwarding,
  retained labels, operational query/result scope, actual delivered counts,
  and excluded private stream content (#3064).
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/index.spec.ts` checks
  request event application and replay behavior (#3064).
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts` checks the active chat
  and reconnection behavior (#3064).

## Rollout

Release `2026.09.29.3` requires its matching Echo build and frontend. Update and
restart Echo before upgrading the selected namespace. From that checkout:

```sh
just ai-control-panel upgrade --host local --release 2026.09.29.3 --dry-run
just ai-control-panel upgrade --host local --release 2026.09.29.3
```

For another installation, replace `local` with its explicit host alias. Require
an idle namespace, rescan after the upgrade, and run the verification query
before expanding rollout. The dispatcher retains `2026.09.29.2` and its existing
predecessors so unselected namespaces can remain on their current release.
Preserve the previous immutable bundle and container backups; use the
[control panel recovery procedure](CONTROL_PANEL.md#upgrade-and-recovery) if an
upgrade fails. Do not overwrite an installed release with changed runner bytes.
