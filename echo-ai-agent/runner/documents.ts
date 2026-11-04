import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileSection } from "./devices.ts";
import type { ScriptMessage } from "./map-script.ts";
import { normalizeToolArguments } from "./maps.ts";
import { createPythonSandbox, isolationAvailable, PYTHON_ROOT } from "./python-sandbox.ts";

// Word documents the agent creates or edits for the user, see DOCUMENTS.md.
export const DOCUMENT_LIST_PATH = "/api/ai-agent/documents/ai/list";
export const DOCUMENT_SOURCE_PATH = "/api/ai-agent/documents/ai/source";
export const DOCUMENT_SAVE_PATH = "/api/ai-agent/documents/ai/save";
export const DOCUMENT_ROUTES: Record<string, { kind: string; path: string; method: "GET" | "POST" }> = {
  document_list: { kind: "documentList", path: DOCUMENT_LIST_PATH, method: "POST" },
  document_source: { kind: "documentSource", path: DOCUMENT_SOURCE_PATH, method: "GET" },
  document_save: { kind: "documentSave", path: DOCUMENT_SAVE_PATH, method: "POST" },
};
export const DOCUMENT_KINDS = new Set(Object.values(DOCUMENT_ROUTES).map((route) => route.kind));
export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;
const OUTPUT_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
const DOCUMENT_LIMIT = 20;
const SOURCE_LIMIT = 4;
const OUTPUT_LIMIT = 4;
const SAVE_LIMIT = 16;
const CODE_LIMIT = 30_000;
const OUTPUT_TAIL = 4_000;
const OUTLINE_TEXT_LIMIT = 24_000;
const OUTLINE_LIMIT = 200;
const SCRIPT_TIMEOUT_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OUTPUT_PATH = /^out\/[A-Za-z0-9._-]{1,80}\.docx$/;

export interface DocumentSummary {
  documentId: string;
  title: string;
  fileName: string;
  headRevision: number;
  sizeBytes: number;
  updatedAt: string;
  sourceUploadId: string | null;
}

