# Message card and inbox compatibility

## РЕР mode

- The system setting «Режим РЕР» is enabled when `hide_networks` is false; saving the switch preserves the inverse value in the existing API field.
- New Analysis defaults to closed groups and open filters in this mode, unless panel state is supplied in the URL.
- Shared Analysis and Duty cards replace the unit heading with networks, group, sender, and location in that order. Missing networks never restore the unit heading. The explicit unit remains in the body after frequency and permitted device details, in the former network-binding position, even when no networks or other body metadata are available. The DMR metadata control also remains in the body; moved header metadata is not duplicated there.
- Disabling РЕР mode retains the unit heading and hides networks. Existing group visibility and device access rules still apply.
- Existing tests: `wdintel-web/tests/e2e/message-card-rer-mode.spec.ts`, `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/index.spec.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`.

## AI network match

- With the system setting «ШІ: головна мережа повідомлення» on, a message with several networks may carry `network_match`: AI certainty and the message's callsigns each network lists (`matchedCallsigns`), plus the main network the server picked. The only network holding the message's callsigns is the main network; otherwise the main network reaches 80% and leads the runner-up by 20 points. The card then shows only that network, followed by «і ще N»; the toggle unfolds every network in the server's order (main network, networks holding the message's callsigns, then by certainty) and switches to «згорнути». Certainty is not printed next to the network name: hovering a network's icon shows the message's callsigns that network lists, then the AI's confidence that the message belongs to that network and the AI reason.
- Without `network_match` (setting off, a single network, or candidates that changed since scoring), or without a confident network, the card lists every network as before. Hiding networks («Режим РЕР» off) also drops the fold. Copying the binding and the navigation menu still list every network.
- Existing tests: `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`. Backend: `wdintel-rs/src/ai_network_match/README.md`.

## Inbox metadata compatibility default

- **Status:** operational compatibility
- **Behavior ID:** `react-inbox-metadata-default`
- **Expected observable result:** inbox messages without metadata expose an empty metadata list to message-card consumers.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/inbox.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Inbox message wire format

- **Status:** operational compatibility

