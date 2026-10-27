# Links to Duty and Analysis messages

The shared `MessageCard` offers a copy-link action on both pages. `buildMessageLinkFullUrl` in `shared/message-card/message-card.utils.ts` constructs an absolute URL on the current origin: Duty cards point to `/rer-duty-neo?m=<reference>`, Analysis cards to `/rer-analysis-neo?m=<reference>`. It prefers `messageUuid`, with the route-specific legacy ID fallback implemented in that helper. The copied URL includes only `m`, not the current feed filters, Analysis date range, page, or column layout. Users open or paste it in a tab themselves; copying does not open one. `message-card-copy-feedback.ts` provides the same success snackbar for both routes.

## Opening a link

`shared/message-navigation/` reads `m` (and legacy `mid` or `messageUid`), resolves the message context through `fetchInboxItemContext`, and runs a cancellable resolve → host `materialize` → host `land` sequence. The context API determines whether the message is available to the user. Missing or inaccessible messages share one privacy-safe unavailable error; load and landing errors have separate messages. Cancelling an older navigation prevents it from completing after a newer one. The URL helper can remove the reference with `replaceState` while retaining unrelated parameters.

The host loads a suitable window and the shared feed lands on the mounted card and highlights it:

| | Duty | Analysis |
| --- | --- | --- |
| Opening context | Uses one unfiltered column for a plain copied link, bypassing locally persisted column filters; disables watch/follow for the landing | Builds a target-centered window; adjusts the date range when needed and keeps Analysis query/page semantics |
| Subsequent scrolling | Loads older or newer chunks around the target within the bounded column window | Loads either chronological direction around the target; maps physical edges according to list inversion |
| Landing | Column handle scrolls to and highlights the target | Analysis feed centers the target, then highlights it |

The plain copied URL is intentionally filter-free. Duty creates one default column when no explicit `state` is in the URL, even if the user has saved column filters. Analysis initializes from URL query state, so a plain `?m=...` link has no copied Analysis filters; the host can still apply its defaults and access rules. A manually constructed URL with explicit filters or Duty `state` is different and may restrict the target. Neither route bypasses backend access checks or guarantees a card outside the user's permissions.

The outline is owned by `MessageFeed`: it remains visible briefly, then fades and clears after two seconds. Reader scrolling alone does not remove it early. A committed new chunk, manual refresh, or eviction also clears the linked highlight. Reduced-motion users receive the same brief highlight without the fade. A card action that opens an editor can instead provide `editorHighlightedMessageId`, which takes precedence until the editor closes. The cards are ordinary shared `MessageCard` instances; their copy-link callbacks select only the route. Same-origin message URLs in message text are recognized by `shared/message-card/message-card-linkify.tsx` and rendered as message-reference links.

Relevant tests are under `shared/message-navigation/__tests__/`, `shared/message-card/__tests__/`, `shared/message-feed/__tests__/`, and both host test directories. The browser feed/workflow suites listed in [Message feed implementation](message-feed.md#regression-coverage) cover navigation in context. Search results, Important lists, replies, and mentions are future consumers of this navigation foundation, not existing link features.
