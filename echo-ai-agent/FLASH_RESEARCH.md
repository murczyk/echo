# Budget-aware bounded research

`glm-5.3-flash-uncensored` always uses this workflow. Every other non-OpenAI
engine (GLM-5.3, Gemma) uses it when [reasoning presets](../docs/ai/reasoning-presets.md)
give the request a budget; without presets those engines keep their unbudgeted
path. OpenAI engines keep the generic path, where a failed final synthesis yields a
short notice instead of raw source excerpts. The selected provider and total
Fast/Balanced/Deep deadlines are 120/600/14400 seconds (OpenAI Balanced stays at
300), and document requests in Fast or Balanced get 1800 seconds. These engines reserve 60/120/600 seconds
(240 for documents) of those deadlines for synthesis (Rust `reasoning::resolve`;
the runner also accepts the base 30/60/300/120 reserves, Balanced at the former
300 seconds and Deep at the former 1800/120, so policies queued before a change
still validate). When the user asks
for a document, it must be saved during research: the tool-free synthesis cannot
create files, and when no Echo search ran it says so instead of reporting that
Echo has no data. Flash without presets keeps its existing ten-minute deadline
with a two-minute synthesis reserve; final generation keeps the legacy gateway's
authorized `research` purpose.

Research starts with retrieval: nothing has to be saved first, because a slow
provider turn spent on planning can use up most of a Balanced window. Broad
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
Retrieval resumes after any saved update. A draft that fails citation validation
is not saved, but the checklist and gaps are, the previous draft stays, and the
tool result names the invalid links; only a failed save keeps retrieval closed.
The pagination checks still apply.
State contains task status, a cited Markdown answer draft (up to 8,000 characters)
and coverage gaps; it must not
contain hidden reasoning or deliberation. The tool's schema is deliberately loose:
`normalizedResearchUpdate` fits what the model sends to these limits, because a
schema failure costs a whole provider turn. `report_progress` also fits its text
rather than failing. Queries and returned continuation
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
checkpoint has been observed, one minute is assumed. Until something has been
retrieved, a research turn is always started: stopping then guarantees a useless
answer, while a turn cut off at the research deadline leaves the synthesis reserve
intact. Transitions happen
between completed tool rounds; deadline timers and cancellation remain backstops.

A turn that ends with pending checklist items, or with no saved state after a
public progress report that no tool call followed, does not end research: the
runner re-prompts the model to do the work or mark it done or blocked. Deep allows
three re-prompts and the other presets one, while time for a turn remains. A
re-prompt that runs no tool ends the loop. There is no forced tool choice here.
Deep that ran no tool at all also gets one re-prompt to search first, because a
word with an everyday meaning may be a callsign. Reformatting or translating
earlier text, and tasks answerable from what the user supplied, may still finish
without tools.
A provider failure before the first tool call also gets one re-prompt, in every
preset, because nothing is lost by trying again. Authorization and content-filter
failures are not retried, and a repeated failure ends research as before.
Research may also end without any text, as GLM-5.3 does: synthesis writes the
answer, so an empty final turn is not a provider failure. When research called no
tool at all, not even a rejected or private one, its reply already answers from the
whole conversation and is delivered as written, after the same link validation and
map, file and document link safeguards; synthesis could only rewrite it from a
narrower view (incident 01a1c4a5, where it turned CSV processing rules set in the
first message into a summary). An empty or invalid reply, any tool call, and document
requests still go to synthesis. On Deep the reply to the request is used, not the
completion note the search reminder asks for. Research that ran tools and then ended
on a reply without a tool call, longer than any draft (8,000 characters) and citing a
source this request's tools returned, has written the answer itself: it is delivered
the same way, without a draft refresh or synthesis (incident 01a1d04a, where GLM-5.3
wrote a 16,000-character report and a synthesis rewriting it ran out of time). A
shorter reply may be the completion note research ends with, and one citing only
sources from history or restored work memory is not new; both still go to synthesis.
A last draft refresh
runs only after four or more retrievals, because it is a fallback that costs
research-effort turns.

