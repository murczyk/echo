import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { validateCitations, type MessageCitation } from "./citations.ts";

const BATCH_LIMIT = 16;
const RECORD_LIMIT = 512;
const DOCUMENT_LIMIT = 16;
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
  document.warnings = document.records.flatMap((record, index) => record.warnings.map((warning) => `Рядок ${index + 1}: ${warning}`));
}

function reference(document: Omit<MapDocument, "records">) {
  const { id, title, isMain, totalCount, validCount, invalidCount, warnings } = document;
  return { id, title, isMain, reference: `[мапа](echo-map:${id})`, totalCount, validCount, invalidCount, warnings };
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
    return reference(document);
  }

  draft(id: string): MapDocument {
    const document = this.documents.get(id);
    if (!document) throw new Error("Unknown map document; use echo_map_list");
    if (this.published.has(id)) throw new Error("Published maps are immutable; create a new document");
    return document;
  }

  append(id: string, records: MapRecord[]) {
    const document = this.draft(id);
    if (!records.length || records.length > BATCH_LIMIT || document.records.length + records.length > RECORD_LIMIT)
      throw new Error("Append 1–16 records, at most 512 per document");
    document.records.push(...structuredClone(records));
    recount(document);
    return { ...reference(document), addedCount: records.length };
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

  list() {
    return [...this.history.map((item) => ({ ...reference(item), requestId: item.requestId, published: true })),
      ...[...this.documents.values()].map((item) => ({ ...reference(item), published: this.published.has(item.id) }))];
  }

  discardDrafts() {
    for (const id of this.documents.keys()) if (!this.published.has(id)) this.documents.delete(id);
  }
}

export function preserveMapReferences(draft: string, answer: string, maps: Array<{ id: string; reference: string; published: boolean; requestId?: string }>): string {
  const missing = maps.filter((document) => document.published
    && (!document.requestId || draft.includes(`](echo-map:${document.id})`))
    && !answer.includes(`](echo-map:${document.id})`)).map((document) => document.reference);
  return missing.length ? `${answer.trim()}\n\n${missing.join(" ")}` : answer;
}

const sourceSchema = Type.Object({ messageId: Type.Integer({ minimum: 1 }), messageIdentifier: Type.String({ minLength: 1, maxLength: 512 }) });
const recordSchema = Type.Object({
  sidc: Type.String({ pattern: "^[0-9]{20}$", description: "Copy the supplied APP6D SIDC; never guess a replacement." }),
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

export function createMapTools(registry: MapRegistry, request: Request, emit: Emit, countInvocation: () => void,
  knownCitation: (citation: MessageCitation) => boolean, recordSources: (citations: MessageCitation[]) => void = () => {}) {
  const idSchema = Type.String({ pattern: UUID.source });
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any, signal?: AbortSignal) => Promise<unknown> | unknown) => defineTool({
    name, label, description, parameters, executionMode: "sequential",
    execute: async (_id, params, signal) => {
      countInvocation();
      signal?.throwIfAborted();
      const result = await execute(params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { activityLabel: label } };
    },
  });
  return [
    tool("echo_map_create", "Готую документ мапи", "Create an unpublished point-map document. Use isMain=true for the response's one main map; use false for separate submaps. Append all records before publishing.",
      Type.Object({ title: Type.String({ minLength: 1, maxLength: 2_000 }), isMain: Type.Boolean() }),
      ({ title, isMain }) => registry.create(title, isMain)),
    tool("echo_map_append", "Додаю точки мапи", "Append 1–16 ordered records. Preserve separate events even at identical coordinates. Normalization and projection happen in Echo; invalid coordinates remain in CSV. Canonical records stay outside response compaction.",
      Type.Object({ id: idSchema, records: Type.Array(recordSchema, { minItems: 1, maxItems: BATCH_LIMIT }) }),
      async ({ id, records }, signal) => {
        const document = registry.draft(id);
        if (!Array.isArray(records) || !records.length || records.length > BATCH_LIMIT || document.totalCount + records.length > RECORD_LIMIT)
          throw new Error("Append batch exceeds map limits");
        for (const record of records) for (const source of validateCitations(record.sources))
          if (!knownCitation(source)) throw new Error("Map sources must be copied from retrieved message citations");
        const prepared = await request("/api/ai-agent/maps/prepare", { records }, signal) as { records: MapRecord[] };
        signal?.throwIfAborted();
        if (!Array.isArray(prepared.records) || prepared.records.length !== records.length) throw new Error("Incomplete map preparation response");
        return registry.append(id, prepared.records);
      }),
    tool("echo_map_publish", "Публікую мапу відповіді", "Explicitly publish a complete document and register its [мапа](echo-map:<id>) reference. Published maps are immutable and survive request cancellation. Unpublished drafts are discarded.",
      Type.Object({ id: idSchema }), ({ id }) => {
        const { document, alreadyPublished } = registry.publish(id);
        if (!alreadyPublished) emit({ type: "map_artifact", document });
        return { ...reference(document), published: true };
      }),
    tool("echo_map_list", "Переглядаю документи мап", "Recover map references, counts, warnings and publication status after compaction or from conversation history.", Type.Object({}), () => ({ maps: registry.list() })),
    tool("echo_map_get", "Читаю записи мапи", "Read up to 16 canonical records from a current document or a published map in conversation history. Follow nextOffset for remaining records.",
      Type.Object({ id: idSchema, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: BATCH_LIMIT })) }),
      async ({ id, offset = 0, limit = BATCH_LIMIT }, signal) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BATCH_LIMIT) throw new Error("Invalid map record window");
        let document = registry.get(id);
        if (!document) {
          const summary = registry.history.find((item) => item.id === id);
          if (!summary) throw new Error("Unknown map; use echo_map_list");
          document = await request("/api/ai-agent/maps/get", { requestId: summary.requestId, mapId: id }, signal) as MapDocument;
        }
        const records = document.records.slice(offset, offset + limit);
        signal?.throwIfAborted();
        recordSources(validateCitations(records.flatMap((record) => record.sources)));
        return { ...reference(document), records, nextOffset: offset + records.length < document.records.length ? offset + records.length : null };
      }),
  ];
}

