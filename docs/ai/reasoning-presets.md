# Agent reasoning and research budgets

The composer shows only **Швидкий**, **Збалансований**, and **Глибокий**.
Their limits are 2 minutes, 5 minutes (10 on non-OpenAI engines) and 4 hours;
the composer shows them in the mode menu. A Fast or Balanced request that builds a document (an open
document, a .docx attached to the message, or a report request in a conversation
with a .docx upload or a generated document) gets 30 minutes instead and keeps
its reasoning effort; its policy carries `documentTask: true`. Balanced is the default. The browser
remembers the last chosen Fast or Balanced in `localStorage`
(`echo.ai-agent.reasoning-preset`). Deep is never remembered: successful
submission, changing provider, and opening another conversation reset the
composer to the remembered preset (Balanced if none). Retry preserves the
failed request's preset. Each follow-up makes
its own selection; an active request's policy cannot change.

When the newest answer finished in Fast or Balanced with incomplete coverage and
the provider offers Deep, the chat shows **Продовжити в глибокому режимі** under
it, with Deep's limit. The button submits a fixed, task-neutral follow-up prompt
as a new Deep request in the same conversation; it is a fresh run informed by the
previous answer, not a resume. Deep answers get no button because there is no
higher mode.

A Deep answer on a non-OpenAI engine is final. Gaps reported on finished work are
written as findings, without a coverage notice, footer or `incomplete_research`
metadata. A real stop (time, tool or context limit, or a provider failure), tasks
left pending or a failed synthesis qualify it, with one line naming that.

The limit starts when a worker claims the request, excluding queue time.
Fast reserves its last 30 seconds, Balanced 60 seconds, a document request
120 seconds, and Deep 300 seconds for a final answer; non-OpenAI engines (GLM, Gemma) reserve twice that, because
they run the [bounded research workflow](../../echo-ai-agent/FLASH_RESEARCH.md). Checkpoints, output recovery, citation repair, and provider
retries share the original deadline and call counters. These are ceilings,
not promised completion times: the agent finishes as soon as the work is done.
The normal tool and Echo API ceilings are 128 and the provider ceiling is 256
calls, with one provider call reserved for final synthesis. A 4-hour Deep
request allows 1024 tool and API calls, 2048 provider calls, 50 000 runner
events (64 MiB) and 30-minute provider turns (`reasoning::limits`).

A Deep request holds its user's single running slot for as long as it runs:
the user's next messages wait in the queue. A backend restart or a lost worker
lease fails running requests (there is no resume), so long Deep runs are lost
on a deploy; namespace upgrades wait until the namespace is idle.

At the research limit, tools stop and the selected engine summarizes evidence
with its lowest supported effort. This call cannot use tools. If synthesis
fails, stalls, or lacks valid citations, Echo returns bounded quotations from
retrieved sources and their verified links. The answer discloses incomplete
coverage. Cancellation and authorization failures remain terminal; they do not
start a new research budget. Existing requests without a policy retain their
legacy behavior.

## Provider capabilities

| Engine | Transport | Fast | Balanced | Deep | Checkpoint / final synthesis |
| --- | --- | --- | --- | --- | --- |
| GLM-5.3 | Chat Completions | low | high | max | low |
| GPT-6-Sol | Responses | none | medium | max | none |
| GPT-6.1-Sol | Responses | low | medium | max | low |

GLM thinking stays enabled. OpenAI Responses uses `store: false`, preserves
encrypted reasoning and function-call IDs between tool rounds, and uses the
configured government endpoint and credentials. No public-provider fallback
is configured. Provider effort is enforced by Echo's gateway, independently
of the runner's request body. Only text input and existing function tools are
accepted; provider-hosted tools and stored conversation references are rejected.

The optional host setting `ai_agent_reasoning_presets_enabled = true` enables
the selector. Without it, existing installations retain their behavior.
Only engines listed in `ai_agent_reasoning_verified_engine_ids` receive the
variable effort mappings above. Other engines receive time limits with their
existing fixed reasoning configuration.
Engine IDs must be verified against their **actual configured endpoint** before
being listed. A catalogue entry or SDK fixture is insufficient evidence.
Queue labels and elapsed execution times are shown independently of this flag.

