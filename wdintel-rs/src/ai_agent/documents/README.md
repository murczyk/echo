# AI chat documents

Word documents the agent creates in a conversation, usually by filling a .docx
report the user attached as a template. Each document belongs to one
conversation and its owner and has numbered revisions. The agent tools and the
sandbox that produce the files are described in
[`echo-ai-agent/DOCUMENTS.md`](../../../../echo-ai-agent/DOCUMENTS.md).

## Storage

- `ai_agent_document`: conversation, owner, the request that created it, an
  optional source upload, title, download file name and the head revision.
- `ai_agent_document_revision`: one encrypted S3 object per revision
  (`store_asset`), its size and SHA-256, the parent revision, origin (`agent`;
  `user` is reserved), the saving request, a summary, and the idempotency key
  with the stored response.
- `ai_agent_request_document_target`: the document the user had open when
  sending a message, validated to belong to the same conversation.

The upload worker's cleanup also deletes documents of deleted conversations and
their S3 objects (`revisions::cleanup`). The tables are excluded from analytics.

## Agent routes

Allow-listed in `route_registry.rs`; each resolves the running request of the
agent session (`agent_api.rs`).

| Route | Purpose |
|---|---|
| `POST /api/ai-agent/documents/ai/list` | The conversation's documents and the .docx uploads visible to the request |
| `GET /api/ai-agent/documents/ai/source?uploadId=` or `?documentId=&revision=` | Original bytes; `X-Echo-Document-Revision` names the served revision |
| `POST /api/ai-agent/documents/ai/save?idempotencyKey=…` | Raw .docx body; a new document (`title`) or the next revision of a conversation document (`documentId`, `expectedRevision`) |

A save is checked before anything is stored (`validate.rs`): a zip of at most
1 000 entries and 256 MiB uncompressed, safe paths, no encryption, no
`vbaProject.bin`, and exactly one main part of the plain Word document content
type (macro-enabled and template main parts are rejected). A repeated
idempotency key returns the stored result. A stale `expectedRevision` returns
HTTP 409 with `currentRevision`. New revisions get the next free number and the
current head as parent, so saving after an undo starts a branch.

After a save the runner emits `document_artifact {documentId, revision}`. The
event is stored only when that revision was saved by the same request, with the
canonical `{document: {documentId, revision, title, fileName, sizeBytes}}`
payload. Conversation responses list these as the assistant message's
`documents`. Earlier turns in the runner history end with a `[Saved documents: …]`
note, and the payload carries `documents` and `documentTarget`.

## Human routes

Owner-only and limited to non-deleted conversations (`api.rs`):

- `POST /api/ai-agent/documents/list {conversationId}`
- `POST /api/ai-agent/documents/workspace {documentId}`: the document, its
  revisions (newest first) and the undo and redo revisions
- `POST /api/ai-agent/documents/head {documentId, expectedRevision, revision}`:
  restore, undo or redo; 409 when the head moved
- `GET /api/ai-agent/documents/{id}/revisions/{revision}/file`: an
  `application/octet-stream` attachment with `nosniff`, `CSP: sandbox` and
  `private, no-store`

## Limits

The `AI_AGENT_DOCUMENT_*` constants in `config.rs`: 32 MiB per file, 20 documents
per conversation, 100 revisions per document and 16 saves per request.