export interface DocumentTarget {
  documentId: string;
  revision: number;
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${field} is invalid`);
  return value;
}

function positive(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${field} is invalid`);
  return value as number;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field} must be a UUID`);
  return value;
}

export function validateDocuments(value: unknown): DocumentSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DOCUMENT_LIMIT) throw new Error("documents must contain at most 20 entries");
  const documents = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("document must be an object");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["documentId", "title", "fileName", "headRevision", "sizeBytes", "updatedAt", "sourceUploadId"].includes(key)))
      throw new Error("document contains an unsupported field");
    return {
      documentId: uuid(item.documentId, "document.documentId"),
      title: text(item.title, "document.title", 500),
      fileName: text(item.fileName, "document.fileName", 255),
      headRevision: positive(item.headRevision, "document.headRevision"),
      sizeBytes: positive(item.sizeBytes, "document.sizeBytes", 0),
      updatedAt: text(item.updatedAt, "document.updatedAt", 64),
      sourceUploadId: item.sourceUploadId == null ? null : uuid(item.sourceUploadId, "document.sourceUploadId"),
    };
  });
  if (new Set(documents.map((document) => document.documentId)).size !== documents.length) throw new Error("documents must be unique");
  return documents;
}

export function validateDocumentTarget(value: unknown): DocumentTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("documentTarget must be an object");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["documentId", "revision"].includes(key))) throw new Error("documentTarget contains an unsupported field");
  return { documentId: uuid(item.documentId, "documentTarget.documentId"), revision: positive(item.revision, "documentTarget.revision") };
}

/** Documents known in this request: listed by Echo or saved by a tool call. */
export class DocumentRegistry {
  private documents = new Map<string, { title: string; fileName: string; headRevision: number }>();
  readonly saved = new Map<string, { title: string; revision: number }>();
  saves = 0;
  readonly target?: DocumentTarget;

  constructor(documents: DocumentSummary[] = [], target?: DocumentTarget) {
    this.target = target;
    for (const document of documents) this.remember(document.documentId, document.title, document.fileName, document.headRevision);
    if (target && !this.knows(target.documentId)) this.remember(target.documentId, "Документ", "document.docx", target.revision);
  }

  remember(documentId: string, title: string, fileName: string, headRevision: number) {
    this.documents.set(documentId.toLowerCase(), { title, fileName, headRevision });
  }

  get(documentId: string) { return this.documents.get(documentId.toLowerCase()); }

  knows(documentId: string) { return this.documents.has(documentId.toLowerCase()); }

  /** Registered `echo-document:` link targets. */
  links() { return [...this.documents.keys()].map((id) => `echo-document:${id}`); }

  recordSave(saved: { documentId: string; revision: number; title: string; fileName: string }) {
    this.saves += 1;
    this.remember(saved.documentId, saved.title, saved.fileName, saved.revision);
    this.saved.set(saved.documentId.toLowerCase(), { title: saved.title, revision: saved.revision });
  }
}

export function documentLink(title: string, documentId: string): string {
  return `[${title.replace(/[[\]\n]/g, " ").trim() || "Документ"}](echo-document:${documentId})`;
}

/** Keeps the label of a link to a document that is neither listed nor saved. */
export function stripUnknownDocumentLinks(answer: string, registry: DocumentRegistry): string {
  return answer.replace(/\[([^\]\n]*)\]\(echo-document:([^)\s]*)\)/gi,
    (link, label: string, id: string) => UUID.test(id) && registry.knows(id) ? link : label);
}

// Failed document tools report a fixed category, never the raw error.
const DOCUMENT_TOOL_ERRORS: Array<[RegExp, string]> = [
  [/HTTP 409|змінився/i, "Документ змінився; потрібно відкрити його знову"],
  [/Script failed|Traceback|скрипт/i, "Скрипт документа завершився помилкою"],
  [/too large|завеликий|limit/i, "Документ завеликий або досягнуто ліміту"],
  [/HTTP 404|not found|не знайдено|Unknown document/i, "Документ не знайдено"],
  [/must|invalid|Validation|argument/i, "Некоректні параметри документа"],
];

export function documentToolErrorSummary(text: string): string {
  return DOCUMENT_TOOL_ERRORS.find(([pattern]) => pattern.test(text))?.[1] ?? "Не вдалося обробити документ";
}

export interface DocumentSourceInput {
  index: number;
  path: string;
  kind: "upload" | "document";
  uploadId: string | null;
  documentId: string | null;
  revision: number | null;
  title: string;
  fileName: string;
}

export interface DocumentInputs {
  mode: "script" | "outline";
  prompt: string;
  messages: ScriptMessage[];
  files: FileSection[];
  /** Full text of attached files that the payload inlined. */
  uploads: Array<{ uploadId: string; fileName: string; text: string }>;
  sources: DocumentSourceInput[];
  outline?: { source: number; after: number; limit: number };
  maxOutputs: number;
}

export interface DocumentOutput {
  path: string;
  source: number | null;
  documentId: string | null;
  title: string | null;
  fileName: string | null;
  summary: string | null;
  outline: string;
}

export interface DocumentScriptResult {
  outputs: DocumentOutput[];
  outline: { text: string; total: number; nextAfter: number | null } | null;
  logs: string[];
}

export interface DocumentRunOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  result: DocumentScriptResult | null;
  /** Output bytes by path, read before the work directory is removed. */
  files: Map<string, Uint8Array>;
}

export type DocumentScriptRunner = (inputs: DocumentInputs, code: string | null, sources: Uint8Array[], signal?: AbortSignal) => Promise<DocumentRunOutcome>;

function optionalText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

export function validDocumentResult(value: unknown, mode: DocumentInputs["mode"]): DocumentScriptResult {
  const result = value as Record<string, any>;
  if (!result || typeof result !== "object" || !Array.isArray(result.logs)) throw new Error("Script produced an invalid result");
  const outputs = Array.isArray(result.outputs) ? result.outputs : [];
  if (mode === "outline" ? outputs.length : outputs.length > OUTPUT_LIMIT) throw new Error(`A script may save at most ${OUTPUT_LIMIT} documents`);
  const paths = new Set<string>();
  const validated = outputs.map((output: any): DocumentOutput => {
    if (!output || typeof output.path !== "string" || !OUTPUT_PATH.test(output.path) || paths.has(output.path)) throw new Error("Script produced an invalid output path");
    paths.add(output.path);
    if (output.documentId != null && (typeof output.documentId !== "string" || !UUID.test(output.documentId))) throw new Error("Script produced an invalid documentId");
    return {
      path: output.path,
      source: Number.isSafeInteger(output.source) && output.source > 0 ? output.source : null,
      documentId: output.documentId ?? null,
      title: optionalText(output.title, 200),
      fileName: optionalText(output.fileName, 200),
      summary: optionalText(output.summary, 500),
      outline: typeof output.outline === "string" ? output.outline.slice(0, 8_000) : "",
    };
  });
  const outline = result.outline && typeof result.outline.text === "string"
    ? {
        text: result.outline.text,
        total: Number.isSafeInteger(result.outline.total) ? result.outline.total : 0,
        nextAfter: Number.isSafeInteger(result.outline.nextAfter) ? result.outline.nextAfter : null,
      }
    : null;
  if (mode === "outline" && !outline) throw new Error("Script produced no outline");
  return { outputs: validated, outline, logs: result.logs.filter((line: unknown): line is string => typeof line === "string").slice(0, 200) };
}

async function readOutputs(work: string, result: DocumentScriptResult): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const output of result.outputs) {
    const path = join(work, output.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Script did not write ${output.path}`);
    if (info.size > DOCUMENT_MAX_BYTES) throw new Error("Saved document is too large (over 32 MiB)");
    total += info.size;
    if (total > OUTPUT_TOTAL_MAX_BYTES) throw new Error("Saved documents are too large together (over 64 MiB)");
    files.set(output.path, new Uint8Array(await readFile(path)));
  }
  return files;
}

