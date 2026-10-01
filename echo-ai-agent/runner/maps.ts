import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { validateCitations, type MessageCitation } from "./citations.ts";
import type { MapScriptRunner, ScriptMessage } from "./map-script.ts";

const BATCH_LIMIT = 32;
const APPEND_LIMIT = 128;
const RECORD_LIMIT = 512;
const DOCUMENT_LIMIT = 16;
const EDIT_OPERATION_LIMIT = 32;
// A script edit becomes one revision, so it may touch every record.
const SCRIPT_OPERATION_LIMIT = RECORD_LIMIT;
const SCRIPT_CODE_LIMIT = 20_000;
const SCRIPT_OUTPUT_LIMIT = 4_000;
const EVENT_BYTE_LIMIT = 256 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface MapRecordInput {
  sidc: string;
  name: string;
  observationDatetime?: string | null;
  coordinateSystem: string;
  x: string;
  y: string;
  comments?: string[];
  sources?: MessageCitation[];
}

export interface MapRecord extends MapRecordInput {
  platformType: string;
  originalX: string;
  originalY: string;
  latitude: number | null;
  longitude: number | null;
  comments: string[];
  sources: MessageCitation[];
  warnings: string[];
}

export interface MapSummary {
  id: string;
  requestId: string;
  title: string;
  isMain: boolean;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  warnings: string[];
}

export interface MapDocument extends Omit<MapSummary, "requestId"> {
  records: MapRecord[];
}

export function validateMapSummaries(value: unknown): MapSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DOCUMENT_LIMIT)
    throw new Error("Invalid map summaries");
  return value.map((item) => {
    if (!item || !UUID.test(item.id) || !UUID.test(item.requestId) ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 2_000 ||
      typeof item.isMain !== "boolean" ||
      ![item.totalCount, item.validCount, item.invalidCount].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= RECORD_LIMIT) ||
      item.validCount + item.invalidCount !== item.totalCount ||
      !Array.isArray(item.warnings) || item.warnings.some((warning: unknown) => typeof warning !== "string"))
      throw new Error("Invalid map summary");
    return { id: item.id, requestId: item.requestId, title: item.title, isMain: item.isMain,
      totalCount: item.totalCount, validCount: item.validCount, invalidCount: item.invalidCount, warnings: item.warnings };
  });
}

function recount(document: MapDocument): void {
  document.totalCount = document.records.length;
  document.validCount = document.records.filter((record) => record.latitude !== null && record.longitude !== null).length;
  document.invalidCount = document.totalCount - document.validCount;
  document.warnings = document.records.flatMap((record, index) => (record.warnings ?? []).map((warning) => `Рядок ${index + 1}: ${warning}`));
}

export function mapLink(id: string): string {
  return `[мапа](echo-map:${id})`;
}

function summary(document: Omit<MapDocument, "records">, published: boolean) {
  const { id, title, isMain, totalCount, validCount, invalidCount, warnings } = document;
  return { id, title, isMain, totalCount, validCount, invalidCount, warnings, ...(published ? { reference: mapLink(id) } : {}) };
}

export class MapRegistry {
  private documents = new Map<string, MapDocument>();
  private published = new Set<string>();
  readonly history: MapSummary[];

  constructor(history: MapSummary[] = []) {
    this.history = [...new Map(history.map((item) => [item.id, item])).values()];
  }

  create(title: string, isMain: boolean) {
    if (!title.trim() || title.length > 2_000) throw new Error("Invalid map title");
    if (this.documents.size >= DOCUMENT_LIMIT) throw new Error("Map document limit reached");
    const document: MapDocument = { id: randomUUID(), title: title.trim(), isMain, records: [], warnings: [], totalCount: 0, validCount: 0, invalidCount: 0 };
    this.documents.set(document.id, document);
    return summary(document, false);
  }

  draft(id: string): MapDocument {
    const document = this.documents.get(id);
    if (!document) throw new Error("Unknown map document; use echo_map_list");
    if (this.published.has(id)) throw new Error("Published maps are immutable; create a new document");
    return document;
  }