export const MAP_GUIDANCE = `When asked for a map or CSV/KMZ from points, build a document with the map tools. Read every input record, preserve order and repeated coordinates, append batches of at most 16, and publish only after all records are included. Use one main map and optional separate submaps. Include the exact published [мапа](echo-map:<id>) references beside relevant passages; the latest main map automatically appears at the end. Never invent an ID, claim a download exists before publishing, or print a download data URL. Do not expose map tool names or IDs in prose. Use echo_map_list to recover documents after compaction and echo_map_get to read full records in batches. Copy the user's supplied SIDCs and explicit naming overrides exactly. For unit reports, derive the name only from the explicit Подразделение/Підрозділ field, or the leading unit designation when that field is absent. Never include the posting author, header username, drone/operator name, or recipient callsign from other fields. Order that supplied unit hierarchy from its smallest unit/team to the regiment; omit divisions and larger units. Preserve a callsign only when it is part of that unit designation or an explicit naming override. Join the unit names with spaces, preserving their spelling and case. Do not add commas, dashes, mission descriptions, cargo, equipment, or invented missing units to the name. Keep that information in comments. When every ticket/table field is requested, copy the complete original ticket or row into comments, preserving all field labels and values. Every record must be self-contained: repeat common values and never refer to a previous row instead of copying its fields. Use one or several comment cells for the complete source text; combine fields if a ticket has more fields than available cells, never stop at a cell limit. Preserve source wording, avoiding translation, paraphrase or shortened summaries. For table group names, follow the user's explicit group-code/callsign/unit naming rule. A group code is distinct from the table's ordinal row number. Keep applicable section headings and every supplied row-column value in comments when requested. In particular, explicitly repeat the original group code, callsign, personnel count and unit in comments even when the code/callsign/unit also appear in the name. Do not omit a requested comment field because its value is already represented by another record property. Preserve unselected position components exactly in comments, including extra or missing digits; never repair or truncate an unused coordinate. Use CAPDOC platform type. Prefer each event's date/time over posting headers; use the header date only when an event date is absent. Apply the supplied date policy: no date/time gives null, date only gives YYYY-MM-DDT00:00:00, date plus time gives YYYY-MM-DDTHH:mm:ss, time without a date gives null. When a posting header supplies the missing date, use that date with the event time. For tables, choose real position, then changed position, then previous position, and preserve unselected positions and other information in comments. In a flattened table, retain the position-column order: a later changed/real position pair takes precedence over the earlier previous position pair. Copy coordinates exactly from the chosen pair. Before publication, verify names, selected positions, input order, and total row count against the original input; use echo_map_get to inspect canonical records if needed. Normalize no coordinates yourself: copy original X/Y including malformed components and missing digits. Supplied MSK-2000 pairs use Echo's СК-42 conversion, not USK-2000. Invalid rows remain in CSV and are omitted from map geometry and KMZ; report their warnings and counts. Copy optional source citations only from retrieved messages. Lines, polygons and attachments are not supported.`;