/** Returns undefined (no document tools) unless python-docx's helper library
 * is installed and namespace isolation works. */
export function createDocumentScriptRunner(root = PYTHON_ROOT, isolate = isolationAvailable): DocumentScriptRunner | undefined {
  const sandbox = createPythonSandbox({ root, entry: "echodoc/run.py", name: "echo-document-script", timeoutMs: SCRIPT_TIMEOUT_MS, isolate });
  if (!sandbox) return undefined;
  return async (inputs, code, sources, signal) => {
    let files = new Map<string, Uint8Array>();
    const outcome = await sandbox(
      async (work) => {
        await mkdir(join(work, "sources"));
        await mkdir(join(work, "out"));
        for (const source of inputs.sources) await writeFile(join(work, source.path), sources[source.index - 1]);
        await writeFile(join(work, "inputs.json"), JSON.stringify(inputs));
        if (code !== null) await writeFile(join(work, "script.py"), code);
      },
      async (work, outcome) => {
        const resultPath = join(work, "result.json");
        if (outcome.status !== 0 || !existsSync(resultPath)) return null;
        const result = validDocumentResult(JSON.parse(await readFile(resultPath, "utf8")), inputs.mode);
        files = await readOutputs(work, result);
        return result;
      },
      signal,
    );
    return { ...outcome, files };
  };
}

export interface DocumentTransport {
  list(signal?: AbortSignal): Promise<unknown>;
  download(query: Record<string, string>, signal?: AbortSignal): Promise<{ bytes: Uint8Array; revision: number | null }>;
  upload(query: Record<string, string>, bytes: Uint8Array, signal?: AbortSignal): Promise<unknown>;
}

export interface DocumentScriptContext {
  prompt: string;
  messages: () => ScriptMessage[];
  files?: () => FileSection[];
  uploads?: () => DocumentInputs["uploads"];
  uploadName: (uploadId: string) => string | undefined;
}

interface SourceRequest { uploadId?: string; documentId?: string; revision?: number }

interface SavedDocument { documentId: string; revision: number; title: string; fileName: string; sizeBytes: number; created: boolean }

type Emit = (event: Record<string, unknown>) => void;

