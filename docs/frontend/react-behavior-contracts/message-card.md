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
- **Existing test(s):** `inbox.spec.ts`, `inbox-messages.spec.ts`
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
- **Existing test(s):** `message-card-media-preview.spec.ts`; isolated helper/config tests removed as static implementation coverage.
- **Original Echo issue/PR, if known:** none recorded.

## Message text and media-summary previews

- **Status:** inferred characterization

- **Behavior ID:** `react-message-card-preview-continuity`
- **Affected route/component:** message card text preview and attachment media-summary carousel
- **User role or permission:** users able to view a message and its attachments
- **Preconditions:** message text has a configured preview limit or an attachment has a completed/loading summary
- **User action or external event:** the user changes a preview preference, expands a long summary, or moves between carousel media
- **Expected observable result:** Off shows the complete message text; a changed limit resets stale expansion; only overflowing media summaries offer expansion; loading summaries show placeholders; changing media resets expansion and carousel items are prefetched.
- **Loading/empty/error/success behavior:** loading remains visibly pending rather than an empty completed summary.
- **URL, localStorage, or user-settings persistence:** message-text limit follows the user setting, including Off.
- **API endpoint and compatibility requirements:** media-summary requests retain the established messenger access context for each carousel item.
- **Responsive and keyboard requirements:** expand/collapse controls remain operable for overflowing content.
- **Known race/idempotency constraints:** summary state and expansion must remain associated with the currently selected media ID.
- **Source implementation:** `MessageCard.tsx`, `attachment-preview/MediaSummaryPreview.tsx`
- **Existing test(s):** `MessageCard.spec.tsx`, `MediaSummaryPreview.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded.

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
- **Existing test(s):** `MessageCardVideoThumb.spec.tsx`
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
- **Existing test(s):** `OcrPreview.spec.tsx`
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
- **Existing test(s):** `useAttachmentPreviewSwipe.spec.tsx`
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
- **Existing test(s):** `message-coordinate-preview.spec.ts`; isolated plural-formatting and mocked component-prop coverage were removed.
- **Original Echo issue/PR, if known:** none recorded; retained as operational coordinate parser coverage.