  append(id: string, records: MapRecord[]) {
    const document = this.draft(id);
    if (!records.length || records.length > APPEND_LIMIT || document.records.length + records.length > RECORD_LIMIT)
      throw new Error("Append 1–128 records, at most 512 per document");
    document.records.push(...structuredClone(records));
    recount(document);
    return { ...summary(document, false), addedCount: records.length };
  }

  publish(id: string): { document: MapDocument; alreadyPublished: boolean } {
    const document = this.documents.get(id);
    if (!document?.records.length) throw new Error("Cannot publish an empty map");
    if (Buffer.byteLength(JSON.stringify({ document })) > EVENT_BYTE_LIMIT)
      throw new Error("Map document is too large; prepare smaller submaps");
    const alreadyPublished = this.published.has(id);
    this.published.add(id);
    return { document: structuredClone(document), alreadyPublished };
  }

  get(id: string) { return this.documents.get(id); }

  isPublished(id: string) { return this.published.has(id); }

  find(id: string): MapDocument | undefined {
    return this.documents.get(id) ?? [...this.documents.values()].find((document) => document.id.toLowerCase() === id.toLowerCase());
  }

  list() {
    return [...this.history.map((item) => ({ ...summary(item, true), requestId: item.requestId, published: true })),
      ...[...this.documents.values()].map((item) => {
        const published = this.published.has(item.id);
        return { ...summary(item, published), published };
      })];
  }

  discardDrafts() {
    for (const id of this.documents.keys()) if (!this.published.has(id)) this.documents.delete(id);
  }
}

function mapLinkPattern(): RegExp {
  return /\[мапа\]\(echo-map:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)/gi;
}

export function publishReferencedDrafts(answer: string, registry: MapRegistry, emit: Emit): void {
  for (const match of answer.matchAll(mapLinkPattern())) {
    const document = registry.find(match[1]);
    if (!document?.records.length || registry.isPublished(document.id)) continue;
    const published = registry.publish(document.id);
    if (!published.alreadyPublished) emit({ type: "map_artifact", document: published.document });
  }
}

export function stripUnpublishedMapLinks(answer: string, maps: Array<{ id: string; published: boolean }>): string {
  const published = new Set(maps.filter((item) => item.published).map((item) => item.id.toLowerCase()));
  return answer.replace(mapLinkPattern(), (link, id: string) => published.has(id.toLowerCase()) ? link : "");
}

export function preserveMapReferences(draft: string, answer: string, maps: Array<{ id: string; reference?: string; published: boolean; requestId?: string }>): string {
  const missing = maps.filter((document) => document.published && document.reference
    && (!document.requestId || draft.includes(`](echo-map:${document.id})`))
    && !answer.includes(`](echo-map:${document.id})`)).map((document) => document.reference!);
  return missing.length ? `${answer.trim()}\n\n${missing.join(" ")}` : answer;
}

const sourceSchema = Type.Object({ messageId: Type.Integer({ minimum: 1 }), messageIdentifier: Type.String({ minLength: 1, maxLength: 512 }) });
const recordSchema = Type.Object({
  sidc: Type.Optional(Type.Union([
    Type.String({ pattern: "^[0-9]{20}$" }),
    Type.Literal(""),
    Type.Null(),
  ], { description: "Copy a supplied 20-digit APP6D SIDC. Leave this empty when the source has none; never guess a replacement." })),
  name: Type.String({ minLength: 1, maxLength: 2_000 }),
  observationDatetime: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  coordinateSystem: Type.String({ description: "Use msk2000 for supplied MSK-2000 X/Y pairs (same conversion as Echo СК-42), or sk42. Do not label them USK-2000." }),
  x: Type.String({ description: "Original X component, including separators or missing digits. Never repair a missing digit." }),
  y: Type.String({ description: "Original Y component, including separators or missing digits. Never repair a missing digit." }),
  comments: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 32,
    description: "When asked to preserve ticket/table fields, copy the complete original ticket or row into comments, including every field. Each record must be self-contained, even for repeated values. There are up to 32 comment cells; combine fields in a cell if necessary, never omit fields to fit a cell limit. Also repeat the group code, callsign and unit already used in the name. Preserve unselected coordinate components exactly, including malformed values; never repair or truncate them." })),
  sources: Type.Optional(Type.Array(sourceSchema, { maxItems: 16 })),
});

