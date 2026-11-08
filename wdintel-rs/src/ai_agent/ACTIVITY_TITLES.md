# Live activity titles

The chat presents one short current-action title, with an optional second line
of dates, source scope, search terms, and actual received-message counts. The
title pulses while the request is active and respects reduced-motion settings.
Earlier activity remains available in the collapsed history.

## Presentation and ordering

Echo adds `activityPresentation: {key, title, detail}` to public progress and
route lifecycle payloads after normalizing runner input. The integer key
increases within one request. Runner-supplied presentation metadata is removed
before Echo assigns it. Facts and the immediate action appear before title
generation starts; reading and storing the agent stream never waits for vLLM.

The SSE/admin event wrapper also exposes generated typed fields
`activityPresentation` and `activityOnly`. Legacy events project to `null` and
`false`. The existing `payloadJson` remains available for auditing. These fields
come from `AiAgentActivityPresentation` and `AiAgentRequestEventItem` in
`types.rs`; `just gen-front` updates both frontend binding files.

A generated title arrives as a separate `progress` event with the original
presentation key and `activityOnly: true`. The UI updates only the matching
currently displayed activity, ignores updates after a terminal state, and does
not add a history entry or change a tool's execution status. Old generated
titles therefore cannot replace newer work or restart completed steps. Source,
assistant-text, and citation events do not themselves change the current step.

## Generation and factual detail

The backend prefers an enabled government `gpt-6-luna` engine, chosen by engine
name and identifier, even when chat users cannot select it: slower models miss
the two-second deadline (#4079). Without one, it uses an enabled, agent-allowed
`DirectHttp` or government engine. It prefers the configured default or
reviewer when that engine is eligible; otherwise it chooses deterministically
by engine name and identifier. Other engines outside the agent allowlist,
including the separate OCR engine, are excluded. Title generation does not
change the chat model list, and the main query keeps its selected provider.

Each request has one generation task and one latest pending action. Repeated
retrievals reuse a request-local title cache for the same public action. The
central `AI_AGENT_ACTIVITY_*` limits allow at most two concurrent generations
per Echo process, sixteen distinct generations per request, a two-second
queue-plus-generation deadline, and a small output-token budget. Exiting the
request drops and aborts its title task; cancellation also stops it.

vLLM receives only a bounded, sanitized request purpose and current public
action. It receives no tool arguments, message bodies, history, private
reasoning, credentials, routes, or continuation values. Its structured response
contains only a short Ukrainian action title. Unknown JSON fields, numbers,
URLs, identifiers, markup, and invalid or truncated responses are rejected.
Only model response content is parsed; reasoning fields are never forwarded.

The detail line is deterministic from the public activity label and is never
rewritten by vLLM. Batch counts remain distinct from cumulative unique counts
for the request; date and source scope belong to the current call. Source names
identify message sources and are not presented as verified enemy units.
Unavailable engines, timeouts, invalid output, and exhausted generation limits
leave the factual fallback in place and do not fail the query. Logs record only
categorical failures or engine identity and generation duration.

## Deployment and verification

Deploy the matching Echo backend and frontend. Title generation changes no
agent protocol and requires no migration or additional harness upgrade beyond
the [live-progress release](../../../echo-ai-agent/PROGRESS.md#rollout). If title
generation is unavailable, inspect the enabled government `gpt-6-luna` engine
or, without one, the enabled agent-allowed engine and its service; the
immediate public action continues to work while it recovers.

Submit **знайди 20 головних подій за тиждень, по підрозділах противника** in a new
development conversation. Verify a short action title, muted factual detail,
and elapsed time while the main query continues. Check actual dates and
message counts, folded history, motion stopping on completion/cancellation,
and active-request replay. A generated title event and the categorical engine
log confirm use of vLLM. A title for an earlier step must never replace the
current step.

Regression coverage:

- `wdintel-rs/src/ai_agent/activity_titles.rs` parses operational title JSON and
  rejects private or invented-count output (#3064), and chooses an enabled
  government `gpt-6-luna` outside the chat allowlist before the default engine
  (#4079).
- `wdintel-rs/src/ai_agent/events.rs` preserves runner sanitization and rejects
  forged presentation metadata.
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/index.spec.ts` covers
  correlated presentation updates, stale/terminal updates, and event replay.
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts` covers active chat and
  reconnection behavior (#3064).