- **Behavior ID:** `react-inbox-message-wire-compatibility`
- **Affected route/component:** shared inbox and inbox-message API boundaries consumed by message cards
- **User role or permission:** users with inbox visibility
- **Preconditions:** the inbox loads filtered messages or requests messages by ID
- **User action or external event:** filters are submitted, a message card loads, or metadata/media/comments arrive from the API
- **Expected observable result:** request fields preserve optional/null semantics; snake-case metadata, media, attachment, parent-linkage, comment, token, and report-summary fields normalize for message-card consumers.
- **Loading/empty/error/success behavior:** empty marked tokens do not enter the message model; absent optional collections normalize to usable empty collections where required.
- **URL, localStorage, or user-settings persistence:** query state is owned by inbox route state, not this API boundary.
- **API endpoint and compatibility requirements:** list and by-ID endpoints accept the established filter/context shape; responses may contain legacy snake-case fields and non-recursive report summaries.
- **Responsive and keyboard requirements:** none at the API boundary.
- **Known race/idempotency constraints:** request context must remain associated with the returned messages so a response is rendered using the initiating filters.
- **Source implementation:** `src/ts/react/services/api/inbox.ts`, `inbox-messages.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/inbox.spec.ts`, `wdintel-web/src/ts/react/services/api/__tests__/inbox-messages.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.

## Attachment preview interaction contract

- **Status:** inferred characterization

- **Behavior ID:** `react-message-card-attachment-preview-interaction`
- **Affected route/component:** message-card image, video, coordinate, and document preview shell
- **User role or permission:** users able to open the attachment
- **Preconditions:** an attachment preview is open
- **User action or external event:** the user zooms/pans media, enters fullscreen, presses Escape, or closes the preview
- **Expected observable result:** zoom is bounded and pan remains within fitted media; Escape remains owned by an active image editor or source-loading state until it can safely close the preview; copy actions give current success/error feedback; report-mode previews retain the shared report text field; a media disclosure is opened before Duty thumbnails become interactive; images, video, and documents share the attachment-preview dialog and its ordered carousel; document previews do not unexpectedly restore focus to an unrelated control.
- **Loading/empty/error/success behavior:** unsupported kinds use the document shell without inventing media interaction.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** focus, Escape, zoom, and pan require browser-level verification when linked to a real regression.
- **Known race/idempotency constraints:** selecting an attachment must keep the preview carousel aligned with that attachment's ordered mixed-media collection.
- **Source implementation:** attachment preview configuration and image preview utilities
- **Existing test(s):** `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`
- **Original Echo issue/PR, if known:** none recorded.

## Message text preview behavior

- **Status:** inferred characterization
- **Behavior ID:** `react-message-card-text-preview`
- **Affected route/component:** message card text preview
- **Expected observable result:** configured line limits fold long message text; Off displays the complete text; changing the limit resets stale expansion.
- **Source implementation:** `MessageCard.tsx`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Media-summary preview continuity

- **Status:** operational compatibility
- **Behavior ID:** `react-message-card-media-summary-preview`
- **Affected route/component:** attachment media-summary carousel
- **Expected observable result:** only overflowing summaries expand; loading remains visible; selecting another media item resets summary state; requests retain their media context and carousel items are prefetched.
- **Source implementation:** `attachment-preview/MediaSummaryPreview.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/__tests__/MediaSummaryPreview.spec.tsx`

## Video thumbnail loading safety

- **Status:** inferred characterization

- **Behavior ID:** `react-message-card-video-thumbnail-loading`
- **Affected route/component:** message-card video thumbnail loader
- **User role or permission:** users able to view a video attachment
- **Preconditions:** a video card has a pending or ready thumbnail
- **User action or external event:** the card approaches/leaves the viewport, the thumbnail is pending, fails, or returns 401
- **Expected observable result:** the dedicated thumbnail endpoint is used instead of full video media; offscreen cards do not fetch or poll; pending responses follow Retry-After with capped backoff; terminal failures stop polling; 401 triggers the shared unauthorized path.
- **Loading/empty/error/success behavior:** pending cards retain their loading affordance until a thumbnail loads or reaches a terminal failure.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** thumbnail retrieval uses the messenger media thumbnail route with same-origin credentials and server retry semantics.
- **Responsive and keyboard requirements:** none at the loading boundary.
- **Known race/idempotency constraints:** leaving the viewport cancels future polling until re-entry; terminal and unauthorized responses cannot schedule another retry. The shared loader keys image state and callbacks by source; replacing an attachment cannot display a late thumbnail from the previous source. Forced navigation or unauthorized events cancel requests and revoke loaded Blob URLs.
- **Source implementation:** `MessageCardVideoThumb.tsx`, shared `use-media-thumbnail.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCardVideoThumb.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

## Image thumbnail loading

