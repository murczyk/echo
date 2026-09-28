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

Regression coverage (#3064):

- `wdintel-web/src/ts/react/routes/ai-agent-chat/__tests__/chat-flow.spec.tsx`
- `wdintel-web/tests/e2e/ai-agent-chat-navigation.spec.ts`
- `wdintel-web/tests/e2e/ai-agent-citations.spec.ts`
