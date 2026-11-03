# Conversation documents

The homepage agent can create Word (.docx) documents and change them over
several turns. The main use is filling a report the user attached as a template:
the agent edits a copy of the upload, so styles, headers and footers,
numbering, tables and images stay as they were, and only the content changes.
Every save is a new version that the user can preview, download and restore in
the chat's document workspace.

## Tools

The runner registers three tools when the request's skills contain the
`documentList`, `documentSource` and `documentSave` routes, the `echodoc`
library is installed and namespace isolation works:

- `echo_document_list` lists the conversation's documents (documentId, title,
  current revision) and the .docx uploads that can serve as templates.
- `echo_document_outline {source, after?, limit?}` shows the numbered blocks of
  an upload or a document revision: paragraphs with style and text, tables with
  their size and first rows, images and content controls, plus header and
  footer text. No model-written code runs; long documents are paged with
  `after`/`nextAfter`.
- `echo_document_script {code, sources[], summary?}` runs a short Python script
  with python-docx and the [`echodoc`](template/python/echodoc/__init__.py)
  helpers on up to four sources and saves up to four documents. The helpers
  replace text across split runs, set paragraph and cell text, insert
  paragraphs formatted like existing ones, fill tables by cloning a template
  row, copy or delete block ranges and add matplotlib charts.

A document opened from a documentId source is saved as its next version with the
expected revision Echo reported; anything else becomes a new document. Echo
answers a stale revision with HTTP 409, which the tool returns to the model with
the instruction to open the document again. A lost save response is retried
once with the same idempotency key. After each save the runner emits
`document_artifact {documentId, revision}`; Echo stores it only when that
revision belongs to the running request.

The payload lists the conversation's documents (`documents`, at most 20) and,
when the user sent the message with a document open, `documentTarget`. The
system prompt tells the model to prefer the uploaded template, to fill it only
with supplied or retrieved data, to link every saved document as
`[title](echo-document:<documentId>)` and never to claim a save that the tool
did not report. For a report "like" an attached one, the template's concrete
content (callsigns, units, places, dates, figures) is only a format sample: the
model outlines the template, collects the facts with Echo tools for the
requested period across the user's groups, fills and saves the template, and
says that nothing was found only after searching. In bounded research the
document is saved before research ends, since the final synthesis has no tools.
Links to documents that are neither listed nor saved in the
request keep only their label. Failed document tools show a fixed category in
the activity list.

## Sandbox and limits

Scripts and outlines use the same isolation as map scripts
([`python-sandbox.ts`](runner/python-sandbox.ts)): separate user, network,
mount and PID namespaces, the work directory mounted at `/dev/shm` with the
library read-only at `/dev/shm/lib`, empty `/tmp`, `/var/tmp`, `/run` and
`/proc`, and a clean environment. `echosandbox.py` drops every capability and
sets resource limits before user code runs.

| Limit | Value |
| --- | --- |
| Wall clock | 60 s |
| CPU / address space | 45 s / 1.5 GiB |
| Largest file written | 48 MiB |
| Source or saved document | 32 MiB each, 64 MiB of output per script |
| Sources / saved documents per script | 4 / 4 |
| Saves per request | 16 |
| Script length | 30 000 characters |

The runner moves bytes only through two fixed routes with their own caps:
`GET /api/ai-agent/documents/ai/source` (an upload original or a document
revision, with `X-Echo-Document-Revision`) and
`POST /api/ai-agent/documents/ai/save` (the raw .docx, metadata in the query).
The JSON limits of other Echo routes are unchanged.

The work directory contains `inputs.json` (mode, prompt, retrieved messages and
file sections, the inlined text of attached files, sources), `script.py`,
`sources/<n>.docx` and `out/`. `run.py`
writes `result.json` with the saved outputs and their outlines; the runner
reads every output before deleting the directory.

## Persistence

Echo stores each revision encrypted in S3 and keeps documents per conversation
and owner, with a parent revision, origin, request and summary for every
version. Uploading validates the package (a .docx main part, no macros, no
encryption, bounded entry count and size). Documents are deleted with their
conversation. Downloads are owner-only attachments. See
[the backend document store](../wdintel-rs/src/ai_agent/documents/README.md).

## Rollout

Release `2026.11.03.1` requires migration `m20261103_120000_ai_agent_documents`
and the matching backend and frontend. Deploy the migration and Echo build,
restart the backend and workers, then upgrade each approved namespace:

```sh
just ai-control-panel upgrade --host <h> --release 2026.11.03.1 --dry-run
just ai-control-panel upgrade --host <h> --release 2026.11.03.1
```

Until the namespace is upgraded, chat requests fail with «ШІ-агент оновлюється.
Повторіть запит за кілька хвилин.». Release `2026.11.03.2` needs no migration; see
[template reports and 4-hour Deep](DEPLOYMENT.md#template-reports-and-4-hour-deep-release-2026110332).
See the
[deployment notes](DEPLOYMENT.md#conversation-documents-release-2026110331) for
verification.

## Verification

- `echo-ai-agent/runner/documents.test.ts`
- `echo-ai-agent/runner/map-script.test.ts` (shared sandbox)
- `echo-ai-agent/tests/test_echodoc.py`
- `wdintel-rs/src/ai_agent/documents/tests.rs`
- `wdintel-web/tests/e2e/ai-agent-documents.spec.ts`
