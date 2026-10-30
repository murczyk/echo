# Budget-aware bounded research

`glm-5.3-flash-uncensored` always uses this workflow. Every other non-OpenAI
engine (GLM-5.3, Gemma) uses it when [reasoning presets](../docs/ai/reasoning-presets.md)
give the request a budget; without presets those engines keep their unbudgeted
path. OpenAI engines keep the generic path, where a failed final synthesis yields a
short notice instead of raw source excerpts. The selected provider and total
Fast/Balanced/Deep deadlines remain 120/300/1800 seconds. These engines reserve
60/120/240 seconds of those deadlines for synthesis (Rust `reasoning::resolve`; the
runner also accepts the base 30/60/120 so policies queued before the reserve was
raised still validate). Flash without presets keeps its existing ten-minute deadline
with a two-minute synthesis reserve; final generation keeps the legacy gateway's
authorized `research` purpose.

Before retrieval, Flash saves a short checklist with `update_research`. Broad
summaries start with a sample, then use focused searches chosen from the request
and observed evidence. Continuing unfiltered inbox pagination, or reading more than three pages of
one search, requires a specific coverage requirement in
`update_research.paginationReason` (or a refined search); explicit exhaustive
requests retain pagination. Existing
scope, permission, citation, and search-semantics guidance still applies. If a
continuation lacks that requirement, the runner privately defers it and forces a
research checkpoint before the next retrieval turn. Flash must record a concrete
coverage need or choose focused searches; the guard never authorizes pagination
automatically. Rejected or failed checkpoints keep recovery blocked.

After four retrieval attempts, the next research turn is restricted to
`update_research` with a forced tool choice. An already admitted tool batch
finishes before this boundary, including calls beyond the fourth retrieval.
Retrieval resumes only after a successful state update; a rejected or failed
update does not reopen it. The initial-plan and pagination checks still apply.
State contains task status, a cited Markdown answer draft (up to 8,000 characters)
and coverage gaps; it must not
contain hidden reasoning or deliberation. Queries and returned continuation
cursors are recorded automatically. Completed updates use the existing work
journal's checkpoint records, with no new storage or container filesystem tool.
When work memory is enabled, follow-ups receive the compact state through the
existing conversation-isolated, access-revalidated recap. Detailed records remain
available through the existing work tools. Formatting-only follow-ups reuse the
previous answer and citations without fetching more records. With work memory disabled, state is
retained only for the active request.

Every provider turn receives private remaining research/total time, tool allowance
and estimated context headroom. A warning requests completion before the research
boundary. Observed provider durations prevent starting a research or checkpoint
call that would consume the remaining research allowance; before the first
checkpoint has been observed, one minute is assumed. Transitions happen
between completed tool rounds; deadline timers and cancellation remain backstops.

Synthesis uses the same context-aware evidence packing as other engines and at
most 8,192 output tokens, bounded by the configured output cap. It preserves
full records when they fit rather than cutting each source to a fixed prefix.
The compact saved draft is included once. A truncated, empty, interrupted or
citation-invalid completion may receive one corrective attempt if its observed
duration plus a safety margin fits the remaining finalization allowance.
The retry asks for a shorter complete answer or corrected exact citations;
authorization failures, filtering and cancellation remain terminal.
Intermediate assistant text and private-tool events never
enter the streamed answer; public progress and source activity remain visible.
An unfinished synthesis uses the latest completed draft only if its links still
validate against the available citations. Without a validated draft, it returns a
short inability notice. Answers grounded solely in user-provided text need no
invented citation, and registered map links remain supported. It never
substitutes raw source excerpts. Unread cursors,
incomplete tasks or remaining gaps produce a brief coverage qualification.
Authorization failures, content filters, cancellation and persistence failures
retain their fail-closed behavior.

Regressions: `echo-ai-agent/runner/flash-research.test.ts` exercises the actual
runner against deterministic provider and neutral botanical-archive fixtures,
including selective retrieval, long pagination, saved-state reuse, partial
coverage, timing, tool exhaustion and failure paths. Existing work-memory backend
regressions verify conversation isolation and source revocation. These fixtures
verify harness control flow, not live-provider answer quality.

## Completion diagnostics

The runner emits private `completion_diagnostic` frames for research turns,
synthesis attempts and the selected answer. The worker logs only allowlisted
stage/outcome/finish-reason values and numeric usage, duration and remaining
budget fields, correlated with the request ID. These frames are never stored as
chat events or sent to the frontend. Source text, tool arguments, credentials
and hidden reasoning are excluded. This also records successful requests that
returned a fallback draft instead of a completed synthesis.

Tool failures also emit private `tool_diagnostic` frames with an allowlisted
reason code, a recognized tool name and an optional HTTP status. The worker logs
these against the request ID without arguments, source content or raw errors.
Deferred pagination prerequisites stay out of public tool activity; genuine
failures retain public error events with a safe `errorReason` code.

## Live evaluation

`evals/flash-completion.mjs` runs the actual harness with local, neutral botanical
archive tools and real provider inference. No production Echo tools or database
writes are used. Supply a private JSON profile file containing `engine`, `url`,
`token`, `context` and `maxTokens`; do not commit credentials or evaluation logs.

```sh
node --experimental-strip-types echo-ai-agent/evals/flash-completion.mjs \
  echo-ai-agent/runner/runner.ts /private/profiles.json \
  glm-5.3-flash-uncensored grouped balanced
```

When comparing GLM-5.3 or Gemma against a base runner built before they used this
workflow, add `1` as a final argument: that runner accepts the doubled synthesis
reserve only for Flash.

Scenarios are `grouped`, `long`, `attachments`, `exhaustive` and `followup`;
presets are `fast`,
`balanced` and `deep`. Run the same fixture against the base runner and Sol for
comparison. Results contain provider finish reasons, usage, selected-answer
outcome, retrievals and the synthetic answer. Compare substantive coverage,
valid citations, readable groups and deadline compliance; a scripted provider
fixture alone does not establish model behavior.
