import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { SELECTED_GROUPS_DESCRIPTION } from './search-guidance.ts';

const id = Type.String({ minLength: 36, maxLength: 36, pattern: '^[0-9a-f-]{36}$' });
const text = Type.String({ maxLength: 1000 });
export const ATTACHMENT_ROUTES: Record<string, { kind: string; path: string }> = {
  attachment_search: { kind: 'attachmentSearch', path: '/api/attachments/search' },
  attachment_get: { kind: 'attachmentRead', path: '/api/attachments/get' },
  attachment_read: { kind: 'attachmentRead', path: '/api/attachments/read' },
  attachment_inspect: { kind: 'attachmentInspect', path: '/api/attachments/inspect-original' },
  attachment_inspection_status: { kind: 'attachmentStatus', path: '/api/attachments/inspection-status' },
};
export const ATTACHMENT_PARAMETERS = {
  attachmentSearch: Type.Object({
    query: Type.Optional(text), selectedGroups: Type.Optional(Type.Array(text, { maxItems: 128, description: SELECTED_GROUPS_DESCRIPTION })),
    messageIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100 })),
    from: Type.Optional(Type.Number({ description: 'Inclusive UTC epoch milliseconds; omit for all history.' })),
    to: Type.Optional(Type.Number({ description: 'Inclusive UTC epoch milliseconds.' })),
    format: Type.Optional(Type.String({ maxLength: 20 })), cursor: Type.Optional(id),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }, { additionalProperties: false }),
  attachmentRead: Type.Object({ mediaId: id, revision: Type.Optional(id), member: Type.Optional(text),
    after: Type.Optional(Type.Integer({ minimum: -1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    query: Type.Optional(text),
  }, { additionalProperties: false }),
  attachmentInspect: Type.Object({ mediaId: id, member: Type.Optional(text),
    operation: Type.Union(['table', 'page', 'ocr', 'image'].map((value) => Type.Literal(value))),
    locator: Type.Optional(text),
  }, { additionalProperties: false }),
  attachmentStatus: Type.Object({ id }, { additionalProperties: false }),
};
export const ATTACHMENT_DESCRIPTION: Record<string, string> = {
  attachmentSearch: 'Search authorized message attachment filenames, archive members, full document/OCR text and summaries. Searches all retained history unless from/to are supplied; preserve explicit or inherited date/group scope. Follow nextCursor. Processing states disclose incomplete indexing.',
  attachmentRead: 'Read attachment summary, extraction coverage, and bounded source sections. Use mediaId from another tool. Follow nextAfter using after, preserving revision. member selects an exact archive member; query selects literal source text or a table/sheet/page locator. Cite document.citation and identify the filename and source locator.',
  attachmentInspect: 'Inspect an authorized original with a focused table, page, OCR or image operation. Use when indexed text is incomplete or original layout matters. Returns an asynchronous job; poll attachment_inspection_status. No shell, URLs or arbitrary file access.',
  attachmentStatus: 'Read the result or progress of a previously requested original inspection.',
};

export function attachmentRequest(kind: string, params: Record<string, unknown>): Record<string, unknown> {
  const schema = ATTACHMENT_PARAMETERS[kind as keyof typeof ATTACHMENT_PARAMETERS];
  if (!schema) throw new Error('Unknown attachment request');
  if (!Check(schema, params)) throw new Error('Invalid attachment parameters');
  return params;
}

/**
 * An attachment search hit as the model sees it: `text` (the summary) and the citation
 * stay, the duplicate `summary` and default states are omitted (#4224).
 */
export function projectAttachmentSearchHit(document: Record<string, any>, summaryLimit: number, snippetLimit: number): Record<string, unknown> {
  const completed = document.state === 'completed';
  const cap = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
  return {
    mediaId: document.mediaId,
    messageId: document.messageId,
    fileName: document.fileName,
    ...(document.revision ? { revision: document.revision } : {}),
    ...(completed ? {} : { state: document.state }),
    ...(completed && document.complete === false ? { complete: false } : {}),
    ...(completed && typeof document.summaryState === 'string' && !['completed', 'skipped'].includes(document.summaryState) ? { summaryState: document.summaryState } : {}),
    ...(document.quality ? { quality: document.quality } : {}),
    ...(document.lastError ? { lastError: document.lastError } : {}),
    text: cap(typeof document.text === 'string' ? document.text : String(document.fileName ?? ''), summaryLimit),
    ...(typeof document.snippet === 'string' && document.snippet ? { snippet: cap(document.snippet, snippetLimit) } : {}),
    citation: document.citation,
  };
}