- **Status:** intentional behavior (#3356)
- **Behavior ID:** `react-message-card-image-thumbnail-loading`
- **Affected route/component:** message-card image thumbnails
- **User role or permission:** users able to view an image attachment
- **Preconditions:** an image has a messenger media ID
- **User action or external event:** the card approaches the viewport or thumbnail generation fails
- **Expected observable result:** the card requests the authenticated JPEG thumbnail; opening and downloading still use the original image. Missing, failed, or still-loading thumbnails after 30 seconds fall back to the original image.
- **Loading/empty/error/success behavior:** the loading skeleton remains until the thumbnail or fallback original loads; a broken image shows an error tile.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** uses `/api/messenger/media/{id}/thumbnail`; images without a messenger media ID keep their original-image behavior.
- **Responsive and keyboard requirements:** existing card controls remain unchanged.
- **Known race/idempotency constraints:** offscreen cards do not request thumbnail bytes; returning to view can retry pending thumbnails.
- **Source implementation:** `MessageCardImageThumb.tsx`, shared `use-media-thumbnail.ts`. Device tiles reuse the loader with their own revision URL, request limit and icon fallback; the message image fallback policy remains unchanged.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCardVideoThumb.spec.tsx`

## OCR and media-summary response safety

- **Status:** inferred characterization

- **Behavior ID:** `react-message-card-ocr-and-summary-response-safety`
- **Affected route/component:** message-card OCR split preview and media-summary preview
- **User role or permission:** users able to view an attachment
- **Preconditions:** an attachment's OCR or summary request is in flight, or several summaries have been viewed
- **User action or external event:** the user navigates to another attachment before a response returns, or exceeds the summary cache capacity
- **Expected observable result:** a response for a previously selected attachment does not replace the current attachment's OCR or summary; the summary cache evicts its least-recently-used entry when full.
- **Loading/empty/error/success behavior:** the current attachment keeps its own loading or completed state while stale responses are discarded.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** OCR and media-summary responses remain associated with their requested media ID.
- **Responsive and keyboard requirements:** none at the response boundary.
- **Known race/idempotency constraints:** late responses must not overwrite state for a newly selected attachment; cache growth remains bounded.
- **Source implementation:** `attachment-preview/OcrPreview.tsx`, `attachment-preview/MediaSummaryPreview.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/__tests__/OcrPreview.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

## Attachment swipe navigation

- **Status:** inferred characterization

- **Behavior ID:** `react-message-card-attachment-swipe-navigation`
- **Affected route/component:** attachment-preview swipe hook
- **User role or permission:** users able to open multiple attachments
- **Preconditions:** an attachment preview stage has adjacent attachments
- **User action or external event:** a user swipes left/right or scrolls inside a document panel
- **Expected observable result:** left/right swipes select the appropriate neighboring attachment only when navigation is enabled; scrollable document panels consume their own gestures without changing the attachment.
- **Loading/empty/error/success behavior:** disabled navigation ignores gestures.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** touch behavior must coexist with independently scrollable content.
- **Known race/idempotency constraints:** one gesture must not both scroll a document and change the current attachment.
- **Source implementation:** `useAttachmentPreviewSwipe.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/__tests__/useAttachmentPreviewSwipe.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as gesture-conflict safeguards.

## Message coordinate preview extraction

- **Status:** operational compatibility

- **Behavior ID:** `react-message-coordinate-preview-extraction`
- **Affected route/component:** message-card coordinate preview resolver
- **User role or permission:** users able to inspect a message and its completed documents
- **Preconditions:** a message contains direct, persisted, text, Palitra, or document-derived coordinates
- **User action or external event:** the coordinate preview is resolved
- **Expected observable result:** persisted locality coordinates take precedence over legacy text; direct WGS/other supported coordinates avoid unnecessary palette lookup; completed document coordinates merge, deduplicate, and preserve successful points if another document fetch fails.
- **Loading/empty/error/success behavior:** document lookup errors remain observable without discarding available points.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** document coordinate summaries retain title, description, planned means, and supported coordinate-system mapping.
- **Responsive and keyboard requirements:** none at the parser boundary.
- **Known race/idempotency constraints:** a failed document lookup must not overwrite already resolved coordinates.

Named positions in message text and recognized document positions join this map
with their names, source dates and accessible supporting messages (#3676).
Hovering or focusing a located text position opens the shared overview/detail
preview; clicking or pressing Enter/Space opens the full message map focused on
that point. Positions without parseable coordinates remain textual. Regression:
`wdintel-web/tests/e2e/message-card-media-preview.spec.ts`.

- **Source implementation:** `message-coordinate-preview.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/message-coordinate-preview.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational coordinate parser coverage.

## Compact tag expansion continuity

- **Status:** inferred characterization
- **Behavior ID:** `react-message-card-compact-tag-expansion-continuity`
- **Affected route/component:** compact MessageCard tag rows.
- **User action or external event:** the user checks a rest tag, then tag metadata refreshes while the row is expanded.
- **Expected observable result:** checked tags remain visible and the first compact row repacks using current metadata.
- **Known race/idempotency constraints:** metadata refresh cannot restore stale compact geometry or collapse an active selection.
- **Source implementation:** `routes/shared/message-card/MessageCard.tsx`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as interaction safeguards.

## Message-card evidence hierarchy and actions

- **Status:** inferred characterization
- **Behavior ID:** `react-message-card-evidence-hierarchy`
- **Affected route/component:** `src/ts/react/routes/shared/message-card/MessageCard.tsx`, `MessageCardContent.tsx`, and action/renderer children.
- **User role or permission:** users with message visibility; editing, archive, intelligence-report, and analysis actions remain capability-dependent.
- **Expected observable result:** a card presents the message identity, time/source, text, locations, attachments, comments/authorship, tags, and available actions in a stable operational hierarchy. Duty and Analysis variants expose only the actions meaningful for their respective workflow. A message archive/download action preserves the original evidence identity and never substitutes an unrelated attachment.
- **Loading/empty/error/success behavior:** comments, intelligence reports, summaries, transcription, and attachment metadata show their own pending/error/empty state without hiding already available message evidence.
- **Comment compatibility:** a nonempty legacy comment already shown as an undeleted linked report with the same trimmed text is displayed once, with its full text visible on touch screens too. Distinct legacy comments and comments whose linked report was deleted remain visible. Browser coverage: `wdintel-web/tests/e2e/message-card-comments.spec.ts`.
- **Responsive and keyboard requirements:** card actions, attachment controls, tag controls, and comments remain reachable by keyboard; media dialogs close with Escape without moving focus to an unrelated card control.
- **Known race/idempotency constraints:** a message refresh or action response cannot replace the card's newer message identity, selected attachment, comment set, tag state, or active report result.
- **Source implementation:** `src/ts/react/routes/shared/message-card/MessageCard.tsx`, `MessageCardContent.tsx`, `MessageCardIntelligenceReports.tsx`, and attachment-preview components.
- **Current retained test(s):** `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`

## Audio, transcription, and document evidence

- **Status:** inferred characterization
- **Behavior ID:** `react-message-card-media-evidence`
- **Affected route/component:** Message Card image/video/audio/document/coordinate renderers and attachment-preview shell.
- **Expected observable result:** each supported evidence type has a truthful presentation: audio exposes playback/transcription state, documents expose safe preview/download/open actions, coordinates preserve their source and map meaning, and image/video previews retain carousel order. Unsupported or unavailable media remains an explicit unavailable state rather than a fabricated preview.
- **Loading/empty/error/success behavior:** pending transcription/preview processing remains visible; completed results remain associated with their media revision; archive/download actions remain available only when the corresponding artifact exists.
- **Source implementation:** `src/ts/react/routes/shared/message-card/attachment-preview/`, `renderers/`, and coordinate components.
- **Current retained test(s):** `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`

## KML/KMZ attachment preview

- **Status:** normative
- **Behavior ID:** `react-message-card-kmz-conversion-preview`
- **Affected route/component:** `KmzAttachmentPreviewLink` and `KmzAttachmentPreviewMap`
- **User role or permission:** users permitted to view and download the message attachment
- **Preconditions:** an attachment has an original download URL. Native `.kml` and `.kmz` files are previewed directly; KML may also have an optional converted KMZ, while other supported geodata files remain conversion-backed.
- **User action or external event:** open a native attachment or a supported attachment with pending or completed conversion
- **Expected observable result:** native files load from the original media URL and are parsed in a frontend worker inside the shared coordinate-map shell. KML conversion status is checked independently for an optional converted download; its failure does not replace the native map or report a preview failure. Converted files resolve conversion status, then fetch and parse the converted KMZ in the same worker. Points, lines, and polygon rings (including holes) fit bounds together. The map draws polygons first, routes second, and points last so overlapping routes and positions remain visible; point labels prefer a nonblank KML name and otherwise use its plain-text description. Point-only files derive an approximate convex hull per folder and point color when that group has at least 30 points; sparse groups stay as colored clusters so distant points do not create misleading areas. These hulls are inferred from points rather than stored boundaries. Files with more than 500 point groups fall back to colored clusters, and each inferred hull is capped at 512 vertices. At zoom 15 and above, bounded viewport clusters reveal individual palette-sized `circleMarker` points with permanent palette-style labels where their marks fit separately. Cluster counts use contrasting text and have no redundant hover label. Polygon fill opacity is capped at 0.25 so source colors cannot obscure the basemap. Dense viewport points remain represented by adaptive clusters rather than being silently dropped; a cluster that still contains over 100 points at maximum zoom does not expand all markers at once. Initial bounds include all valid geometry and are fitted once; point updates and resize do not reframe the map. Polygons without a three-coordinate exterior are skipped; malformed interior rings are skipped while valid holes remain. KMZ inflation rejects oversized declared members before decompression and stops streaming compressed input as soon as actual expanded output reaches the limit. The header keeps one download control and always opens a menu for KML/KMZ, with an original choice and a converted KMZ choice only when a distinct conversion is ready; the per-file cooldown disables only the selected choice. Message cards retain the completed-conversion ZIP download containing original and converted files. Native KMZ gets neither a converted download choice nor a duplicate ZIP shortcut. The parent carousel is reused and map dragging does not trigger swipe navigation.
- **Loading/empty/error/success behavior:** pending and processing conversion states have distinct copy. Preview failures show a recoverable explanation with expandable technical details. Optional KML conversion failures leave the native map visible and expose a conversion-specific retry control whose tooltip shows a short action label and expandable technical details. After Retry, a disabled progress control remains visible until conversion completes or fails; completion announces the converted download. Polling stops on failure or timeout. Native sources exceeding the 25 MiB preview limit show an explicit download-only state.
- **URL, localStorage, or user-settings persistence:** none
- **API endpoint and compatibility requirements:** native preview fetches the attachment's `source.originalHref` (normally `/api/messenger/media/{media_id}`), the same URL used for the original download; the current frontend has no separate native-preview endpoint. Converted preview fetches `/api/messenger/media/{media_id}/kmz-conversion/download` after `/api/messenger/media/{media_id}/kmz-conversion/status` reports completion; that KMZ URL also serves the secondary download. Failed conversion retry posts to `/api/messenger/media/{media_id}/kmz-conversion/retry` to requeue the existing job. The legacy `/api/messenger/media/{media_id}/kmz-conversion/preview` points-and-lines endpoint remains available for older clients only. Conversion polling only continues for pending or processing work.
- **Responsive and keyboard requirements:** the attachment trigger and both download links remain keyboard reachable; arrow keys focused inside the Leaflet map remain map input and do not navigate the attachment carousel.
- **Known race/idempotency constraints:** closing or replacing the attachment aborts stale status and preview requests
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/KmzAttachmentPreviewLink.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/KmzAttachmentPreviewMap.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/renderers/KmzAttachmentPreviewRenderer.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/kmz/kmz-preview-parser.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/kmz/__tests__/kmz-preview-parser.spec.ts`, `wdintel-web/src/ts/react/routes/shared/message-card/renderers/__tests__/KmzAttachmentPreviewRenderer.spec.tsx`, `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`
- **Original Echo issue/PR, if known:** [#3521](https://github.com/echoua/echo/issues/3521), [#3540](https://github.com/echoua/echo/pull/3540)

## Manage Message draft and coordinate safeguards

- **Status:** inferred characterization
- **Behavior ID:** `react-manage-message-draft-coordinates`
- **Affected route/component:** `src/ts/react/routes/shared/manage-message/ManageMessageDrawer.tsx` and coordinate sections.
- **Expected observable result:** coordinate entry and previews preserve the entered coordinate list and its selected interpretation; settlement lookup uses the selected real group and never sends the no-send sentinel as an authorization-scoped group key; a draft cannot submit until required message fields are satisfied. Closing or reopening a drawer preserves only the session behavior explicitly owned by its caller and does not silently submit incomplete data.
- **Known race/idempotency constraints:** coordinate parsing, map preview, and submit eligibility remain tied to the current draft; stale validation cannot enable a superseded draft.
- **Source implementation:** `src/ts/react/routes/shared/manage-message/ManageMessageDrawer.tsx`, `drawer-sections/CoordinateListInput.tsx`, and `CoordinateInputPreview.tsx`.
- **Current retained test(s):** `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`.

## Issue-linked MessageCard regressions

- **Status:** issue-backed regressions
- **Behavior ID:** `react-message-card-issue-regressions`
- **Affected route/component:** `MessageCard.tsx`, `MessageCardHeader.tsx`, and bot-tag controls
- **Expected observable result:** Echo #3461 exposes device metadata only through an allowed device-access provider. Echo #3324 scopes bot-tag confirmation/cancellation to the matching message and tag, preserves its Popover anchor through unrelated rerenders, and suppresses the action for read-only cards, disabled bot tags, and different message/tag targets. Echo #3515 keeps date-only interception metadata free of generated noon times. The header always renders the message's event date/time, independently of the sorting time basis. The independent system creation-time display uses `createdAt` without changing when the selected basis changes; Duty and Analysis both retain a dedicated, right-aligned footer row in normal document flow to preserve stable card geometry and reader anchors.
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/MessageCard.tsx`, `MessageCardHeader.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`
- **Original Echo issue/PR, if known:** [#3461](https://github.com/echoua/echo/issues/3461), [#3324](https://github.com/echoua/echo/issues/3324), [#3515](https://github.com/echoua/echo/issues/3515)

## Retained media parsing and safety

- **Status:** operational compatibility
- **Behavior ID:** `react-message-card-media-parsing-safety`
- **Affected route/component:** MessageCard media handling
- **Expected observable result:** ambiguous MIME/extension metadata selects the right audio/video handler; snake-case oversized audio avoids derived-image processing; each attachment has an independent download cooldown; legacy image ordering preserves the matching metadata identity; archive count/size rejection leaves individual downloads available while valid multi-attachment collections retain archive access.
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/MessageCard.tsx`, `MessageCardMedia.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`

## Documented MessageCard presentation and workflows

- **Status:** inferred characterization
- **Behavior ID:** `react-message-card-presentation-workflows`
- **Narrow-card actions (#3927):** Overflow is one flat list, grouping primary actions, copying, navigation, filter exclusions, and secondary actions with dividers only between nonempty groups. Individual network destinations remain separate items. Existing permission/data guards, action handlers, and the wide-card toolbar and menus remain unchanged. Browser coverage: `wdintel-web/tests/e2e/message-card-layout.spec.ts`, `wdintel-web/tests/e2e/rer-duty-workflows.spec.ts`.
- **Quick action (#3927):** The shared `messageCardQuickAction` user preference selects report creation, reply, importance, bookmark, copy text, copy link, edit, or delete for the single direct action on narrow Duty and Analysis cards. That action is omitted from narrow overflow; report creation moves into overflow when another action is selected. An unavailable action is hidden without a replacement or preference reset. Importance/bookmark labels and pressed states track the message. The compact settings selector uses the card icons, and its selection immediately updates the card preview. Copy actions from either the toolbar or menu show the shared success snackbar only after the clipboard write completes. Wide-card controls retain their existing behavior. Missing/NULL or unrecognized preferences use copy text when the server’s «Режим РЕР» is enabled (`hide_networks` false/NULL or no active system settings), and report creation when it is disabled. A stored personal choice takes precedence regardless of user roles or later server-mode changes. Saving unrelated settings omits this field and leaves the stored choice (including NULL) intact; an explicit selector change persists the personal choice. Explicit unknown or NULL quick actions are rejected by the API. For older API responses with a missing, NULL, or unrecognized quick action, React and classic Elm fall back to report creation. Database/API coverage: `wdintel-rs/src/user_settings/functional_tests.rs`. Browser coverage: `wdintel-web/tests/e2e/message-card-quick-action.spec.ts`.
- **Coordinate preloading:** Coordinate lookup and thumbnail-map mounting start within 1000px above or below the nearest message-feed scroller, falling back to the browser viewport outside feeds. More distant coordinates stay deferred; collapsed categories still mount nothing until revealed. Duty windowing and idle offloading remain unchanged, so only mounted cards can preload.
- **Reply chains:** Two-message chains have no standalone Analysis action beside their heading; cited-message navigation remains available. Longer chains retain the all-messages popover and its labeled Analysis link. In dark mode, the popover mixes the card surface with 6% foreground to sit one tone above the card; its existing translucent cited-message fills create a slightly lighter inner level. Light-mode paper, the semantic border, and the popover shadow are unchanged; MUI's elevation overlay remains disabled.
- **Affected route/component:** MessageCard and supporting presentation children
- **Attachment display:** Shared card settings offer semantic `Collapsed`, `Compact`, and `Large` modes. Existing `dutyCollapseMediaPreviews` selects deferred exclusive category reveal; `largeMediaPreviews` selects larger photo/video/coordinate tiles only when previews are not collapsed. Compact tiles are 72px square with 8px gallery gaps; large tiles are 144px square with 4px gallery gaps, fitting four previews per row at Duty's maximum single-feed width. Sizes are defined in shared CSS rather than preference values or size-specific symbol names. Shells, controls, and coordinate loading/error tiles share the selected square size; download controls stay anchored within tiles and galleries wrap within narrow cards. Documents, audio players, full-screen previews, and hover maps retain their existing sizes. Missing or NULL large-preview flags mean compact; old clients omitting that setting preserve the stored value. Settings updates propagate to mounted Duty and Analysis cards without per-card layout wrappers.
- **Typography:** With the app's 14px root, message text, audio transcriptions, and header unit/date use 14px/21px by default or 16px/24px when the shared `largeMessageCardText` setting is enabled; unit weight remains 500. Missing or NULL flags mean 14px, and older clients omitting the flag preserve the stored selection. The choice is available in both card-settings sections and updates mounted feeds, loading skeletons, and the animated settings preview without a reload. Ordinary metadata remains 14px/20px. Comments, reports, and cited/hover previews remain 14px/21px; tags, callsigns, and attachment filenames remain 13px/18px; tertiary actions and the receipt-time footer remain 12px/16px. Sizes are rem-based and line heights scale with the text. Icons, the existing system font family, theme colors, player-internal typography, watermark, and column geometry remain unchanged.
- **Settings preview:** Duty and Analysis settings share an API-free skeleton preview using the card's responsive header/body/footer geometry and attachment sizes. It contains no sample text, dates, coordinates, or tag labels; muted bars and primary-colored placeholders retain the earlier skeleton styling. Tag density, attachment mode, AI positions (including global enablement), file summary, and text folding update the preview with scoped transitions; reduced-motion preferences remove animation. Attachment labels and helper text match the corresponding existing settings typography and theme colors. Browser coverage: `wdintel-web/tests/e2e/message-card-settings-preview.spec.ts`.
- **Receipt-time placement:** In two-column cards without full-width comments, the main content spans two grid rows while details and receipt time share the right column. The time aligns with the bottom of taller left content, or sits below taller right content with a gap; no absolute positioning or JavaScript measurements are used. On single-column cards it follows details. Full-width comments retain the separate footer below them. Feed skeletons and settings previews use the same grid placement.
- **Expected observable result:** Duty and Analysis expose their respective actions and navigation; text folding, headers, timestamps, missing-value fallbacks, comment authorship/disclosure, callsign/tag/report/transcription visibility, and ordinary loading/empty presentation follow the current component behavior. The header always shows a red outlined diamond beside the explicit unit above the message's labeled event date/time, independently of sorting; the date includes the year and date-only events omit the time. The row shows the trimmed explicit unit or `—`; strict-network and hide-network policies never replace or suppress it. Network bindings remain in details. A divider separates the header from content. The muted bottom-right footer independently shows `createdAt` as `HH:mm` today, `DD.MM, HH:mm` on other dates this year, and `DD.MM.YYYY, HH:mm` in other years, using the Kyiv calendar and shared visibility-aware day/year-boundary scheduling. The body uses one column below 760px and two columns from 760px: the right column takes 32% (minimum 220px), the left takes the remaining width, with a 24px gap. Text and attachments stay together on the left, with metadata, tags, reports, and replies on the right. On narrow cards, details follow text and attachments. The toolbar is right-aligned; at inner card widths up to 520px it keeps report creation direct and moves other applicable actions into overflow.
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/`
- **Existing test(s):** `wdintel-web/tests/e2e/message-card-layout.spec.ts`, `wdintel-web/tests/e2e/message-card-duty-header.spec.ts`, `wdintel-web/tests/e2e/message-card-attachment-display.spec.ts`, `wdintel-web/tests/UserSettingsRegressionTests.elm`.

## Message edit mapping

- **Status:** inferred characterization
- **Behavior ID:** `react-message-edit-mapping`
- **Affected route/component:** Manage Message drawer.
- **Expected observable result:** form fields map to editable message fields; null/default/date/tag values remain usable in the form. Saving an edit preserves every untouched persisted field, including media, tokens, network IDs, callsigns, and coordinates. Echo #3515 preserves a date-only message as date-only when editing or copying it instead of restoring a generated noon time.
- **Source implementation:** `routes/shared/manage-message/manage-message-drawer.mappers.ts`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/manage-message-drawer.mappers.spec.ts`
- **Original Echo issue/PR, if known:** [#3515](https://github.com/echoua/echo/issues/3515)

## Browser message-card regressions

- **Status:** issue-backed regressions
- **Behavior ID:** `react-message-card-browser-regressions`
- **Expected observable result:** message references become available and navigate correctly, including middle-click navigation (#3092 / PR #3482); attachment and coordinate tiles remain aligned (#3324); preview gestures preserve protected OCR and summary content (#3368); coordinate hover previews remain stable (#3380); MGRS and Palitra points remain visible in thumbnail and fullscreen maps (#3453); and navigation-edge controls remain revealed (#3460).
- **Source implementation:** `routes/shared/message-card/` and attachment-preview/coordinate components.
- **Existing test(s):** `wdintel-web/tests/e2e/message-card-message-reference.spec.ts`, `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`
- **Original Echo issue/PR, if known:** [#3092](https://github.com/echoua/echo/issues/3092), [PR #3482](https://github.com/echoua/echo/pull/3482), [#3324](https://github.com/echoua/echo/issues/3324), [#3368](https://github.com/echoua/echo/issues/3368), [#3380](https://github.com/echoua/echo/issues/3380), [#3453](https://github.com/echoua/echo/issues/3453), [#3460](https://github.com/echoua/echo/issues/3460).

## Duty header regression

- **Behavior ID:** `react-message-card-duty-header`
- **Expected observable result:** the narrow Duty header keeps the explicit unit/date at left and direct report creation plus overflow actions at right, without duplicate timestamp or tag controls.
- **Existing test(s):** `wdintel-web/tests/e2e/message-card-duty-header.spec.ts`
- **Original Echo issue/PR, if known:** [#3570](https://github.com/echoua/echo/issues/3570)

## Message-card authorization

- **Behavior ID:** `react-message-card-authorization`
- **Expected observable result:** write and delete permissions remain independent; viewer cards retain permitted downloads without mutation controls, and Cyber group exclusion does not disclose post exclusion data.
- Duty and Analysis show the message-card delete action only with `DeleteMsg` access (including inherited Admin/Full access). Duty deletion requires confirmation; cancellation preserves the message. Deleting from one column preserves another column's historical reading position and its return-to-latest navigation with auto-scroll ON or OFF. Browser regression: `wdintel-web/tests/e2e/rer-duty-message-delete.spec.ts` ([#3894](https://github.com/echoua/echo/issues/3894)).
- After successful deletion, Duty removes the message from every loaded feed, pending buffer, and off-window unread identity collection without waiting for an inbox event. Deletion applies once regardless of whether the event or HTTP response arrives first, preserving other known unread identities and the anonymous unread remainder; API failure preserves all feeds. Deleted loaded tail markers move to the preceding historical boundary; unknown historical gaps remain loadable until a newer request confirms exhaustion. Post-link arrivals remain unread. Regressions: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyMessageActions.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.directional-loads.spec.tsx`, and `wdintel-web/tests/e2e/rer-duty-message-delete.spec.ts` ([#3894](https://github.com/echoua/echo/issues/3894)).
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`
- **Original Echo issue/PR, if known:** [#3568](https://github.com/echoua/echo/issues/3568), [#3569](https://github.com/echoua/echo/issues/3569)

## Attachment replacement transition

- **Behavior ID:** `react-message-card-attachment-replacement`
- **Expected observable result:** an attachment replacement is immediately visible without an outgoing animation layer.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Video playback delivery

- Managed messenger videos use the authenticated playback endpoint and stream
  after a one-byte readiness request, including small attachments.
- Each readiness request has a 30-second timeout and automatic retries stop after
  two minutes. Errors expose a manual Retry while original Open/Download remain
  available. A stalled player also leaves its loading state after 30 seconds.
- A rejected autoplay request prompts an explicit tap; other playback failures
  remain visible. Carousel navigation and Duty's creation-time contract are
  unchanged.
- Coverage: `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/message-card-video-loading.spec.ts`,
  `wdintel-web/src/ts/react/routes/shared/message-card/renderers/__tests__/VideoAttachmentPreviewRenderer.spec.tsx`
  and `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`.

Attachment map readiness uses `coordinateStatus.hasCoordinates` when a published
attachment revision is present, regardless of the AI summary state. Revision
changes reload points; an empty revision clears stale coordinates. Legacy summary
readiness applies only when coordinate status is absent. Maps retain lazy mounting
and visible lookup errors. Regression coverage:
`wdintel-web/src/ts/react/routes/shared/message-card/__tests__/message-coordinate-preview.spec.ts`
and `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCardCoordinateAttachment.spec.tsx`.

## Attachment order

Attachment arrays and the mixed-media preview carousel follow persisted `order_f64`, with UUID as the tie-breaker. Null positions sort last by UUID; messages with all positions null retain their UUID order. Existing media categories remain grouped on the card.

Legacy galleries without explicit positions retain the original image order, including image URLs without media rows; enriching an image with media metadata does not move it. Explicit positions control gallery and carousel order once available.

Both React and Elm accept media responses without `order_f64` as legacy attachments with an unset position.

The message editor displays a single ordered attachment list. Its up/down controls work with the keyboard, include pending uploads, remain disabled during submission, and save through the existing message-edit request. On the first move of legacy attachments, positions are assigned to the whole message; later moves use a fractional position and preserve unaffected values. Positions are renumbered only if floating-point precision leaves no space between neighbors. Replacement images retain their original attachment's position; copied messages preserve source order independently.

Regressions: `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`, `wdintel-web/tests/e2e/manage-message-drawer.spec.ts`, and `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`.
