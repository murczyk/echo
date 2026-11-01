# AI chat uploads

Users can attach documents and images to a message in the main-page AI chat.
Each upload belongs to one conversation and its owner. The agent can use it in
the turn it was sent with and in every later turn of that conversation.

## Lifecycle

1. `POST /api/ai-agent/uploads/create` (multipart: `file`, optional
   `conversationId`) checks:
   - the extension, and the file signature against that extension
     (`formats.rs`);
   - the size limit;
   - the draft and per-conversation limits.

   It then stores the original encrypted in S3 (`store_asset`) and creates a
   draft `ai_agent_upload` row with `request_id = null`. For images it also
   stores a downscaled JPEG preview (`image.rs`).
2. `POST /api/ai-agent/requests/create` with `uploadIds` binds the drafts to the
   new request inside the request transaction (`bind_to_request`). Uploads that
   are foreign, already sent, or from another conversation reject the whole
   request.
3. The upload worker (`worker.rs`) claims rows in state `uploaded` or
   `extracting` using a lease.
   - Plain text, Markdown, CSV and JSON are decoded (UTF-16 with a BOM, UTF-8,
     then Windows-1251, like the extractor) and chunked in-process; over-long
     lines are split. Binary content fails the upload.
   - Everything else goes to the native path of `echo-document-extractor`
     (`attachment_native: true`), which converts Office files, unpacks archives
     and OCRs PDFs and images. WebP is converted to PNG first.
   - Chunks land in `ai_agent_upload_chunk`, which has a Russian-configuration
     `tsvector` and a trigram index.
   - A busy extractor (429, 503 or 507) does not count as a failure. Real errors
     retry with backoff, and the upload fails after five attempts or one hour.
4. Before dispatching a request, the agent worker waits for that request's
   uploads to finish extracting and shows "Обробляю вкладені файли". The wait
   lasts up to 180 s, or a quarter of a reasoning preset's runtime, because the
   preset deadline already runs during it.
   It then adds the following to the runner payload:
   - `uploads`: every upload sent so far in the conversation, never uploads
     from later queued messages. Full text is inlined while the total stays
     under 20 000 characters; the current message's files go first.
   - `turnImages` and `visionInput`: only when the engine runtime profile has
     `vision_input_enabled`. The runner fetches up to four previews and passes
     them as image content of the prompt.

   Earlier user turns in the history get an `[Attached files: …]` prefix.
5. Cleanup runs every five minutes. It removes uploads of deleted conversations
   and drafts older than 24 h, including their S3 objects. Draft deletion
   (cleanup or the composer's remove button) is one conditional `DELETE`, so a
   draft bound by a concurrent send is never removed.

## Agent tools

These are read-only routes in `agent_api.rs`, allow-listed in `route_registry.rs`.
Each one resolves the running request of the calling agent session and only
exposes uploads sent with that request or earlier ones in its conversation, the
same cutoff as the runner payload.

| Skill | Route |
|---|---|
| `upload_list` | `/api/ai-agent/uploads/ai/list` |
| `upload_read` | `/api/ai-agent/uploads/ai/read`: bounded sections, `after`/`nextAfter`, literal `query` |
| `upload_search` | `/api/ai-agent/uploads/ai/search`: FTS plus ILIKE with snippets |
| `upload_image` | `/api/ai-agent/uploads/ai/image`: preview JPEG; registered only for vision engines |

Upload skills are only sent to the runner when the conversation has uploads.

## Vision

An admin enables vision per engine in AI agent settings, under the runtime
profile option "Модель приймає зображення". The Echo provider gateway accepts
image parts only as `data:image/(jpeg|png|webp);base64` URLs, and only for
engines with that flag. Remote image URLs are always rejected.

## Limits

The limits are the `AI_AGENT_UPLOAD_*` constants in `config.rs`:

- 50 MiB per file;
- 10 files per message;
- 50 files per conversation;
- 20 unsent drafts per user;
- previews of at most 1568 px and 350 KiB, up to 4 per turn.

The front end mirrors the file and format limits in
`wdintel-web/src/ts/react/routes/ai-agent-chat/composer-attachments.ts`.

## Downloads

`GET /api/ai-agent/uploads/{id}/original` is owner-only. PNG, JPEG, WebP and PDF
render inline. Every other format downloads as `application/octet-stream` with
`Content-Security-Policy: sandbox` and `nosniff`, so uploaded HTML never runs on
the Echo origin.