type Request = (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
type Emit = (event: Record<string, unknown>) => void;

export interface MapEditContext {
  requestId: string;
  mapId: string;
  revision: number;
  selectedPointIds: string[];
}

const MAP_EDIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPONENT_KEYS = [
  "group1", "context", "identity", "symbolSet", "status",
  "headquartersOrTaskForce", "echelon", "mainIcon", "modifier1", "modifier2",
] as const;

export function validateMapEdit(value: unknown): MapEditContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mapEdit must be an object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["requestId", "mapId", "revision", "selectedPointIds"].includes(key))) {
    throw new Error("mapEdit contains an unsupported field");
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const mapId = typeof body.mapId === "string" ? body.mapId : "";
  if (!MAP_EDIT_UUID.test(requestId) || !MAP_EDIT_UUID.test(mapId)) throw new Error("mapEdit identifiers must be UUIDs");
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) throw new Error("mapEdit.revision must be a positive integer");
  const selected = body.selectedPointIds ?? [];
  if (!Array.isArray(selected) || selected.length > RECORD_LIMIT) throw new Error("mapEdit.selectedPointIds must contain at most 512 ids");
  const selectedPointIds = selected.map((id) => {
    if (typeof id !== "string" || !MAP_EDIT_UUID.test(id)) throw new Error("mapEdit.selectedPointIds must be UUIDs");
    return id;
  });
  if (new Set(selectedPointIds).size !== selectedPointIds.length) throw new Error("mapEdit.selectedPointIds must be unique");
  return { requestId, mapId, revision: body.revision as number, selectedPointIds };
}

function copyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function sanitizeEditOperations(operations: unknown, selectedPointIds: string[],
  knownCitation: (citation: MessageCitation) => boolean, maxOperations = EDIT_OPERATION_LIMIT): unknown[] {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOperations) throw new Error(`Map edit requires 1–${maxOperations} operations`);
  return operations.map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Map edit operation must be an object");
    const source = operation as Record<string, unknown>;
    if (!["add", "update", "remove", "setComponents", "setSidc", "setTitle"].includes(String(source.op))) throw new Error("Unknown map edit operation");
    const next: Record<string, unknown> = { op: source.op };
    if (source.selector && typeof source.selector === "object") {
      const selector = source.selector as Record<string, unknown>;
      if (selector.selected === true) {
        if (!selectedPointIds.length) throw new Error("Немає вибраних точок. Уточніть запис.");
        next.selector = { ids: [...selectedPointIds], expect: selector.expect === "one" ? "one" : "many" };
      } else {
        const cleaned: Record<string, unknown> = {};
        const ids = copyStrings(selector.ids);
        const names = copyStrings(selector.names);
        if (ids?.length) cleaned.ids = ids;
        if (names?.length) cleaned.names = names;
        if (typeof selector.sidc === "string") cleaned.sidc = selector.sidc;
        if (selector.all === true) cleaned.all = true;
        if (selector.expect === "one" || selector.expect === "many") cleaned.expect = selector.expect;
        next.selector = cleaned;
      }
    }
    if (source.record && typeof source.record === "object") {
      const record = source.record as MapRecordInput & { sidc?: string | null };
      const sources = validateCitations(record.sources).filter(knownCitation);
      next.record = {
        sidc: typeof record.sidc === "string" ? record.sidc : "",
        name: record.name,
        observationDatetime: record.observationDatetime ?? null,
        coordinateSystem: record.coordinateSystem,
        x: record.x,
        y: record.y,
        comments: record.comments ?? [],
        sources,
      };
    }
    if (source.fields && typeof source.fields === "object") {
      const fields = source.fields as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      if (typeof fields.name === "string") cleaned.name = fields.name;
      if (fields.observationDatetime === null) cleaned.clearObservationDatetime = true;
      else if (typeof fields.observationDatetime === "string") cleaned.observationDatetime = fields.observationDatetime;
      const comments = copyStrings(fields.comments);
      if (comments) cleaned.comments = comments;
      if (typeof fields.coordinateSystem === "string") cleaned.coordinateSystem = fields.coordinateSystem;
      if (typeof fields.x === "string") cleaned.x = fields.x;
      if (typeof fields.y === "string") cleaned.y = fields.y;
      next.fields = cleaned;
    }
    if (source.components && typeof source.components === "object") {
      const components = source.components as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const key of COMPONENT_KEYS) if (typeof components[key] === "string") cleaned[key] = components[key];
      next.components = cleaned;
    }
    if (typeof source.sidc === "string") next.sidc = source.sidc;
    if (typeof source.title === "string") next.title = source.title;
    return next;
  });
}