function tail(value: string, limit = OUTPUT_TAIL): string {
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function isHttpError(error: unknown): boolean {
  return error instanceof Error && /^Echo returned HTTP \d{3}/.test(error.message);
}

function validSaved(value: unknown): SavedDocument {
  const body = value as Record<string, unknown>;
  if (!body || typeof body.documentId !== "string" || !UUID.test(body.documentId) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1)
    throw new Error("Incomplete document save response");
  return {
    documentId: body.documentId,
    revision: body.revision as number,
    title: typeof body.title === "string" ? body.title : "Документ",
    fileName: typeof body.fileName === "string" ? body.fileName : "document.docx",
    sizeBytes: Number(body.sizeBytes) || 0,
    created: body.created === true,
  };
}

const sourceSchema = Type.Object({
  uploadId: Type.Optional(Type.String({ pattern: UUID.source, description: "A .docx file the user attached (uploadId)." })),
  documentId: Type.Optional(Type.String({ pattern: UUID.source, description: "A document of this conversation (documentId)." })),
  revision: Type.Optional(Type.Integer({ minimum: 1, description: "An older version of the document; omit for the current one." })),
});

const ECHODOC_API = `Library (python-docx is available as docx): import echodoc
- echodoc.sources -> list of dicts for the sources in the order given: index (1-based), kind ("upload" | "document"), uploadId, documentId, revision, title, fileName.
- echodoc.open(source=None) -> docx.Document; source is the index, an uploadId/documentId or a file name; omit it when there is one source. echodoc.blank() -> a new empty document.
- echodoc.outline(doc, after=0, limit=80)["text"] -> numbered blocks, the same numbering as echo_document_outline; echodoc.block(doc, i) -> the Paragraph or Table at block i; echodoc.find(doc, text) -> indices of blocks containing text.
- echodoc.replace_text(doc, old, new, headers=True) -> count; works across split runs and in tables, headers and footers, keeping the formatting where the match starts.
- echodoc.set_text(paragraph_or_cell, text) keeps paragraph and first-run formatting ("\\n" is a line break, "\\t" a tab; a cell keeps only its first paragraph); echodoc.insert_paragraph_after(paragraph, text, like=None) -> the new paragraph, formatted like \`like\` (default: the paragraph itself).
- echodoc.fill_table(table, rows, header_rows=1, template_row=None, footer_rows=0) replaces the data rows with \`rows\` (lists of cell values), cloning the template row's formatting; footer_rows keeps totals rows at the end.
- echodoc.copy_blocks(doc, start, end, after) duplicates blocks start..end after block \`after\` (-1 = at the start); echodoc.delete_blocks(doc, start, end).
- fig, ax = echodoc.figure(width_cm=16, height_cm=9) gives a matplotlib figure and axes; echodoc.add_chart(paragraph, fig, width_cm=16) inserts it as an image.
- echodoc.inputs["prompt"], ["messages"] and ["files"] hold the user's prompt and the Echo messages and file sections retrieved in this request; echodoc.inputs["uploads"] lists {uploadId, fileName, text} of attached files whose full text fits the context (parse data from it instead of retyping it); echodoc.log(...) and print() output is returned.
- echodoc.save(doc, title=None, file_name=None, summary=None, as_new=False): a document opened from a documentId source is saved as its new version; anything else (an upload, blank(), or as_new=True) becomes a new document titled \`title\`; pass title/file_name with a new version to rename it. Save each document once, at most ${OUTPUT_LIMIT} per script.`;

const SCRIPT_EXAMPLE = `Example (fill an uploaded report template with new data):
import echodoc
doc = echodoc.open(1)
echodoc.replace_text(doc, "вересень 2026", "жовтень 2026")
table = echodoc.block(doc, 7)
echodoc.fill_table(table, [["01.10", "Подія А", 3], ["02.10", "Подія Б", 5]])
echodoc.set_text(echodoc.block(doc, 9), "Висновок: активність зросла.")
echodoc.save(doc, title="Звіт за жовтень 2026", summary="Дані за жовтень")`;

const SCRIPT_DESCRIPTION = `Create or change Word (.docx) documents with a short Python 3 script that uses python-docx and the echodoc helpers. It runs without network access. Pass up to ${SOURCE_LIMIT} sources (uploaded .docx templates by uploadId, or documents of this conversation by documentId); call echo_document_outline first to learn their block numbers. Edit a copy of the user's template rather than building a new document, so styles, headers, numbering, tables and images stay intact. Each saved document becomes a version the user can preview, download and undo. If the script fails, read the traceback, fix the script and retry.
${ECHODOC_API}
${SCRIPT_EXAMPLE}`;

/** The tools the agent uses to read, create and update Word documents. */
export function createDocumentTools(registry: DocumentRegistry, transport: DocumentTransport, run: DocumentScriptRunner,
  context: DocumentScriptContext, emit: Emit, countInvocation: () => void) {
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any, signal?: AbortSignal) => Promise<string>) => defineTool({
    name, label, description, parameters, executionMode: "sequential",
    prepareArguments: (args: unknown) => normalizeToolArguments(args) as any,
    execute: async (_id, params, signal) => {
      countInvocation();
      signal?.throwIfAborted();
      const result = await execute(params, signal);
      return { content: [{ type: "text", text: result }], details: { activityLabel: label } };
    },
  });

  async function loadSources(requests: SourceRequest[], signal?: AbortSignal) {
    if (!Array.isArray(requests) || !requests.length || requests.length > SOURCE_LIMIT) throw new Error(`Pass 1–${SOURCE_LIMIT} sources`);
    const inputs: DocumentSourceInput[] = [];
    const bytes: Uint8Array[] = [];
    for (const request of requests) {
      signal?.throwIfAborted();
      if (!request || typeof request !== "object" || Boolean(request.uploadId) === Boolean(request.documentId))
        throw new Error("Each source must have either uploadId or documentId");
      if (request.uploadId && request.revision !== undefined) throw new Error("revision applies only to documentId sources");
      const index = inputs.length + 1;
      const query: Record<string, string> = request.uploadId
        ? { uploadId: uuid(request.uploadId, "uploadId") }
        : { documentId: uuid(request.documentId, "documentId"), ...(request.revision !== undefined ? { revision: String(positive(request.revision, "revision")) } : {}) };
      const loaded = await transport.download(query, signal);
      if (loaded.bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error("Document is too large (over 32 MiB)");
      if (request.documentId) {
        const known = registry.get(request.documentId);
        const revision = loaded.revision ?? request.revision ?? known?.headRevision ?? null;
        // A current-version download reports the head; keep it for the save.
        if (known && request.revision === undefined && revision !== null) registry.remember(request.documentId, known.title, known.fileName, revision);
        inputs.push({ index, path: `sources/${index}.docx`, kind: "document", uploadId: null, documentId: request.documentId, revision,
          title: known?.title ?? "Документ", fileName: known?.fileName ?? "document.docx" });
      } else {
        const fileName = context.uploadName(request.uploadId!) ?? "template.docx";
        inputs.push({ index, path: `sources/${index}.docx`, kind: "upload", uploadId: request.uploadId!, documentId: null, revision: null,
          title: fileName.replace(/\.docx$/i, ""), fileName });
      }
      bytes.push(loaded.bytes);
    }
    return { inputs, bytes };
  }

  function scriptInputs(mode: DocumentInputs["mode"], sources: DocumentSourceInput[], outline?: DocumentInputs["outline"]): DocumentInputs {
    return { mode, prompt: context.prompt, messages: context.messages(), files: context.files?.() ?? [], uploads: context.uploads?.() ?? [], sources, ...(outline ? { outline } : {}), maxOutputs: OUTPUT_LIMIT };
  }

  async function upload(query: Record<string, string>, bytes: Uint8Array, signal?: AbortSignal): Promise<SavedDocument> {
    try {
      return validSaved(await transport.upload(query, bytes, signal));
    } catch (error) {
      // One retry with the same idempotency key after a lost response.
      if (isHttpError(error) || signal?.aborted) throw error;
      return validSaved(await transport.upload(query, bytes, signal));
    }
  }

  async function save(output: DocumentOutput, bytes: Uint8Array, sources: DocumentSourceInput[], revisionSummary: string | null, signal?: AbortSignal) {
    if (registry.saves >= SAVE_LIMIT) throw new Error(`Document save limit reached (${SAVE_LIMIT} per request)`);
    const source = output.source ? sources[output.source - 1] : undefined;
    const query: Record<string, string> = { idempotencyKey: randomUUID() };
    const summary = output.summary ?? revisionSummary;
    if (summary) query.summary = summary;
    if (output.documentId) {
      if (source?.documentId?.toLowerCase() !== output.documentId.toLowerCase()) throw new Error("Only a document opened as a source can be saved as its new version");
      const expected = registry.get(output.documentId)?.headRevision ?? source.revision;
      if (!expected) throw new Error("Unknown document revision; open the document again");
      query.documentId = output.documentId;
      query.expectedRevision = String(expected);
    } else {
      if (source?.uploadId) query.sourceUploadId = source.uploadId;
      if (source?.documentId) query.sourceDocumentId = source.documentId;
    }
    // A new version keeps its document's title and file name unless the script renames it.
    const title = output.title ?? (output.documentId ? null : source?.title ?? "Документ");
    if (title) query.title = title.slice(0, 200);
    if (output.fileName) query.fileName = output.fileName;
    const saved = await upload(query, bytes, signal);
    registry.recordSave(saved);
    emit({ type: "document_artifact", documentId: saved.documentId, revision: saved.revision });
    return saved;
  }

  function savedText(saved: SavedDocument, output: DocumentOutput) {
    const action = saved.created ? "new document" : `version ${saved.revision}`;
    return [`- ${documentLink(saved.title, saved.documentId)} — saved (${action}, revision ${saved.revision}, ${saved.fileName})`,
      ...(output.outline ? [`  First blocks:\n${output.outline.split("\n").map((line) => `  ${line}`).join("\n")}`] : [])].join("\n");
  }

  return [
    tool("echo_document_list", "Переглядаю документи розмови",
      "List the Word documents of this conversation (documentId, title, current revision) and the .docx files the user attached that can serve as templates (uploadId).",
      Type.Object({}),
      async (_params, signal) => {
        const body = await transport.list(signal) as { documents?: unknown };
        const documents = Array.isArray(body?.documents) ? validateDocuments(body.documents.slice(0, DOCUMENT_LIMIT)) : [];
        for (const document of documents) registry.remember(document.documentId, document.title, document.fileName, document.headRevision);
        return JSON.stringify(body);
      }),
    tool("echo_document_outline", "Читаю структуру документа",
      "Show the numbered blocks of a .docx: paragraphs with their style and text, tables with their size and first rows, images, and header/footer text. Use the block numbers with echodoc.block() in echo_document_script. Follow nextAfter with after for long documents.",
      Type.Object({
        source: sourceSchema,
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OUTLINE_LIMIT })),
      }),
      async ({ source, after = 0, limit = 80 }, signal) => {
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > OUTLINE_LIMIT) throw new Error("Invalid outline window");
        const loaded = await loadSources([source], signal);
        const outcome = await run(scriptInputs("outline", loaded.inputs, { source: 1, after, limit }), null, loaded.bytes, signal);
        if (outcome.status !== 0 || !outcome.result?.outline) throw new Error(`Не вдалося прочитати документ. ${tail(outcome.stderr, 600)}`);
        const { text, total, nextAfter } = outcome.result.outline;
        const header = `${loaded.inputs[0].title} (${loaded.inputs[0].fileName}${loaded.inputs[0].revision ? `, revision ${loaded.inputs[0].revision}` : ""}): ${total} blocks`;
        return [header, tail(text, OUTLINE_TEXT_LIMIT), nextAfter !== null ? `nextAfter: ${nextAfter}` : ""].filter(Boolean).join("\n");
      }),
    tool("echo_document_script", "Готую документ", SCRIPT_DESCRIPTION,
      Type.Object({
        code: Type.String({ minLength: 1, maxLength: CODE_LIMIT }),
        sources: Type.Optional(Type.Array(sourceSchema, { maxItems: SOURCE_LIMIT })),
        summary: Type.Optional(Type.String({ maxLength: 500, description: "Short Ukrainian description of the change for the version history." })),
      }),
      async ({ code, sources = [], summary }, signal) => {
        const loaded = sources.length ? await loadSources(sources, signal) : { inputs: [], bytes: [] };
        const outcome = await run(scriptInputs("script", loaded.inputs), code, loaded.bytes, signal);
        if (outcome.status !== 0 || !outcome.result) throw new Error(`Script failed (exit ${outcome.status}). Fix it and retry.\n${tail(outcome.stderr)}`);
        const lines: string[] = [];
        for (const output of outcome.result.outputs) {
          const bytes = outcome.files.get(output.path);
          if (!bytes) throw new Error(`Script did not write ${output.path}`);
          try {
            lines.push(savedText(await save(output, bytes, loaded.inputs, optionalText(summary, 500), signal), output));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const hint = /HTTP 409/.test(message) ? " The document has changed since it was opened; open it again (echo_document_outline) and repeat the script." : "";
            throw new Error([`Saving ${output.title ?? output.path} failed: ${message}.${hint}`, ...(lines.length ? ["Already saved:", ...lines] : [])].join("\n"));
          }
        }
        return [
          lines.length ? `Saved documents (link them in the answer exactly like this):\n${lines.join("\n")}` : "No document was saved; call echodoc.save(doc, ...) to save one.",
          ...(outcome.result.logs.length ? [`Logs:\n${tail(outcome.result.logs.join("\n"))}`] : []),
          ...(outcome.stdout.trim() ? [`Output:\n${tail(outcome.stdout)}`] : []),
        ].join("\n\n");
      }),
  ];
}

