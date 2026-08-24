# Document previews

## CSV, XLSX, and DOCX safety and compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-document-preview-parser-safety`
- **Affected route/component:** message-card CSV, XLSX, and DOCX attachment previews
- **User role or permission:** users able to view an attachment
- **Preconditions:** a supported document attachment is opened for preview
- **User action or external event:** CSV/XLSX bytes or DOCX HTML are parsed for client-side display
- **Expected observable result:** CSV supports quoted fields, newline cells, delimiter detection, UTF-8/UTF-16 BOMs, and bounded rows/columns; XLSX supports workbook/sheet/formula variations with explicit size/sheet/row/column limits; DOCX removes scripts, event handlers, and unsafe remote links.
- **Loading/empty/error/success behavior:** malformed, binary, oversized, or unsupported input is rejected; retained previews disclose truncation while preserving source dimensions.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none; these are local attachment bytes and generated document HTML.
- **Responsive and keyboard requirements:** preview limits keep documents usable without unbounded DOM growth.
- **Known race/idempotency constraints:** parsing must not expose unsanitized HTML or exceed configured resource limits.
- **Source implementation:** message-card CSV, XLSX, and DOCX preview utilities
- **Existing test(s):** `csv-preview-utils.spec.ts`, `xlsx-preview-utils.spec.ts`, `xlsx-preview-utils.fallback.spec.ts`, `sanitize-docx-html.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser and security coverage.

## Workbook metadata and copied selection

- **Status:** operational compatibility

- **Behavior ID:** `react-xlsx-preview-metadata-and-selection`
- **Affected route/component:** XLSX preview sheet navigation and copy-selection helper
- **User role or permission:** users able to preview a workbook
- **Preconditions:** a workbook supplies XML sheet metadata or the user selects displayed cells
- **User action or external event:** sheet names are parsed or the selected grid range is copied
- **Expected observable result:** XML entities and trailing whitespace in sheet names are preserved without browser DOM parsing; broken metadata produces no usable sheet names; copied cells serialize as tab-separated rows.
- **Loading/empty/error/success behavior:** invalid metadata leaves no selectable sheet metadata.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** selection copying follows the existing keyboard/copy action boundary.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `xlsx-preview-metadata.ts`, `copy-xlsx-selection.ts`
- **Existing test(s):** `xlsx-preview-metadata.spec.ts`; the isolated TSV formatting assertion was removed.
- **Original Echo issue/PR, if known:** none recorded.

## Attachment type recognition

- **Status:** inferred characterization

- **Behavior ID:** `react-document-attachment-type-recognition`
- **Affected route/component:** message-card attachment preview dispatch and download naming
- **User role or permission:** users able to view an attachment
- **Preconditions:** an attachment has MIME type, filename, or an extensionless parameterized type
- **User action or external event:** the message card determines preview support or a download filename
- **Expected observable result:** supported TXT, Markdown, CSV, XLSX, DOCX, and PDF attachments are recognized from MIME type and extension; parameterized MIME types remain usable; document collection and stable names preserve attachment identity.
- **Loading/empty/error/success behavior:** unsupported attachments do not enter the document preview collection.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** attachment metadata may have MIME parameters and incomplete filenames.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `message-card-document-utils.ts`
- **Existing test(s):** `message-card-document-utils.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational attachment parser coverage.

## Text and Markdown preview safety

- **Status:** inferred characterization

- **Behavior ID:** `react-text-document-preview-safety`
- **Affected route/component:** text and Markdown attachment previews plus the shared document response cache
- **User role or permission:** users able to view an attachment
- **Preconditions:** a text/Markdown attachment or cached response is opened
- **User action or external event:** bytes arrive with a declared charset, BOM, unsupported charset, or disguised binary payload
- **Expected observable result:** UTF-16 and Windows-1251 decode correctly; BOM wins over contradictory metadata; unsupported labels use the safe UTF-8 fallback; Markdown excludes HTML/scripts/images and unsafe links; oversized/binary/fetch failures display an error.
- **Loading/empty/error/success behavior:** cache eviction respects both entry and byte limits.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** bounded attachment previews remain usable without unbounded memory retention.
- **Known race/idempotency constraints:** cache limits prevent repeated preview loads from retaining stale responses indefinitely.
- **Source implementation:** `text-document-preview.tsx`, `document-preview-utils.ts`
- **Existing test(s):** `text-document-preview.spec.tsx`, `document-preview-utils.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as parser and resource/security safeguards.
