# Image editor

## Canvas geometry and editing

- **Status:** issue-backed regression
- **Behavior ID:** react-image-editor-canvas-geometry
- **Affected route/component:** shared message image editor and Fabric canvas integration
- **User role or permission:** users allowed to create or edit message attachments.
- **Preconditions:** an editable image is open with crop, draw, text, arrow, magnifier, or viewport tools available.
- **User action or external event:** the user draws, crops, zooms, pans, resizes, changes a tool, or presses Escape.
- **Expected observable result:** gestures preserve native image coordinates through CSS scaling; constrained shapes remain bounded; arrows, crop geometry, magnifier sampling, cursor state, text editing, and viewport restoration remain aligned with the visible image.
- **Loading/empty/error/success behavior:** a failed canvas source initialization keeps Apply unavailable; invalid crop work restores transient canvas state without exporting a partial image.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** workspace wheel zoom uses one non-passive listener; Escape resolves the active text, crop, confirmation, or editor layer without closing an outer dialog incorrectly.
- **Known race/idempotency constraints:** repeated pointer completion commits one drawing/history action; stale canvas references do not replace the current document state.
- **Source implementation:** routes/shared/image-editor/ImageEditor.tsx, ImageEditorWorkspace.tsx, and image-editor-*.ts helpers.
- **Existing test(s):** ImageEditor.spec.tsx, ImageEditorWorkspace.spec.tsx, image-editor-arrow.spec.ts, image-editor-crop.spec.ts, image-editor-magnifier.spec.ts, image-editor-pointer.spec.ts, image-editor-text.spec.ts, image-editor-viewport.spec.ts, use-image-editor-canvas.spec.ts, use-image-editor-drawing-gestures.spec.ts.
- **Original Echo issue/PR, if known:** [#3099](https://github.com/echoua/echo/issues/3099).

## Export, history, and raster safety

- **Status:** issue-backed regression
- **Behavior ID:** react-image-editor-export-history
- **Affected route/component:** shared message image editor export, undo history, raster operations, and replacement queue.
- **User role or permission:** users allowed to edit message attachments.
- **Preconditions:** a source image, optional crop, and editable canvas state are available.
- **User action or external event:** the user applies an edit, undoes/redoes, blurs/pixelates/redacts, or starts overlapping concealment work.
- **Expected observable result:** output uses native source dimensions and selected crop coordinates; raster operations alter only the requested native area; undo/redo preserves ordered snapshots and recovery state.
- **Loading/empty/error/success behavior:** over-budget or invalid raster work rejects before mutation; a rejected queued operation does not prevent later work from completing.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** replacement output remains compatible with attachment upload inputs.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** a duplicate pointer-up records one history entry; queued raster operations serialize so earlier failure cannot corrupt a later replacement.
- **Source implementation:** routes/shared/image-editor/image-editor-export.ts, image-editor-raster.ts, use-image-editor-history.ts, and use-image-editor-raster-queue.ts.
- **Existing test(s):** image-editor-export.spec.ts, image-editor-raster.spec.ts, use-image-editor-history.spec.tsx, use-image-editor-raster-queue.spec.tsx.
- **Original Echo issue/PR, if known:** [#3099](https://github.com/echoua/echo/issues/3099).

## Source validation and attachment replacement

- **Status:** issue-backed regression
- **Behavior ID:** react-image-editor-source-replacement-safety
- **Affected route/component:** image-editor source loader and local attachment replacement.
- **User role or permission:** users allowed to edit message attachments.
- **Preconditions:** an image source or replacement file is selected, including legacy MIME labels, streamed content, or a persisted upload.
- **User action or external event:** source data arrives, the user saves a replacement, or upload fingerprint cleanup fails.
- **Expected observable result:** only supported bounded static image sources become editable; source dimensions are read safely; replacement saves preserve the intended attachment and user-entered filename.
- **Loading/empty/error/success behavior:** malformed, animated, oversized, unauthenticated, or failed sources remain unusable with an actionable error; a failed save keeps its confirmation open instead of silently discarding the edit.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** Uppy/Tus fingerprint handling and accepted image MIME normalization retain compatibility with current browser upload behavior.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** failed fingerprint cleanup cannot replace attachment bytes; a source/replacement from one carousel item cannot be applied to another item.
- **Source implementation:** routes/shared/image-editor/image-editor-source-validation.ts, image-editor-upload.ts, image-editor-supported-image.ts, and ImageEditor.tsx.
- **Existing test(s):** ImageEditor.spec.tsx, image-editor-source-validation.spec.ts, image-editor-supported-image.spec.ts, image-editor-upload.spec.ts.
- **Original Echo issue/PR, if known:** [#3294](https://github.com/echoua/echo/issues/3294).

## Text controls and padded annotations

- **Status:** issue-backed regression
- **Behavior ID:** react-image-editor-text-controls
- **Affected route/component:** image-editor numeric controls and Fabric padded text annotations.
- **User role or permission:** users allowed to edit image annotations.
- **Preconditions:** a text object or its compact numeric controls are active.
- **User action or external event:** the user enters an out-of-range value, presses Enter or Escape, or toggles padded text.
- **Expected observable result:** numeric changes clamp and commit once; Escape restores the draft without bubbling to cancel the editor; padded text serializes and restores its editable background settings.
- **Loading/empty/error/success behavior:** none.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** serialized Fabric object metadata stays compatible with saved editor documents.
- **Responsive and keyboard requirements:** controls expose native accessible names and preserve Escape ownership.
- **Known race/idempotency constraints:** none.
- **Source implementation:** routes/shared/image-editor/ImageEditorContextControls.tsx and image-editor-padded-text.ts.
- **Existing test(s):** ImageEditorContextControls.spec.tsx and image-editor-padded-text.spec.ts.
- **Original Echo issue/PR, if known:** [#3099](https://github.com/echoua/echo/issues/3099), [#3294](https://github.com/echoua/echo/issues/3294).

## Selection styles and reachable controls

- **Status:** issue-backed regression
- **Behavior ID:** `react-image-editor-selection-style-and-responsive-controls`
- **Affected route/component:** shared image-editor selection toolbar and drawer controls.
- **Expected observable result:** changing a standalone arrow's color, dash, or width preserves the other selected styles. Width changes recalculate dashed rectangle, ellipse, and line spacing, while solid annotations remain solid. Editor actions remain reachable at representative viewport sizes and shortcut help is available from desktop and mobile controls.
- **Source implementation:** `routes/shared/image-editor/ImageEditor.tsx` and selection-style helpers.
- **Existing test(s):** `use-image-editor-selection-style.spec.tsx`; `tests/e2e/image-editor-drawer.spec.ts`.
- **Original Echo issue/PR, if known:** [#3448](https://github.com/echoua/echo/issues/3448).
