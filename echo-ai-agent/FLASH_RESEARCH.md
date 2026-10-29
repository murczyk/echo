# Budget-aware GLM Flash research

Only `glm-5.3-flash-uncensored` uses this workflow. The selected provider and total
Fast/Balanced/Deep deadlines remain 120/300/1800 seconds. Flash reserves
60/120/240 seconds of those deadlines for synthesis. Without presets, its existing
ten-minute deadline is retained with a two-minute synthesis reserve; final
generation keeps the legacy gateway's authorized `research` purpose.

Before retrieval, Flash saves a short checklist with `update_research`. Broad
summaries start with a sample, then use focused searches chosen from the request
and observed evidence. Explicit exhaustive requests retain pagination. Existing
scope, permission, citation, and search-semantics guidance still applies.

After at most four retrieval attempts, another state update is required. State
contains task status, a concise cited answer draft and coverage gaps; it must not
contain hidden reasoning or deliberation. Queries and returned continuation
cursors are recorded automatically. Completed updates use the existing work
journal's checkpoint records, with no new storage or container filesystem tool.
When work memory is enabled, follow-ups receive the compact state through the
existing conversation-isolated, access-revalidated recap. Detailed records remain
available through the existing work tools. With work memory disabled, state is
retained only for the active request.

Every provider turn receives private remaining research/total time, tool allowance
and estimated context headroom. A warning requests completion before the research
boundary. Observed provider durations prevent starting a research or checkpoint
call that would consume the remaining research allowance. Transitions happen
between completed tool rounds; deadline timers and cancellation remain backstops.

Synthesis uses compact evidence and at most 2,048 output tokens, bounded by the
configured output cap. Intermediate assistant text and private-tool events never
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
