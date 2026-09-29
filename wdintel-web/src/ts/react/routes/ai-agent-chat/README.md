# Conversation navigation and history

The homepage `/` starts a fresh dialogue. After the first accepted submission,
`/?conversation=<uuid>` identifies it, including while its reply is still running.
Bookmarks, reloads and browser Back/Forward restore that conversation and reconnect
queued or running requests. Session storage no longer selects a conversation.

The navbar logo and **Нова розмова** clear the draft and start fresh. Switching
conversations detaches browser streams without cancelling server requests. Late
loads, submissions and stream events cannot replace the newly selected dialogue.
Invalid, deleted or inaccessible links return to `/` with an error; temporary load
failures retain the link and offer retry.

History rows expose a menu on desktop hover or keyboard focus. On touch screens,
hold a row for 500 ms; movement over 10 px, scrolling or cancellation stops the
hold. Opening the menu does not select the conversation. **Видалити** requires
confirmation and removes the row only after the server accepts deletion. Deleting
the viewed conversation replaces its URL with `/`; deleting another preserves the
current view. The backend rejects deletion while a request is queued or running.

## Point-map documents

Registered map links render lazy inline thumbnails. Each answer's latest main
map has a larger ending preview. Opening either selects the document in a right
panel; the Echo 1024 px breakpoint switches between equal chat/map widths and a
full-height drawer. Opening, replacing and closing a map preserve chat scroll
and draft text. Conversation changes clear selection, while reload restores the
published documents. Full records and exports are fetched with request ownership
and source access checks; failures use existing toasts. See the
[map contract and rollout](../../../../../../echo-ai-agent/MAPS.md).

Regression coverage:

- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/maps.spec.tsx`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/src/ts/react/services/api/__tests__/ai-agent.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-maps.spec.ts`

## Live progress

The composer shows **Зупинити** while this conversation has queued or running
requests, including after reload or a stream interruption. It cancels all active
requests in the viewed conversation; each activity row can still cancel its own
request. Pending cancellations suppress duplicate calls, failures show a toast
and remain retryable, and a completed request keeps its final answer if it wins
the cancellation race. Stopping preserves the composer draft, partial response
and published maps. The backend revokes request credentials and terminates the
runner; switching conversations only detaches the browser stream.

Each request shows a softly pulsating current-action title beside elapsed time
and cancel/reconnect controls. An optional second line contains factual dates,
source scope, or message counts. Both lines truncate visually and retain their
full text in tooltips. Reduced-motion preferences disable the pulse. The
activity history stays collapsed by default; clicking the title expands it,
and new events preserve that choice. Completion collapses it again.

The backend uses an allowed vLLM engine to rephrase public activity into a short
title asynchronously. Immediate public labels remain available if title
generation is unavailable. Typed activity presentations are keyed to their
original step: a title-only update changes the current matching presentation,
without adding history or changing tool status. Older or terminal updates cannot
replace the current title.

Every tool invocation remains distinct in the history and updates as events
arrive. The title uses the active call's presentation, then its retrieval result
or the agent's newer concrete phase while analysis continues. Elapsed time
includes environment startup and stops on completion, failure or cancellation.
Unfinished calls become interrupted. Reconnection replays activity without
duplicates; successful requests retain one compact history/time line without
animation or extra details.

Failed request messages offer **Спробувати ще раз**, including after reload.
Retry submits the original prompt as a new request in the same conversation
with its provider and preserves any unsent composer draft. Retry is disabled
while a submission or another request is active; stream interruptions retain
their separate reconnect action.

Regression coverage (#3064):

- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-citations.spec.ts`