export function documentGuidance(registry: DocumentRegistry, documents: DocumentSummary[]): string {
  const listed = documents.slice(0, DOCUMENT_LIMIT).map((document) =>
    `- ${JSON.stringify(document.title)} (${document.fileName}, documentId ${document.documentId}, revision ${document.headRevision})`);
  const target = registry.target ? documents.find((document) => document.documentId === registry.target!.documentId) : undefined;
  return [
    "The user can ask you to create or update Word (.docx) documents. Read a document's structure with echo_document_outline and create or change documents with echo_document_script (python-docx with the echodoc helpers). When the user supplies a .docx report as a template or example, open that upload as a source and edit it so its styles, headers, numbering, tables and images stay intact; build a document from scratch only when there is no template. Fill it only with data from the user's message, Echo tools and files the user names as data; never invent figures. To change an existing document, open it by documentId and save it; this creates a new version the user can undo. If the user names no other document, a change request refers to the open document, otherwise to the latest one.",
    "A report like a template (\"аналогічний\", \"за зразком\", \"як шаблон\") is a new report about new data: 1. Read the template with echo_document_outline. 2. Its concrete content (callsigns, units, places, coordinates, dates, figures, names) is sample content that only shows the format and what kind of fact goes in each section; never limit searches to those subjects and never copy them into the new report unless the user asks for the same subjects or the retrieved evidence contains them. 3. Collect the facts with Echo tools for the period and scope the user names, across all groups available to the user when no scope is named; the data available to you, or what is in the system, means Echo data reachable through your tools, never the template itself. 4. Fill the template with echo_document_script, replacing every sample entry (fill_table or copy_blocks per event, the period in the title), and save it. 5. Say that nothing was found only after searching.",
    "Link every saved document in the answer as [title](echo-document:<documentId>), using the link the tool returned. Never say a document was created or changed unless echo_document_script reported it as saved; if saving failed, say so. Saving documents with these tools is the only file access and mutation you may perform.",
    ...(listed.length ? ["Documents of this conversation:", ...listed] : []),
    ...(target ? [`The user has ${JSON.stringify(target.title)} (documentId ${target.documentId}, revision ${registry.target!.revision}) open in the document panel.`] : []),
  ].join("\n");
}