Synthesis has no tools and sees only delivered evidence, so its request also carries
`completedActions`: the harness's record of each public tool's calls, failures and
result counts. Without it, a search that found nothing or a published map looks like
work that never ran. Statistics and lookups (frequency summary, daily activity,
callsign relations, positions, units and similar) cite no message, so each result
also reaches synthesis as a `statisticsFrom` record with the tool's arguments and
the compacted result research saw; otherwise an answer built on them would have
nothing to report. Its conversation is the opening user message, which often sets
rules for the whole chat, plus the newest history entries that fit a quarter of the
engine's input allowance; the rest stays for evidence. Synthesis uses the same context-aware evidence packing as other engines and at
most 16,384 output tokens (the whole configured output cap on Deep), bounded by
that cap. Hidden thinking counts against it. It preserves
full records when they fit rather than cutting each source to a fixed prefix.
The compact saved draft is included once. A truncated, empty, interrupted or
citation-invalid completion may receive one corrective attempt if its observed
duration plus a safety margin fits the remaining finalization allowance.
The retry asks for a shorter complete answer or corrected exact citations;
authorization failures, filtering and cancellation remain terminal.
Intermediate assistant text and private-tool events never
enter the streamed answer; public progress and source activity remain visible.
When the finalization deadline cuts a synthesis off, the provider hands over the text
it streamed so far, after a wait of at most 300 ms. A last line without a final
newline may be unfinished and is dropped, together with any trailing heading. The
finished lines then count as an answer if their links validate (incident 01a1d054,
where the deadline discarded 73 seconds of a cited report). An unfinished synthesis returns whichever of that part and the latest
completed draft is longer, when its links still validate against the available
citations. A cut-off part says the time limit cut it. Without either, it returns a
short inability notice. Answers grounded solely in user-provided text need no
invented citation, and registered map links remain supported. It never
substitutes raw source excerpts. Unread cursors,
incomplete tasks or remaining gaps produce a brief coverage qualification. Every
such answer also emits `completion_metadata`: the budget limit's reason when one
was reached, otherwise `incomplete_research` (also used for a fallback answer),
which the chat uses to offer a Deep continuation. Deep is the exception: gaps
reported on finished work are findings. Only a real stop, work left undone or a
failed synthesis qualify its answer, with one line naming that. A progress note
after real work earns a re-prompt but no such label, because models also announce
the final summary that way. When no limit stopped the work, that prompt
also forbids claiming one did, even if an earlier answer in the conversation said so.
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
returned a fallback draft instead of a completed synthesis, `research_text`
answers that research wrote itself, and `partial` answers cut off by the deadline,
whose synthesis diagnostic is `aborted` with the characters streamed before the cut.

When a provider failure or content filter ends a run on any path, including
OpenAI models outside bounded research, the runner reports it with stage
`answer` and outcome `transient_error` or `content_filter` just before its
error frame (`terminalProviderFailure`). The worker keeps the last such outcome
and stores the failed request's completion reason as `provider_error` or
`model_refusal`, so the chat can offer another model (#4112).

Tool failures also emit private `tool_diagnostic` frames with an allowlisted
reason code, a recognized tool name and an optional HTTP status. Failed argument
validation adds `fields`: paths and a fixed kind such as
`checklist.0.status:enum`, never the received values. Echo's own argument
checks after validation report the same way, for example `period:size` for a
date range longer than allowed or `selectedGroups:unknown` for a group that was
not found. A draft rejected by
`update_research` logs `citation_rejected` with `draftIssue` (`no_citation`,
`unknown_link` or `bare_link`). The worker logs
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

Scenarios are `grouped`, `short`, `long`, `attachments`, `exhaustive` and `followup`;
presets are `fast`,
`balanced` and `deep`. Run the same fixture against the base runner and Sol for
comparison. Results contain provider finish reasons, usage, selected-answer
outcome, retrievals and the synthetic answer. Compare substantive coverage,
valid citations, readable groups and deadline compliance; a scripted provider
fixture alone does not establish model behavior.