const editDigits = (width: number) => Type.String({ pattern: `^[0-9]{${width}}$` });
const editOperationSchema = Type.Object({
  op: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove"), Type.Literal("setComponents"), Type.Literal("setSidc"), Type.Literal("setTitle")]),
  selector: Type.Optional(Type.Object({
    ids: Type.Optional(Type.Array(Type.String(), { maxItems: RECORD_LIMIT })),
    names: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 32 })),
    sidc: Type.Optional(Type.String()),
    all: Type.Optional(Type.Boolean()),
    expect: Type.Optional(Type.Union([Type.Literal("one"), Type.Literal("many")])),
    selected: Type.Optional(Type.Boolean()),
  })),
  record: Type.Optional(recordSchema),
  fields: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ maxLength: 2_000 })),
    observationDatetime: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    comments: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 32 })),
    coordinateSystem: Type.Optional(Type.String()),
    x: Type.Optional(Type.String()),
    y: Type.Optional(Type.String()),
  })),
  components: Type.Optional(Type.Object({
    group1: Type.Optional(editDigits(2)),
    context: Type.Optional(editDigits(1)),
    identity: Type.Optional(editDigits(1)),
    symbolSet: Type.Optional(editDigits(2)),
    status: Type.Optional(editDigits(1)),
    headquartersOrTaskForce: Type.Optional(editDigits(1)),
    echelon: Type.Optional(editDigits(2)),
    mainIcon: Type.Optional(editDigits(6)),
    modifier1: Type.Optional(editDigits(2)),
    modifier2: Type.Optional(editDigits(2)),
  })),
  sidc: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
});

export interface MapScriptContext {
  run: MapScriptRunner;
  prompt: string;
  messages: () => ScriptMessage[];
}

function sanitizeRecordInputs(records: Array<MapRecordInput & { sidc?: string | null }>, knownCitation: (citation: MessageCitation) => boolean) {
  let omittedSourceCount = 0;
  const sanitized = records.map((record) => {
    const sources = validateCitations(record.sources).filter((source) => {
      if (knownCitation(source)) return true;
      omittedSourceCount += 1;
      return false;
    });
    return {
      sidc: typeof record.sidc === "string" ? record.sidc : "",
      name: record.name,
      observationDatetime: record.observationDatetime ?? null,
      coordinateSystem: record.coordinateSystem,
      x: record.x,
      y: record.y,
      comments: record.comments ?? [],
      sources,
    };
  });
  return { sanitized, omittedSourceCount };
}

