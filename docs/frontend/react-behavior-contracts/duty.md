# Duty

## Feed filter payload compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-duty-feed-filter-payload-compatibility`
- **Affected route/component:** Duty feed filter state restoration
- **User role or permission:** users viewing configured duty feeds
- **Preconditions:** a saved or legacy feed filter payload is restored
- **User action or external event:** the Duty route initializes a feed from persisted state
- **Expected observable result:** camelCase and legacy snake_case filter keys restore the same selected/denied groups, senders, frequencies, posts, and last-viewed message.
- **Loading/empty/error/success behavior:** omitted fields resolve through the default feed filter.
- **URL, localStorage, or user-settings persistence:** route feed state may contain either supported key convention.
- **API endpoint and compatibility requirements:** both key conventions remain accepted at this client restoration boundary.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `routes/rer-duty-neo/utils.ts`
- **Existing test(s):** `routes/rer-duty-neo/utils.spec.ts`
- **Original Echo issue/PR, if known:** none recorded.

## Message preview preference

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-message-preview-preference`
- **Affected route/component:** shared duty settings hook and message cards
- **User role or permission:** signed-in users
- **Preconditions:** user settings are loaded or an in-session settings update is received
- **User action or external event:** the user disables message-text previews
- **Expected observable result:** `Off` remains selected; it is not coerced back to the default line limit.
- **Loading/empty/error/success behavior:** an omitted preference uses the application default.
- **URL, localStorage, or user-settings persistence:** `messageTextPreviewLines: null` is the persisted Off value.
- **API endpoint and compatibility requirements:** user-settings responses and update events preserve null for the preference.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** a later user-settings event must not lose the Off value.
- **Source implementation:** `hooks/use-duty-settings.ts`
- **Existing test(s):** `hooks/use-duty-settings.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

## Live-feed scrolling and viewport offload

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-live-feed-scroll-continuity`
- **Affected route/component:** Duty feed windowed-scroll and idle viewport-offload hooks
- **User role or permission:** users viewing a duty feed
- **Preconditions:** a feed has mounted messages and may be following its live tail
- **User action or external event:** messages append, old rows trim, layout settles, the user scrolls upward, or a programmatic follow scroll changes the viewport
- **Expected observable result:** new messages follow smoothly only while the reader remains at the tail; an upward user scroll cancels following; trimming preserves the visible position; programmatic scrolling refreshes the mounted viewport without waking all offloaded cards.
- **Loading/empty/error/success behavior:** reduced-motion users remain pinned to the tail without a smooth animation; throttled frames still complete the follow.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** scrolling must not override a reader’s deliberate movement.
- **Known race/idempotency constraints:** queued layout work and resize handling must not publish stale physical-bottom or unread state.
- **Source implementation:** `routes/rer-duty-neo/useWindowedFeedScroll.ts`, `useFeedIdleViewportOffload.ts`
- **Existing test(s):** `useWindowedFeedScroll.spec.tsx`, `useFeedIdleViewportOffload.spec.tsx`, `index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

## Keyword-set selection

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-keyword-set-selection`
- **Affected route/component:** Duty keyword-set editor and feed keyword filter
- **User role or permission:** users allowed to edit or apply keyword sets
- **Preconditions:** keyword sets have been loaded for the current user
- **User action or external event:** the user creates a new set or selects a saved set for highlighting
- **Expected observable result:** a new set gets the first available `Новий набір` name; only an ID present in the loaded set list can be selected; labels use the saved set name.
- **Loading/empty/error/success behavior:** a missing or removed selected ID resolves to no selection.
- **URL, localStorage, or user-settings persistence:** selected state follows the duty filter model.
- **API endpoint and compatibility requirements:** keyword-set ACL fields returned as `can_edit` and `can_delete` normalize to camel case before determining available actions.
- **Responsive and keyboard requirements:** none specific to this shared logic.
- **Known race/idempotency constraints:** deleted sets must not remain selected after a refresh.
- **Source implementation:** `src/ts/react/services/api/organism-keyword-sets.ts`, `routes/rer-duty-neo/FeedKeywordsPanel.tsx`
- **Existing test(s):** `services/api/organism-keyword-sets.spec.ts` retains the operational ACL normalization fixture.
- **Original Echo issue/PR, if known:** none recorded.

## Own-report edit routing

- **Status:** inferred characterization
- **Behavior ID:** `react-duty-own-report-edit-routing`
- **Affected route/component:** Duty feed header edit action.
- **User action or external event:** the user edits an own report card.
- **Expected observable result:** the editor uses report mode and reloads the feed after save, rather than applying the regular-message update path.
- **Known race/idempotency constraints:** the report-mode decision remains tied to the selected card.
- **Source implementation:** `routes/rer-duty-neo/index.tsx`.
- **Existing test(s):** own-report edit case in `index.spec.tsx`.
- **Original Echo issue/PR, if known:** none recorded; retained as a data-integrity safeguard.
