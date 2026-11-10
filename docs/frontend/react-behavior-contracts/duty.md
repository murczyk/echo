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
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Message preview preference

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-message-preview-preference`
- **Affected route/component:** shared duty settings hook and message cards
- **User role or permission:** signed-in users
- **Preconditions:** user settings are loaded or an in-session settings update is received
- **User action or external event:** the user disables message-text previews
- **Expected observable result:** `Off` remains selected; it is not coerced back to the default line limit.
- **Loading/empty/error/success behavior:** omitted settings use 20 message-preview lines and keep media summaries disabled.
- **URL, localStorage, or user-settings persistence:** `messageTextPreviewLines: null` is the persisted Off value.
- **API endpoint and compatibility requirements:** user-settings responses and update events preserve null for the preference.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** a later user-settings event must not lose the Off value.
- **Source implementation:** `hooks/use-duty-settings.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/hooks/__tests__/use-duty-settings.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

## Live-feed scrolling and viewport offload

- **Status:** inferred characterization

- **Behavior ID:** `react-duty-live-feed-scroll-continuity`
- **Affected route/component:** Duty feed windowed-scroll and idle viewport-offload hooks
- **User role or permission:** users viewing a duty feed
- **Preconditions:** a feed has mounted messages and may be following its live tail
- **User action or external event:** messages append, old rows trim, layout settles, the user scrolls upward, or a programmatic follow scroll changes the viewport
- **Expected observable result:** new messages follow smoothly only while the reader remains at the tail; an upward user scroll cancels following; trimming preserves the visible position; programmatic scrolling refreshes the mounted viewport without waking all offloaded cards; a feed width change (the embedded report editor opening or closing, a window resize) wakes an offloaded feed at once, so placeholders measured at the old width cannot shift the reader on the next wheel tick ([#4117](https://github.com/echoua/echo/issues/4117)).
- **Loading/empty/error/success behavior:** reduced-motion users remain pinned to the tail without a smooth animation; throttled frames still complete the follow.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** scrolling must not override a reader’s deliberate movement.
- **Known race/idempotency constraints:** queued layout work and resize handling must not publish stale physical-bottom or unread state.
- **Source implementation:** `routes/rer-duty-neo/useWindowedFeedScroll.ts`, `useFeedIdleViewportOffload.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useFeedIdleViewportOffload.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx`
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
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Own-report edit routing

- **Status:** inferred characterization
- **Behavior ID:** `react-duty-own-report-edit-routing`
- **Affected route/component:** Duty feed header edit action.
- **User action or external event:** the user edits an own report card.
- **Expected observable result:** the editor uses report mode and reloads the feed after save, rather than applying the regular-message update path.
- **Known race/idempotency constraints:** the report-mode decision remains tied to the selected card.
- **Source implementation:** `routes/rer-duty-neo/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx`.
- **Original Echo issue/PR, if known:** none recorded; retained as a data-integrity safeguard.

## Duty message analysis links

- **Status:** normative
- **Behavior ID:** `react-duty-message-analysis-link`
- **Affected route/component:** Duty message cards in `FeedColumnContent`
- **User role or permission:** users allowed to view the Duty feed and copy message actions
- **Preconditions:** a Duty card represents a message with a stable message UID
- **User action or external event:** the user chooses the card action that copies its message link
- **Expected observable result:** the clipboard receives an absolute `/rer-analysis-neo?m=<message-uid>` URL that opens the same message in Analysis; copy feedback remains associated with that card's `link-<message-id>` action.
- **Loading/empty/error/success behavior:** clipboard success and failure use the existing Duty copy-action feedback.
- **URL, localStorage, or user-settings persistence:** the copied URL uses the current origin and preserves the message UID in the `m` query parameter.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** the copy action remains available through the shared keyboard-accessible message-card action menu.
- **Known race/idempotency constraints:** copying one card must not report feedback against another card.
- **Source implementation:** `wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/message-card.utils.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** [#3541](https://github.com/echoua/echo/pull/3541)

## Duty panel ownership

- **Behavior ID:** `react-duty-panel-ownership`
- **Expected observable result:** Escape and outside interaction close only their owning panel; transparent overlays do not block the feed; narrow layouts retain one mobile header owner while available actions remain reachable.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Duty embedded-editor feed layout

- **Status:** normative
- **Behavior ID:** `react-duty-embedded-editor-feed-layout`
- **Affected route/component:** Duty workspace and shared message editor.
- **Loading behavior:** initial loading and feed refresh use skeletons without a workspace spinner or dimming backdrop.
- **Expected observable result:** While the embedded message editor is open, Duty splits its workspace into equal feed and editor tracks with an `8px` gap. Desktop multi-feed mode keeps all columns only when every feed receives at least `360px`; otherwise it reuses active-feed tabs and mounts only the active feed tree. A lone feed and its loading skeleton are centered with a maximum width of `960px`, shrinking to the available track width on narrower screens; message cards use two internal columns from a 760px card-container width. Opening the editor contracts the feed to its track; closing it restores the available workspace width. The editor is a flat, transparent surface with one divider on its leading edge. Closing the editor restores all desktop columns and feed state.
- **Responsive and keyboard requirements:** the editor form adapts to its measured track width using the shared manage-message thresholds. The temporary active-feed layout trades simultaneous feed visibility for readable cards, independent feed/editor scrolling, and fewer mounted message trees. While the editor is open and the create action is hidden, feed scroll actions use their normal per-column inset instead of reserving space for that action. Editor-closed desktop behavior remains unchanged. Closing the editor returns focus to the create action when its original invoking control is no longer mounted.
- **Known race/idempotency constraints:** changing between all-feed and active-feed presentation must preserve each feed's data, selection, unread state, and scroll state.
- **Source implementation:** `routes/rer-duty-neo/RerDutyNeoWorkspace.tsx`, `routes/rer-duty-neo/duty-editor-layout.ts`, `routes/rer-duty-neo/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/RerDutyNeoWorkspace.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/duty-editor-layout.spec.ts`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx`, `wdintel-web/tests/e2e/message-card-duty-header.spec.ts`.
- **Original Echo issue/PR, if known:** [#3547](https://github.com/echoua/echo/issues/3547)

## Duty minimal report window

- **Status:** normative
- **Behavior ID:** `react-duty-minimal-report-window`
- **Affected route/component:** Duty workspace, shared Manage Message editor, Settings Duty section.
- **User role or permission:** users permitted to create or edit intelligence reports.
- **Preconditions:** the user enabled "Мінімалістичне вікно розвіддонесення" and the viewport uses the embedded editor (`>=1024px`). Analysis and narrower viewports keep their regular editors.
- **User action or external event:** the user starts creating a report from a message, opens an own report for editing, or expands the panel.
- **Expected observable result:** the report opens in a small panel centered over the source feed column, which fades behind it. The original message sits on top with a text-only report form underneath, and the panel does not change feed tracks, column count, or scroll position. The fade is visual only, so cards in the faded column stay clickable. A separate expand control moves the same report to the full side panel. A later report starts in the panel again; expanding is not remembered.
- **Loading/empty/error/success behavior:** the panel hides the report editor's other fields but uses the same form state, source metadata and attachment inheritance, so expanding keeps the draft. The panel starts no AI suggestion request; expanding starts it. A pasted file, a rejected file, or a failed validation on a field the panel hides expands to the full panel instead of hiding the attachment or error. The panel scrolls on short viewports, so its actions stay reachable. A report saved without a group has no group requirements, so the panel only blocks submission on a unit that needs an explicit selection, and tells the user to expand.
- **URL, localStorage, or user-settings persistence:** `minimalReportWindowEnabled` is a per-user setting, off by default. Older clients that omit it preserve the stored value.
- **API endpoint and compatibility requirements:** a new report submitted from the panel has no group field, so it is saved with the existing "Не відправляти" destination and the panel says so. Expanding a new report keeps that destination preselected, so the full panel does not ask for a group the user never saw; choosing a group happens there. The panel must never guess a group. Editing keeps the report's existing group.
- **Responsive and keyboard requirements:** Cmd/Ctrl+Enter submits, Escape closes while focus belongs to the panel and follows the dirty-state guard, and closing restores focus to the invoking control.
- **Known race/idempotency constraints:** starting a different report follows the dirty-draft guard and moves the panel to that message's column. Starting the same report from another column is the same intent and keeps the draft where it is. If the source column is removed, the panel moves to a remaining column.
- **Source implementation:** `routes/rer-duty-neo/useDutyMinimalReportEditor.ts`, `routes/rer-duty-neo/index.tsx`, `routes/shared/manage-message/MinimalReportEditor.tsx`, `routes/shared/manage-message/ManageMessageDrawer.tsx`.
- **Existing test(s):** `wdintel-web/tests/e2e/rer-duty-minimal-report.spec.ts`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useDutyMinimalReportEditor.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/index.spec.tsx`, `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`.
- **Original Echo issue/PR, if known:** [#4008](https://github.com/echoua/echo/issues/4008)
## Duty importance of my organism

- **Status:** normative
- **Behavior ID:** `react-duty-important-only-my-organism`
- **Affected route/component:** Duty message cards, Settings Duty section.
- **User role or permission:** any Duty user.
- **Preconditions:** the user enabled "Важливі лише мого підрозділу".
- **User action or external event:** a Duty feed renders a marked message, or the user marks or unmarks one.
- **Expected observable result:** the card shows the «Важливе» mark only when a person in the viewer's organism (same organism, no parents or children) set it. Marks from other organisms, AI marks and automatic ⚠️ marks are hidden. Messages stay in the feed. Marking a message that only another organism marked adds the viewer's mark through the usual flow.
- **Loading/empty/error/success behavior:** the feed keeps both `important` and `importantByMyOrganism`, so flipping the setting changes cards without a refetch. Mutation responses and refreshes update both values.
- **URL, localStorage, or user-settings persistence:** `importantOnlyMyOrganism` is a per-user setting, off by default. Older clients that omit it preserve the stored value.
- **API endpoint and compatibility requirements:** `InboxMessage.important_by_my_organism` and the same field of `ImportantMutationRsp` are relative to the viewer. With the setting on, Duty sends `keep_ai_importance` to `POST /api/rer/important/delete`, which then removes only the viewer's own mark and leaves an AI mark in place, because the viewer can't see it. Other views omit the field and also suppress the AI mark, as before.
- **Responsive and keyboard requirements:** none beyond the shared card.
- **Known race/idempotency constraints:** none beyond the shared importance operation.
- **Scope:** Analysis, reports, inbox mentions and classic Duty keep the aggregate mark.
- **Source implementation:** `routes/rer-duty-neo/FeedColumnContent.tsx`, `routes/rer-duty-neo/useRerDutyMessageItemActions.ts`, `routes/settings-neo/SettingsDutySection.tsx`, `wdintel-rs/src/rer_importer/important.rs`, `wdintel-rs/src/rer_importer/inbox/bl.rs`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/FeedColumnContent.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyMessageActions.spec.tsx`, `wdintel-web/src/ts/react/routes/settings-neo/__tests__/index.spec.tsx`.
- **Original Echo issue/PR, if known:** [#4073](https://github.com/echoua/echo/issues/4073)

## Duty radio-filter isolation

- **Behavior ID:** `react-duty-radio-filter-isolation`
- **Expected observable result:** restored frequency and post filters remain saved but do not leak into Cyber or Duty requests when radio features are unavailable.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/duty-creation-order.regression.spec.tsx`
- **Original Echo issue/PR, if known:** [#3568](https://github.com/echoua/echo/issues/3568)
