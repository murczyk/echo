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

Conversations run in parallel (#4232): a message waits in the queue only behind
earlier requests in its own conversation. Conversations whose engines need the
same agent-container proxies (every gateway engine, or one vLLM host) share the
user's container; one on another backend runs in a second container, and only a
third backend at once waits. History rows show **Виконується** or **У черзі**
before the timestamp, and the list refreshes every 5 seconds while any row has
one, so a conversation finished in the background clears its marker.

The composer remembers the last chosen provider in `localStorage`
(`echo.ai-agent.provider-id`) and uses it for new dialogues. A missing or
disabled provider falls back to the configured default; opening an existing
conversation uses the engine its newest request used without changing the
remembered one. The provider can be changed at any turn; each answer's caption
names the engine that wrote it (#4112).

The provider list follows the order set on the admin cards. An engine an admin
marked unhealthy shows in the warning colour with the admin's message. The composer
keeps the remembered, default or conversation engine even when it is unhealthy; while
the selected engine is unhealthy, a warning above the composer offers the next healthy
one in that order, and switching to a healthy engine removes the warning. The
configuration is fetched again on window focus and after each
request, so a change during the session shows up without a reload. See
[reasoning presets](../../../../../../docs/ai/reasoning-presets.md) for the
remembered depth.

## Attachments

The composer accepts files from the paperclip button, drag-and-drop and pasted
clipboard images (`ComposerAttachments.tsx`, `composer-attachments.ts`). Files
upload immediately as drafts; chips show upload and extraction progress, and
removing a chip deletes the draft. A message may be sent once every upload has
finished, even while extraction continues, and with empty text. Switching
conversations discards unsent drafts. Sent messages show attachment chips that
open the stored original. The backend pipeline, limits and agent tools are
described in
[`wdintel-rs/src/ai_agent/uploads/README.md`](../../../../../../wdintel-rs/src/ai_agent/uploads/README.md).

## Point-map documents

Registered map links render lazy inline thumbnails. Each answer's latest main
map has a compact 144 × 96 px preview card with a point-count badge and its most
frequent symbols. Opening either shows `MapWorkspace`: from the Echo 1024 px
breakpoint chat docks to a 420 px column and the map fills the rest; below it the
workspace is a full-height drawer. Opening, replacing and closing a map preserve
chat scroll and draft text. Conversation changes clear selection, while reload
restores the published documents. Full records and exports are fetched with
request ownership and source access checks; failures use existing toasts.

`MapCanvas` draws APP-6(D) symbols with milsymbol (`map-symbol.ts`, loaded only
with the workspace) and fans out records at identical coordinates. Click,
Ctrl/Shift-click and Shift-drag select records. `MapInspector` lists records by
symbol group with filtering and per-group visibility, shows the selected record,
and hosts `SymbolEditor` (affiliation, type, status, echelon from the generated
`static/data/app6d-catalog.json`). Every change, from the inspector, the title
field, Delete, or the agent, is a saved revision; `use-map-workspace.ts` owns
loading, edits, undo/redo and conflict reloads. While a map is open,
`MapEditContext` in the composer decides whether a request may edit it and sends
the selection. KMZ export sends milsymbol-rendered PNG icons. See the
[map contract and rollout](../../../../../../echo-ai-agent/MAPS.md).

Regression coverage:

- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/maps.spec.tsx`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/map-symbol.spec.ts`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/src/ts/react/services/api/__tests__/ai-agent.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-maps.spec.ts`

## Generated documents

Answers that save a Word document link it as `[title](echo-document:<id>)`;
`CitationMarkdown` renders the link as a `DocumentChip`, and documents the text
does not link are listed below the answer. A chip, or the «Файли розмови» button
beside the paperclip, opens `DocumentWorkspace` with the same layout as the map
workspace. The centre shows `DocxPagePreview`: docx-preview renders the pages in
a script-less sandboxed iframe whose CSP blocks every network load, and links do
not navigate. The right panel lists the conversation's documents, the selected
document's versions and the sent uploads; a .docx upload can prefill a «use as
template» prompt. Restoring a version, undo and redo move the document head
(`use-document-workspace.ts`). While a document is open, `DocumentEditContext` in
the composer sends it as `documentTarget`; the agent may still change any document
of the conversation. See the
[agent tools and rollout](../../../../../../echo-ai-agent/DOCUMENTS.md).

Regression coverage: `wdintel-web/tests/e2e/ai-agent-documents.spec.ts`.

## Copying answers

`CitationMarkdown` renders each code block (`CopyControls.tsx`) with its language
and a **Копіювати** button that copies only the code. Once an answer has finished,
a **⋯** button («Дії з відповіддю») at the top right of the answer, beside its
«ЕХО Агент» caption, opens a menu (#4182): **Копіювати текст** writes the
rendered answer as HTML plus a plain-text alternative (`answer-copy.ts`), so Word
and Google Docs keep formatting and messengers get clean text with bullets and
tab-separated table cells; **Копіювати як Markdown** copies the stored source.
Citation chips copy as their visible label with an absolute link; map and document
chips copy as their title (`data-copy-text`); controls marked `data-copy-skip` and
icons are left out. Without the Clipboard API (plain HTTP) every copy action falls
back to a copy event, which works inside the open menu's focus trap.

Regression coverage: `__tests__/answer-copy.spec.ts`,
`wdintel-web/tests/e2e/ai-agent-copy.spec.ts`.

## Environment prewarm

Typing the first draft text or attaching a file asks the backend
(`POST /api/ai-agent/prewarm`) to start the user's agent container, so the
request that follows skips most of «Готую середовище». The composer repeats the
call at most once a minute and only while the draft keeps changing; it never
fires on focus or page load. The backend throttles per user, does nothing while
a request is active or another lifecycle operation holds the user's lock, keeps
an already running container alive, and starts a stopped one only when two
host slots stay free for real requests; the dispatcher enforces that reserve
atomically across all namespaces on the agent host. A submission sent while a
prewarm is starting waits for it rather than failing. A prewarmed container
that no request uses stops after 3 minutes. Errors are logged, never shown.

## Live progress

The composer shows **Зупинити** while this conversation has queued or running
requests, including after reload or a stream interruption. It cancels all active
requests in the viewed conversation; each activity row can still cancel its own
request. Pending cancellations suppress duplicate calls, failures show a toast
and remain retryable, and a completed request keeps its final answer if it wins
the cancellation race. Stopping preserves the composer draft, partial response
and published maps. The backend revokes request credentials and terminates the
runner; switching conversations only detaches the browser stream.

The mode menu shows each mode's time limit (`runtimeLimitLabel`): Deep runs up
to 4 hours, and while it runs the next messages in that conversation wait in the
queue. The
event stream (`stream.ts`) reconnects after each drop; only consecutive failed
connections count toward its retry limit, so a multi-hour request survives
network interruptions.

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
with its provider and preserves any unsent composer draft.

When the newest request ended with completion reason `provider_error` (the
provider failed) or `model_refusal` (the model declined for policy reasons, or its
content filter blocked it), it offers **Спробувати з {engine}** (`ModelFallback.tsx`,
`provider-fallback.ts`). The suggestion is the next healthy engine in the admin
order, skipping engines that already failed in the same unbroken run of failures,
so GLM-5.3 → Flash → Sol does not loop. It resends the prompt in the same
conversation, keeps the depth when that engine offers it, and leaves the
remembered provider alone. Provider errors also offer **Спробувати ще раз** on the
same engine. Failures without a reason, such as a harness upgrade, keep only the
plain retry. Deep continuation is not offered for these reasons. Retry is disabled
while a submission or another request is active; stream interruptions retain
their separate reconnect action.

The newest answer offers **Продовжити в глибокому режимі** when its metadata
reports incomplete coverage, it ran below Deep, and the provider offers Deep. The
button works for a just-finished answer and after reload (`DeepContinuation.tsx`).
It sends a fixed follow-up prompt through the same path as retry, so the composer
draft and the remembered mode are kept. Because that prompt only says "previous",
submission first confirms on the server that the request is still the newest; if
another tab moved the conversation on, the view refreshes and nothing is sent. See
[reasoning presets](../../../../../../docs/ai/reasoning-presets.md).

Regression coverage (#3064):

- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/map-symbol.spec.ts`
- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-citations.spec.ts`