Policies are snapshotted into nullable `ai_agent_request.execution_policy`
when queued, including actual effort, transport, runtime, and finalization
reserve. They survive later host configuration changes. Completion metadata
records limited coverage and its cause: `time_limit`, `tool_limit`,
`context_limit`, `provider_error`, or `incomplete_research` when Fast or Balanced
research ended with remaining gaps or a fallback answer without reaching a limit.
`tool_limit` also covers research stopped after six failed tool calls in a row
(#4179): the provider answered, so the chat does not offer another model.
Echo also records `model_refusal` with `coverageLimited: false` (#4112): on a finished
answer whose opening declines an operational request (`wdintel-rs/src/ai_agent/refusal.rs`,
patterns in `config.rs` under `AI_AGENT_REFUSAL_`), and on a run that failed after the
runner reported a content filter. A run that failed after a provider error or rate limit
records `provider_error` the same way, and so does research that only fell back to a saved
draft (`incomplete_research`) because the provider kept failing without a later reply.
The chat offers another model for both reasons.
Conversation reload restores the selected preset, worker start time, and completion metadata.

The new modes use the selected provider for checkpoints. Luna's vision role,
the document extractor, engine token profiles, and the configured default
provider are unaffected. Kharkiv should retain its configured default provider
and keep GLM as an option.

## Rollout and recovery

1. Build and test the application from `main` and immutable harness
   `2026.10.10.1`. Restore the standard test database, apply migrations,
   regenerate entities, and run the catalog-aware analytics check. The new
   nullable columns belong to the excluded `public.ai_agent_request` table;
   no analytics resnapshot is needed.
2. Deploy only to Kharkiv. Drain queued/running requests before maintenance;
   disabling the global agent flag while a request runs revokes its access.
   Install the matching harness and migrate the application with the preset
   feature flag still off. Preserve the existing default provider, GLM option,
   government credentials, vision engine, and shared extractor settings.
3. Against each candidate's government endpoint, verify a harmless function
   call, its matching result, and a final answer at **every mapped effort**.
   For Sol also verify encrypted reasoning replay through `/v1/responses`.
   Verify low-effort checkpoint and no-tool final synthesis. Record engine
   ID, endpoint, tested levels, and date without credentials or source data.
   If any level or transport fails, keep that ID out of the verified list.
4. Add only the verified engine UUIDs to
   `ai_agent_reasoning_verified_engine_ids = ["..."]`, then set
   `ai_agent_reasoning_presets_enabled = true` at the top level of
   `/etc/echo/config.toml`. Restart API, background, and report workers together.
5. Validate Fast and Balanced reports for both engines, explicit Deep selection,
   a Balanced follow-up after Deep, retry, reload while queued/running, and
   cancellation. Check original deadlines in gateway logs, source links,
   coverage notices, and persisted policy/metadata. A forced stalled synthesis
   must yield the saved draft or a short notice before the request deadline
   plus cleanup slack.
   Confirm other Echo hosts and namespaces were not changed.

For rollback, stop admitting new work and drain active requests first. Disable
`ai_agent_reasoning_presets_enabled`, restart the workers, and keep the current
application/harness pair until requests with stored policies have finished.
Then use the existing [Kharkiv rollback procedure](kharkiv-canary.md#upgrade-and-rollback)
if necessary. Leave the additive nullable columns in place.

## Maintained validation

- `echo-ai-agent/runner/execution-policy.test.ts`: deadlines, a stalled final
  provider, and a real SDK Responses tool round trip with encrypted reasoning.
- `echo-ai-agent/runner/context-compaction.test.ts`: checkpoint integrity,
  cancellation, and output recovery.
- `wdintel-rs/src/ai_agent/bootstrap_tests.rs`: request-scoped authorization,
  the reserved final provider call, and absolute deadline enforcement.
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`:
  explicit Deep choice, composer reset, and retry preserving that choice.
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts`: desktop and narrow
  viewport selection and a Balanced follow-up after Deep. Execute this suite
  before merging; discovery alone is insufficient.

Provider references: [GLM Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion),
[GPT-6-Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6.1-Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
[Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).


## Checkpoint exhaustion recovery

Harness `2026.10.10.3` limits checkpoint work to six provider calls per
compaction cycle, including transport retries, within the original research
deadline. Checkpoints target a concise summary and tighten that target on a
reduced-prefix retry. A truncated or empty summary never replaces evidence.
The runner emits redacted checkpoint diagnostics on stderr: engine, attempt,
input/output usage, configured output cap, stop reason, and duration.

For requests with a reasoning preset, exhausted checkpoint output, non-reducing
compaction, or insufficient context headroom stops research and produces a
partial answer from already retrieved sources and the latest valid checkpoint.
A fitting checkpoint can supply synthesis when raw records are too large;
citations still require evidence collected during the current request. History
alone does not replace that evidence.
Final synthesis has no tools and lasts at most the preset's finalization
allowance, also bounded by the original deadline. If synthesis times out,
truncates, or lacks valid citations, Echo returns the latest validated saved
draft when the engine keeps one (non-OpenAI engines) and otherwise a short
notice; raw source excerpts are never published.
Completion metadata records `coverageLimited: true`, `reason: "context_limit"`.
The notice describes incomplete coverage without suggesting that Deep mode
would fix it, because Deep does not enlarge the context window. The Deep
continuation button is still offered, because its follow-up starts with fresh
context. Cancellation, authorization failures, and content filtering do
not become successful partial answers, including synthesis after time/tool
limits. Legacy requests without a reasoning policy still fail on exhausted
compaction instead of producing partial answers; the bounded checkpoint retry
policy also applies to them. Transient 429/5xx and interrupted streams retry
once, counted in the same six-call budget.

Deploy from stable. Drain the selected namespace, back up the binary/config and
namespace release, and keep AI admission disabled across the backend and harness
upgrade. Update Echo and then use `ai-control-panel upgrade` for that namespace
with release `2026.10.10.3`; restore admission only after versions and connection
checks agree. Validate Kharkiv before Siversk with a request that actually
compacts context. Keep other namespaces pinned. No migration or collection sync
is needed. Roll back the harness and application as a pair while admission is
closed; the backend must understand `context_limit` whenever the new harness
runs. Existing failed requests are not rewritten or automatically retried.

Regression coverage: `echo-ai-agent/runner/checkpoint-recovery.test.ts` exercises
the full runner through Responses and Chat Completions; compaction/policy tests
cover retries, evidence integrity and bounded finalization; the chat-flow test
checks restored partial answers and their coverage label.

## Interrupted conversation history

Failed and cancelled requests retain their original question in follow-up
context, regardless of the next request's reasoning preset. When available,
the latest saved assistant snapshot and later text deltas are restored as an
explicitly incomplete, unverified draft. Published maps remain available.
Current file-access checks still apply. This also recovers already stored
partial answers from older failures; missing tool outputs cannot be reconstructed.

The completion-event migration permits `completion_metadata` in the event
journal. Without it, a valid budget-limited answer could fail during persistence.
Apply the new migration before serving requests. Existing request outcomes
remain unchanged. Regression coverage is in
`wdintel-rs/src/ai_agent/bootstrap_tests.rs`.