function tail(text: string, limit = SCRIPT_OUTPUT_LIMIT): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function createMapTools(registry: MapRegistry, request: Request, emit: Emit, countInvocation: () => void,
  knownCitation: (citation: MessageCitation) => boolean, recordSources: (citations: MessageCitation[]) => void = () => {},
  editing?: MapEditContext, script?: MapScriptContext) {
  const idSchema = Type.String({ pattern: UUID.source });
  const cursor = editing ? { ...editing, selectedPointIds: [...editing.selectedPointIds] } : undefined;
  // Retries within this request reuse a key; a later request repeating the
  // same edit after an undo must not replay the earlier result.
  const editKeySalt = randomUUID();
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any, signal?: AbortSignal) => Promise<unknown> | unknown) => defineTool({
    name, label, description, parameters, executionMode: "sequential",
    execute: async (_id, params, signal) => {
      countInvocation();
      signal?.throwIfAborted();
      const result = await execute(params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { activityLabel: label } };
    },
  });

  // Prepares every record in Echo before touching the draft, so a failed
  // batch leaves the whole append retryable.
  async function appendRecords(id: string, records: Array<MapRecordInput & { sidc?: string | null }>, signal?: AbortSignal) {
    const document = registry.draft(id);
    if (!Array.isArray(records) || !records.length || document.totalCount + records.length > RECORD_LIMIT)
      throw new Error("Append batch exceeds map limits");
    const { sanitized, omittedSourceCount } = sanitizeRecordInputs(records, knownCitation);
    const preparedRecords: MapRecord[] = [];
    for (let offset = 0; offset < sanitized.length; offset += BATCH_LIMIT) {
      signal?.throwIfAborted();
      const batch = sanitized.slice(offset, offset + BATCH_LIMIT);
      const prepared = await request("/api/ai-agent/maps/prepare", { records: batch }, signal) as { records: MapRecord[] };
      if (!Array.isArray(prepared.records) || prepared.records.length !== batch.length) throw new Error("Incomplete map preparation response");
      preparedRecords.push(...prepared.records);
    }
    signal?.throwIfAborted();
    let appended: ReturnType<MapRegistry["append"]> | undefined;
    for (let offset = 0; offset < preparedRecords.length; offset += APPEND_LIMIT) {
      appended = registry.append(id, preparedRecords.slice(offset, offset + APPEND_LIMIT));
    }
    return { ...appended!, addedCount: preparedRecords.length, omittedSourceCount };
  }

  async function editMap(operations: unknown, revisionSummary: unknown, maxOperations: number, signal?: AbortSignal) {
    if (!cursor) throw new Error("No map is open for editing");
    const sanitized = sanitizeEditOperations(operations, cursor.selectedPointIds, knownCitation, maxOperations);
    const idempotencyKey = createHash("sha256").update(`${editKeySalt}\n${cursor.revision}\n${JSON.stringify(sanitized)}`).digest("hex");
    const result = await request("/api/ai-agent/maps/edit", {
      requestId: cursor.requestId,
      mapId: cursor.mapId,
      expectedRevision: cursor.revision,
      idempotencyKey,
      ...(typeof revisionSummary === "string" && revisionSummary.trim() ? { summary: revisionSummary.trim() } : {}),
      operations: sanitized,
    }, signal) as Record<string, unknown>;
    if (!Number.isSafeInteger(result?.revision)) throw new Error("Incomplete map edit response");
    cursor.revision = result.revision as number;
    if (Number(result.removedCount) > 0 && cursor.selectedPointIds.length) {
      // `changes` is capped, so reconcile the selection with the live records.
      const current = await request("/api/ai-agent/maps/get", { requestId: cursor.requestId, mapId: cursor.mapId }, signal) as MapDocument;
      const live = new Set(current.records.map((record) => (record as MapRecord & { id?: string }).id));
      cursor.selectedPointIds = cursor.selectedPointIds.filter((id) => live.has(id));
    }
    const { document: _document, records: _records, ...compact } = result;
    return compact;
  }

  async function readDocument(id: string, signal?: AbortSignal): Promise<{ document: MapDocument; local: boolean }> {
    const local = registry.get(id);
    if (local) return { document: local, local: true };
    const history = registry.history.find((item) => item.id === id);
    if (!history) throw new Error("Unknown map; use echo_map_list");
    const document = await request("/api/ai-agent/maps/get", { requestId: history.requestId, mapId: id }, signal) as MapDocument;
    return { document, local: false };
  }

  const tools = [
    tool("echo_map_create", "Готую документ мапи", "Create an unpublished point-map document. Use isMain=true for the response's one main map; use false for separate submaps. Append all records before publishing.",
      Type.Object({ title: Type.String({ minLength: 1, maxLength: 2_000 }), isMain: Type.Boolean() }),
      ({ title, isMain }) => registry.create(title, isMain)),
    tool("echo_map_append", "Додаю точки мапи", "Append 1–128 ordered records per call, up to 512 in one document. Echo automatically prepares batches of at most 32 and adds all records atomically. For verbose tickets or tables, process about 16 source rows per call; include every separate event/subgroup in those rows, even when that gives more records. Preserve separate events even at identical coordinates. Normalization and projection happen in Echo; invalid coordinates remain in CSV. Leave sidc empty when the source has no 20-digit APP6D code. Omit sources that were not retrieved. The markdown map link is returned only by echo_map_publish. Canonical records stay outside response compaction.",
      Type.Object({ id: idSchema, records: Type.Array(recordSchema, { minItems: 1, maxItems: APPEND_LIMIT }) }),
      ({ id, records }, signal) => {
        if (!Array.isArray(records) || records.length > APPEND_LIMIT) throw new Error("Append batch exceeds map limits");
        return appendRecords(id, records, signal);
      }),
    tool("echo_map_publish", "Публікую мапу відповіді", "Explicitly publish a complete document and register its [мапа](echo-map:<id>) reference. Published maps are immutable and survive request cancellation. Unpublished drafts are discarded.",
      Type.Object({ id: idSchema }), ({ id }) => {
        const { document, alreadyPublished } = registry.publish(id);
        if (!alreadyPublished) emit({ type: "map_artifact", document });
        return { ...summary(document, true), published: true };
      }),
    tool("echo_map_list", "Переглядаю документи мап", "Recover map references, counts, warnings and publication status after compaction or from conversation history.", Type.Object({}), () => ({ maps: registry.list() })),
    tool("echo_map_get", "Читаю записи мапи", "Read up to 32 canonical records from a current document or a published map in conversation history. Follow nextOffset for remaining records.",
      Type.Object({ id: idSchema, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: BATCH_LIMIT })) }),
      async ({ id, offset = 0, limit = BATCH_LIMIT }, signal) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BATCH_LIMIT) throw new Error("Invalid map record window");
        const { document, local } = await readDocument(id, signal);
        const records = document.records.slice(offset, offset + limit);
        signal?.throwIfAborted();
        recordSources(validateCitations(records.flatMap((record) => record.sources)));
        return { ...summary(document, local ? registry.isPublished(document.id) : true), records, nextOffset: offset + records.length < document.records.length ? offset + records.length : null };
      }),
  ];
  if (cursor) {
    tools.push(tool("echo_map_edit", "Оновлюю мапу",
      "Apply one atomic change to the active map; it is saved as a new revision the user can undo. Do not rebuild the map, do not send the document, and do not invent a point id. selector.selected=true uses the user's current selection. setTitle renames the map. New points need coordinates or one unambiguous accessible source. Ask when a name matches several points. summary is a short Ukrainian description of the change for the revision history.",
      Type.Object({
        operations: Type.Array(editOperationSchema, { minItems: 1, maxItems: EDIT_OPERATION_LIMIT }),
        summary: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      ({ operations, summary: revisionSummary }, signal) => editMap(operations, revisionSummary, EDIT_OPERATION_LIMIT, signal)));
  }
  if (script) {
    tools.push(tool("echo_map_script", "Обробляю дані мапи скриптом", SCRIPT_DESCRIPTION,
      Type.Object({
        code: Type.String({ minLength: 1, maxLength: SCRIPT_CODE_LIMIT }),
        id: Type.Optional(idSchema),
      }),
      async ({ code, id }, signal) => {
        const map = cursor ? (await readDocument(cursor.mapId, signal).catch(async () =>
          ({ document: await request("/api/ai-agent/maps/get", { requestId: cursor.requestId, mapId: cursor.mapId }, signal) as MapDocument }))).document : null;
        const outcome = await script.run(code, {
          prompt: script.prompt,
          messages: script.messages(),
          map,
          selectedPointIds: cursor?.selectedPointIds ?? [],
        }, signal);
        if (outcome.status !== 0 || !outcome.result) {
          throw new Error(`Script failed (exit ${outcome.status}). Fix it and retry.\n${tail(outcome.stderr)}`);
        }
        const { records, operations, summary: revisionSummary, logs } = outcome.result;
        const output = { stdout: tail(outcome.stdout), logs };
        if (records.length && operations.length) throw new Error("A script must emit either new records or map edits, not both");
        if (records.length) {
          if (!id) throw new Error("Pass the id of the draft map (echo_map_create) to append emitted records");
          return { ...output, appended: await appendRecords(id, records, signal) };
        }
        if (operations.length) {
          return { ...output, edit: await editMap(operations, revisionSummary, SCRIPT_OPERATION_LIMIT, signal) };
        }
        return output;
      }));
  }
  return tools;
}

const SCRIPT_DESCRIPTION = `Run a short Python 3 script with the echomap library, without network or file access, to build or bulk-edit a map from text instead of typing every record. Prefer it for more than about 5 records, repetitive tickets/tables, and bulk symbol or field changes. The script sees the user's prompt and the Echo messages already retrieved in this request.
Library: from echomap import inputs, parse, sidc, Record, emit_records, current_map, emit_patch, log
- inputs.prompt() -> str; inputs.messages() -> [Message(message_id, message_identifier, text, datetime, author, group)].
- parse.split(text, marker_regex) -> blocks starting at matching lines; parse.kv(block) -> Fields with .first("Key", "Альтернатива"); parse.pair(text) -> (x, y) copied as written; parse.pairs(text); parse.dt(date, time=None) -> "YYYY-MM-DDTHH:MM:SS" or None; parse.lines(text).
- sidc.find(text, identity="unknown"|"friend"|"hostile"|"neutral"|"suspect", echelon=None) -> 20-digit SIDC from Ukrainian/English words ("" when unknown); sidc.set(code, identity=, status=, echelon=, hq=, symbol_set=, entity=); sidc.retype(code, "танк"); sidc.describe(code); sidc.search("radar") -> [(set, entity, label)].
- Record(name, x, y, crs="msk2000", sidc="", when=None, comments=[...], source=message) then emit_records([...]); pass this tool's id (a draft from echo_map_create). Long comments are split into cells automatically.
- current_map() -> Map with .records (MapRecord: id, name, sidc, when, comments, x, y, crs, selected, text, describe()), .selected(), .where(name=, text=, identity=, symbol_set=, entity=, selected=, predicate), .remove(*records), .add(Record), .title; emit_patch(map, summary="…") saves all changes as one revision.
print() and log() output is returned. Follow the same naming, comment, coordinate and date rules as for echo_map_append; copy source text into comments by passing the parsed block, never retype it.`;

export const MAP_GUIDANCE = `When asked for a map or CSV/KMZ from points, build a document with the map tools. Read every input record, preserve order and repeated coordinates, append up to 128 records per call (up to 512 in one document); preparation is automatically split into batches of at most 32. For verbose tickets/tables, process about 16 source rows per call to stay within output limits, including every event/subgroup within those rows, and publish only after all records are included. Use one main map and optional separate submaps. Include the exact published [мапа](echo-map:<id>) references beside relevant passages; the latest main map automatically appears at the end. Never invent an ID, claim a download exists before publishing, or print a download data URL. Do not expose map tool names or IDs in prose. Use echo_map_list to recover documents after compaction and echo_map_get to read full records in batches. Copy the user's supplied SIDCs and explicit naming overrides exactly. When coordinates are present but no APP6D SIDC was supplied, leave sidc empty; Echo assigns the standard symbol and a warning. Never invent a SIDC. For unit reports, derive the name only from the explicit Подразделение/Підрозділ field, or the leading unit designation when that field is absent. Never include the posting author, header username, drone/operator name, or recipient callsign from other fields. Order that supplied unit hierarchy from its smallest unit/team to the regiment; omit divisions and larger units. Preserve a callsign only when it is part of that unit designation or an explicit naming override. Join the unit names with spaces, preserving their spelling and case. Do not add commas, dashes, mission descriptions, cargo, equipment, or invented missing units to the name. Keep that information in comments. When every ticket/table field is requested, copy the complete original ticket or row into comments, preserving all field labels and values. Every record must be self-contained: repeat common values and never refer to a previous row instead of copying its fields. Use one or several comment cells for the complete source text; combine fields if a ticket has more fields than available cells, never stop at a cell limit. Preserve source wording, avoiding translation, paraphrase or shortened summaries. For table group names, follow the user's explicit group-code/callsign/unit naming rule. A group code is distinct from the table's ordinal row number. Keep applicable section headings and every supplied row-column value in comments when requested. In particular, explicitly repeat the original group code, callsign, personnel count and unit in comments even when the code/callsign/unit also appear in the name. Do not omit a requested comment field because its value is already represented by another record property. Preserve unselected position components exactly in comments, including extra or missing digits; never repair or truncate an unused coordinate. Use CAPDOC platform type. Prefer each event's date/time over posting headers; use the header date only when an event date is absent. Apply the supplied date policy: no date/time gives null, date only gives YYYY-MM-DDT00:00:00, date plus time gives YYYY-MM-DDTHH:mm:ss, time without a date gives null. When a posting header supplies the missing date, use that date with the event time. For tables, choose real position, then changed position, then previous position, and preserve unselected positions and other information in comments. In a flattened table, retain the position-column order: a later changed/real position pair takes precedence over the earlier previous position pair. Copy coordinates exactly from the chosen pair. Before publication, verify names, selected positions, input order, and total row count against the original input; use echo_map_get to inspect canonical records if needed. Normalize no coordinates yourself: copy original X/Y including malformed components and missing digits. Supplied MSK-2000 pairs use Echo's СК-42 conversion, not USK-2000. Invalid rows remain in CSV and are omitted from map geometry and KMZ; report their warnings and counts. Copy optional source citations only from retrieved messages. Leave sources empty when the text was pasted and no message was retrieved; citations that were not retrieved are omitted. Do not paste a [мапа](echo-map:<id>) link until echo_map_publish returns it. If echo_map_append fails, correct the arguments and retry instead of claiming that the map exists. Lines, polygons and attachments are not supported.`;

export const SCRIPT_GUIDANCE = `For more than about 5 records from tickets, reports or tables, or for bulk changes to an open map, prefer echo_map_script: write a short Python script that parses the prompt or retrieved messages and emits records/edits, instead of typing records into echo_map_append. Pass parsed source blocks as comments so original text is copied, not retyped. If a script fails, read the error, fix the script and retry. Verify the returned counts against the input before publishing. When the user asks for a symbol type or affiliation (e.g. "ворожі танки", "дружні БпЛА"), choose the SIDC with sidc.find/sidc.set/sidc.retype; otherwise keep the rule about unsupplied SIDCs.`;

export const EDIT_GUIDANCE = `The user has a map open for editing. When they ask to change it, use echo_map_edit; each call becomes one revision that the user can undo. Questions that do not ask for a change need no edit. Do not rebuild, republish, or resend the map document. Editing that map is the only permitted mutation; messages, settings, and other Echo data stay unchanged. Select points by id, exact name, SIDC, all, or selector.selected=true when the user refers to "these/selected" points. If a name matches more than one point, ask which one; do not guess. A new point needs explicit coordinates or exactly one unambiguous accessible source that already contains the location; otherwise ask where to place it. To change symbols, prefer setComponents (identity, status, echelon, symbolSet+mainIcon); it preserves every component that was not supplied. echo_map_get reads the current revision. Pass a short Ukrainian summary of the change.`;
