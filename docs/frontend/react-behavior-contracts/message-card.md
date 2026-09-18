# Message card and inbox compatibility

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
- **Expected observable result:** zoom is bounded and pan remains within fitted media; a media disclosure is opened before Duty thumbnails become interactive; images, video, and documents share the attachment-preview dialog and its ordered carousel; document previews do not unexpectedly restore focus to an unrelated control.
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
- **Known race/idempotency constraints:** leaving the viewport cancels future polling until re-entry; terminal and unauthorized responses cannot schedule another retry.
- **Source implementation:** `MessageCardVideoThumb.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCardVideoThumb.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

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

## Converted KMZ attachment preview

- **Status:** normative
- **Behavior ID:** `react-message-card-kmz-conversion-preview`
- **Affected route/component:** `KmzAttachmentPreviewLink` and `KmzAttachmentPreviewMap`
- **User role or permission:** users permitted to view and download the message attachment
- **Preconditions:** an attachment has a KMZ conversion job and an original download URL
- **User action or external event:** open the attachment after conversion is pending or complete
- **Expected observable result:** the component resolves conversion status, loads the converted preview, and presents original and converted downloads before the map preview with their respective filenames
- **Loading/empty/error/success behavior:** pending conversion remains pending until status resolves; preview or conversion failures remain explicit instead of presenting a fabricated map
- **URL, localStorage, or user-settings persistence:** none
- **API endpoint and compatibility requirements:** status, preview, and converted-download requests retain the media ID; the original download retains its original URL
- **Responsive and keyboard requirements:** the attachment trigger and both download links remain keyboard reachable
- **Known race/idempotency constraints:** closing or replacing the attachment aborts stale status and preview requests
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/KmzAttachmentPreviewLink.tsx`, `wdintel-web/src/ts/react/routes/shared/message-card/KmzAttachmentPreviewMap.tsx`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

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
- **Expected observable result:** Echo #3461 exposes device metadata only through an allowed device-access provider. Echo #3324 scopes bot-tag confirmation/cancellation to the matching message and tag, preserves its Popover anchor through unrelated rerenders, and suppresses the action for read-only cards, disabled bot tags, and different message/tag targets. Echo #3515 keeps date-only messages free of generated noon times and renders creation and event dates independently in Analysis.
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
- **Affected route/component:** MessageCard and supporting presentation children
- **Expected observable result:** Duty and Analysis expose their respective actions and navigation; text folding, headers, timestamps, missing-value fallbacks, comment authorship/disclosure, callsign/tag/report/transcription visibility, and ordinary loading/empty presentation follow the current component behavior.
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

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
- **Expected observable result:** message references become available and navigate correctly (#3092 / PR #3482); attachment and coordinate tiles remain aligned (#3324); preview gestures preserve protected OCR and summary content (#3368); coordinate hover previews remain stable (#3380); MGRS and Palitra points remain visible in thumbnail and fullscreen maps (#3453); and navigation-edge controls remain revealed (#3460).
- **Source implementation:** `routes/shared/message-card/` and attachment-preview/coordinate components.
- **Existing test(s):** `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`
- **Original Echo issue/PR, if known:** [#3092](https://github.com/echoua/echo/issues/3092), [PR #3482](https://github.com/echoua/echo/pull/3482), [#3324](https://github.com/echoua/echo/issues/3324), [#3368](https://github.com/echoua/echo/issues/3368), [#3380](https://github.com/echoua/echo/issues/3380), [#3453](https://github.com/echoua/echo/issues/3453), [#3460](https://github.com/echoua/echo/issues/3460).
