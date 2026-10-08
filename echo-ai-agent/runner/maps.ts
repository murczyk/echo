import { FILE_CITATION_SCHEMA, validateFileCitations, type FileCitation } from "./devices.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { validateCitations, type MessageCitation } from "./citations.ts";
import type { MapScriptRunner, RecipeStats, ScriptMessage } from "./map-script.ts";
import type { SidcResolver } from "./sidc-resolver.ts";

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
  fileSources?: FileCitation[];
}

export interface MapRecord extends MapRecordInput {
  platformType: string;
  originalX: string;
  originalY: string;
  latitude: number | null;
  longitude: number | null;
  comments: string[];
  sources: MessageCitation[];
  fileSources?: FileCitation[];
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

export interface MapOutcome {
  /** Failed edit tool calls, including ones rejected during argument validation. */
  editFailures: number;
  editSuccesses: number;
  lastEditError: string;
  /** Source reports detected for a draft, used to verify its record count. */
  expected: Map<string, { count: number; label: string }>;
  /** Drafts linked in the answer but left unpublished by the count check. */
  unpublished: string[];
}

const EDIT_TOOLS = new Set(["echo_map_edit", "echo_map_set_symbol", "echo_map_script"]);

export class MapCountMismatch extends Error {}

export class MapRegistry {
  private documents = new Map<string, MapDocument>();
  private published = new Set<string>();
  readonly history: MapSummary[];
  readonly outcome: MapOutcome = { editFailures: 0, editSuccesses: 0, lastEditError: "", expected: new Map(), unpublished: [] };

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

  /** Why a draft must not be published silently, or null. */
  mismatchWarning(id: string): string | null {
    const expected = this.outcome.expected.get(id);
    const document = this.documents.get(id);
    if (!expected || !document || this.published.has(id) || document.totalCount === expected.count) return null;
    return `У джерелі ${expected.count} звітів формату «${expected.label}», а на мапі ${document.totalCount} записів. Перевірте пропущені або зайві записи. Якщо різниця навмисна, повторіть з confirmMismatch=true і reason.`;
  }

  /** Counts failed edit tool calls from the tool lifecycle. */
  recordToolEnd(toolName: unknown, isError: boolean, text: string) {
    if (!isError || typeof toolName !== "string" || !EDIT_TOOLS.has(toolName)) return;
    this.outcome.editFailures += 1;
    this.outcome.lastEditError = text.slice(0, 300);
  }

  publish(id: string, confirmedMismatch = false): { document: MapDocument; alreadyPublished: boolean } {
    const document = this.documents.get(id);
    if (!document?.records.length) throw new Error("Cannot publish an empty map");
    const warning = confirmedMismatch ? null : this.mismatchWarning(id);
    if (warning) throw new MapCountMismatch(warning);
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

  expect(id: string, count: number, label: string) {
    if (Number.isSafeInteger(count) && count > 0) this.outcome.expected.set(id, { count, label });
  }

  /** Published maps whose record count differs from the detected source reports. */
  countMismatches(): Array<{ title: string; expected: number; actual: number; label: string }> {
    return [...this.outcome.expected].flatMap(([id, expected]) => {
      const document = this.documents.get(id);
      return document && this.published.has(id) && document.totalCount !== expected.count
        ? [{ title: document.title, expected: expected.count, actual: document.totalCount, label: expected.label }]
        : [];
    });
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
    let published;
    try {
      published = registry.publish(document.id);
    } catch (error) {
      if (!(error instanceof MapCountMismatch)) throw error;
      registry.outcome.unpublished.push(document.title);
      continue;
    }
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
  fileSources: Type.Optional(Type.Array(FILE_CITATION_SCHEMA, { maxItems: 16 })),
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

// Gemma-style special tokens (e.g. <|"|>) sometimes leak into tool-call JSON.
const SPECIAL_TOKEN = /<\|[^|<>]{0,24}\|>/g;

/** Cleans model-produced tool arguments before schema validation: strips
 * special tokens and lifts stray "key: value" strings out of object arrays
 * (e.g. a summary emitted inside `operations`). */
export function normalizeToolArguments(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SPECIAL_TOKEN, "").trim();
  if (Array.isArray(value)) return value.map(normalizeToolArguments);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = normalizeToolArguments(item);
  }
  for (const [key, item] of Object.entries(result)) {
    if (!Array.isArray(item) || !item.some((entry) => entry && typeof entry === "object")) continue;
    result[key] = item.filter((entry) => {
      if (typeof entry !== "string") return true;
      const match = /^\s*"?([A-Za-z_]\w{0,30})"?\s*:\s*([\s\S]*?)\s*\}?\s*$/.exec(entry);
      if (!match) return true;
      if (!(match[1] in result)) result[match[1]] = match[2].replace(/^"|"$/g, "");
      return false;
    });
  }
  return result;
}

const EDIT_OPS = ["add", "update", "remove", "setComponents", "setSidc", "setTitle"];
const OP_ALIASES: Record<string, string> = {
  retype: "setSidc", settype: "setSidc", changesidc: "setSidc", setsymbol: "setSidc", sidc: "setSidc",
  delete: "remove", rename: "setTitle", components: "setComponents",
};
const EDIT_EXAMPLE = '{"operations":[{"op":"setSidc","selector":{"all":true},"sidc":"10031000001211000000"}],"summary":"Змінено позначки"}';

/** Picks the operation a small model most plausibly meant. */
function inferOperation(source: Record<string, unknown>): string {
  const op = typeof source.op === "string" ? source.op.trim() : "";
  if (EDIT_OPS.includes(op)) {
    if (op === "setComponents" && !source.components && typeof source.sidc === "string") return "setSidc";
    return op;
  }
  const alias = OP_ALIASES[op.toLowerCase().replace(/[^a-z]/g, "")];
  if (alias) return alias;
  if (!op) {
    if (source.components && typeof source.components === "object") return "setComponents";
    if (typeof source.sidc === "string" && !source.fields && !source.record) return "setSidc";
    if (typeof source.title === "string") return "setTitle";
    if (source.record) return "add";
    if (source.fields) return "update";
  }
  throw new Error(`Невідома операція «${op || "(немає op)"}». Допустимі op: ${EDIT_OPS.join(", ")}. Приклад: ${EDIT_EXAMPLE}`);
}

function copyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function sanitizeEditOperations(operations: unknown, selectedPointIds: string[],
  knownCitation: (citation: MessageCitation) => boolean, maxOperations = EDIT_OPERATION_LIMIT, knownFile: (citation: FileCitation) => boolean = () => false): unknown[] {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOperations) throw new Error(`Потрібно від 1 до ${maxOperations} операцій. Приклад: ${EDIT_EXAMPLE}`);
  return operations.map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error(`Кожна операція має бути об'єктом. Приклад: ${EDIT_EXAMPLE}`);
    const source = operation as Record<string, unknown>;
    const next: Record<string, unknown> = { op: inferOperation(source) };
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
        fileSources: validateFileCitations(record.fileSources).filter(knownFile),
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
  // A plain string so near-misses (missing op, "retype") reach the sanitizer,
  // which infers the intended op or explains the valid ones.
  op: Type.Optional(Type.String({ description: "add | update | remove | setComponents | setSidc | setTitle" })),
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
  files?: () => import("./devices.ts").FileSection[];
}

// Keep in sync with FLIGHT_MARKER in template/python/echomap/recipes.py.
// A report header is followed by report fields; a sentence that merely names
// the format is not counted.
const FLIGHT_REPORT_LINE = /^[ \t]*(?:\[[^\]\n]*\][^\n:]*:[ \t]*)?(?:Детали полета|Деталі польоту)[ \t]*:?[ \t]*\n\s*(?:Подразделение|Підрозділ|Позывной|Позивний|Дата|Время|Час)\s*:/gimu;

/** Number of known-format reports, so small models can be routed to the
 * no-code recipe instead of writing a parser. */
export function countKnownReports(texts: string[]): number {
  return texts.reduce((total, text) => total + (text.match(FLIGHT_REPORT_LINE)?.length ?? 0), 0);
}

export function knownReportsGuidance(count: number): string {
  return count > 0
    ? `This request contains ${count} «Детали полета» flight reports. If the user wants all of them on a map, build it with echo_map_create, then echo_map_from_reports with that draft id (no code, no manual records), check that emittedCount equals ${count}, then echo_map_publish. For a subset, custom names or more than 512 reports, use echo_map_script with recipes.records() instead. If they only ask about the reports, answer without creating a map.`
    : "";
}

const TARGET_SCHEMA = Type.Union([
  Type.Literal("all"),
  Type.Literal("selected"),
  Type.Array(Type.String(), { minItems: 1, maxItems: RECORD_LIMIT }),
  Type.String({ minLength: 1, maxLength: 2_000 }),
]);

/** "all" | "selected" | ids | exact name → an echo_map_edit selector. */
function targetSelector(target: unknown): Record<string, unknown> {
  if (target === "all" || target === undefined) return { all: true, expect: "many" };
  if (target === "selected") return { selected: true, expect: "many" };
  if (Array.isArray(target)) return { ids: target.map(String), expect: "many" };
  // A name must match exactly one point; the backend asks to clarify otherwise.
  if (typeof target === "string") return { names: [target], expect: "one" };
  throw new Error('target має бути "all", "selected", списком id або точною назвою точки.');
}

function sanitizeRecordInputs(records: Array<MapRecordInput & { sidc?: string | null }>, knownCitation: (citation: MessageCitation) => boolean, knownFile: (citation: FileCitation) => boolean) {
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
      fileSources: validateFileCitations(record.fileSources).filter(knownFile),
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
  editing?: MapEditContext, script?: MapScriptContext, resolver?: SidcResolver, knownFile: (citation: FileCitation) => boolean = () => false) {
  const idSchema = Type.String({ pattern: UUID.source });
  const cursor = editing ? { ...editing, selectedPointIds: [...editing.selectedPointIds] } : undefined;
  // Retries within this request reuse a key; a later request repeating the
  // same edit after an undo must not replay the earlier result.
  const editKeySalt = randomUUID();
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any, signal?: AbortSignal) => Promise<unknown> | unknown) => defineTool({
    name, label, description, parameters, executionMode: "sequential",
    prepareArguments: (args: unknown) => normalizeToolArguments(args) as any,
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
    const { sanitized, omittedSourceCount } = sanitizeRecordInputs(records, knownCitation, knownFile);
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
    return applyEdit(operations, revisionSummary, maxOperations, signal);
  }

  async function applyEdit(operations: unknown, revisionSummary: unknown, maxOperations: number, signal?: AbortSignal) {
    if (!cursor) throw new Error("No map is open for editing");
    const sanitized = sanitizeEditOperations(operations, cursor.selectedPointIds, knownCitation, maxOperations, knownFile);
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
    // A new revision is saved (a no-op returns the same one); later
    // bookkeeping must not make it look unsaved.
    if (result.revision !== cursor.revision) registry.outcome.editSuccesses += 1;
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
    tool("echo_map_publish", "Публікую мапу відповіді", "Explicitly publish a complete document and register its [мапа](echo-map:<id>) reference. Published maps are immutable and survive request cancellation. Unpublished drafts are discarded. If the record count differs from the detected source reports, publishing is refused until you fix the map or pass confirmMismatch=true with a reason (e.g. the user asked for a subset).",
      Type.Object({ id: idSchema, confirmMismatch: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String({ maxLength: 500 })) }), ({ id, confirmMismatch, reason }) => {
        const confirmed = confirmMismatch === true && typeof reason === "string" && reason.trim().length > 0;
        let publication;
        try {
          publication = registry.publish(id, confirmed);
        } catch (error) {
          if (error instanceof MapCountMismatch) return { published: false, warning: error.message };
          throw error;
        }
        const { document, alreadyPublished } = publication;
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
        const files = records.flatMap((record) => record.fileSources ?? []);
        for (let offset = 0; offset < files.length; offset += 100) emit({ type: "file_citations", citations: files.slice(offset, offset + 100) });
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
    if (resolver) {
      tools.push(tool("echo_map_set_symbol", "Змінюю позначки мапи",
        'Change the symbol of points on the open map in one step; prefer this for any symbol, type, affiliation, status or echelon change. target: "all", "selected", a list of point ids, or an exact point name. Give either a full 20-digit sidc, or any of: type (plain words such as "танк", "БпЛА", "піхота", "РЕБ"), identity ("дружній"/"ворожий"/"нейтральний"/"невідомий"), status ("наявний"/"запланований"/"знищений"), echelon ("взвод", "рота", ...). Only the given parts change. summary: short Ukrainian description.',
        Type.Object({
          target: TARGET_SCHEMA,
          sidc: Type.Optional(Type.String()),
          type: Type.Optional(Type.String({ maxLength: 200 })),
          identity: Type.Optional(Type.String({ maxLength: 40 })),
          status: Type.Optional(Type.String({ maxLength: 40 })),
          echelon: Type.Optional(Type.String({ maxLength: 40 })),
          summary: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        async ({ target, sidc, type, identity, status, echelon, summary: revisionSummary }, signal) => {
          const patch = resolver.resolve({ sidc, type, identity, status, echelon });
          const selector = targetSelector(target);
          const operation = "sidc" in patch
            ? { op: "setSidc", selector, sidc: patch.sidc }
            : { op: "setComponents", selector, components: patch.components };
          const result = await editMap([operation], revisionSummary, EDIT_OPERATION_LIMIT, signal);
          return "typeLabel" in patch && patch.typeLabel ? { ...result, type: patch.typeLabel } : result;
        }));
    }
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
          files: script.files?.() ?? [],
          map,
          selectedPointIds: cursor?.selectedPointIds ?? [],
        }, signal);
        if (outcome.status !== 0 || !outcome.result) {
          const reports = countKnownReports([script.prompt, ...script.messages().map((message) => message.text), ...(script.files?.() ?? []).map((file) => file.text)]);
          const hint = reports > 0 ? `\nДля ${reports} звітів «Детали полета» викличте echo_map_from_reports з id чернетки — без коду.` : "";
          throw new Error(`Script failed (exit ${outcome.status}). Fix it and retry.${hint}\n${tail(outcome.stderr)}`);
        }
        const { records, operations, summary: revisionSummary, logs, detected } = outcome.result;
        if (id && records.length) {
          const [label, count] = Object.entries(detected).sort((a, b) => b[1] - a[1])[0] ?? [];
          if (label) registry.expect(id, count, label);
        }
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
    tools.push(tool("echo_map_from_reports", "Наношу звіти на мапу",
      "Fill a draft map (id from echo_map_create) from reports in a known format (currently: «Детали полета» UAV flight reports) found in the prompt or retrieved messages, with no code. Each report becomes one record with the correct name, time, coordinates and the full report as comment. Use this first for such reports; use echo_map_script only when it reports that no known format matched. Then check sourceCount/emittedCount and publish.",
      Type.Object({
        id: idSchema,
        recipe: Type.Optional(Type.String({ maxLength: 60 })),
        symbol: Type.Optional(Type.String({ maxLength: 200, description: "Optional SIDC or words (e.g. «дружній БпЛА») for reports that carry no SIDC, when the user asked for a symbol." })),
      }),
      async ({ id, recipe, symbol }, signal) => {
        registry.draft(id);
        const name = typeof recipe === "string" && /^[a-z_]{1,60}$/.test(recipe) ? recipe : null;
        const requested = typeof symbol === "string" && symbol.trim() ? symbol.trim() : null;
        const outcome = await script.run(`from echomap import recipes\nrecipes.run(${name ? JSON.stringify(name) : "None"}, symbol=${requested ? JSON.stringify(requested) : "None"})\n`, {
          prompt: script.prompt,
          messages: script.messages(),
          files: script.files?.() ?? [],
          map: null,
          selectedPointIds: [],
        }, signal);
        if (outcome.status !== 0 || !outcome.result?.stats) {
          throw new Error(`Не вдалося застосувати рецепт. ${tail(outcome.stderr.split("\n").filter(Boolean).at(-1) ?? "", 300)}`);
        }
        const stats: RecipeStats = outcome.result.stats;
        registry.expect(id, stats.sourceCount, stats.label);
        const appended = await appendRecords(id, outcome.result.records, signal);
        return { ...stats, appended };
      }));
  }
  return tools;
}

const SCRIPT_DESCRIPTION = `Run a short Python 3 script with the echomap library, without network or file access, to build or bulk-edit a map from text instead of typing every record. Prefer it for more than about 5 records, repetitive tickets/tables, and bulk symbol or field changes. The script sees the user's prompt, retrieved Echo messages and device-file sections already read in this request.
Library: from echomap import inputs, parse, recipes, sidc, Record, emit_records, current_map, emit_patch, log
- recipes.records(symbol=None) -> Record objects parsed from known report formats («Детали полета»), ready to filter/rename/slice and pass to emit_records.
- inputs.files() -> [FileSection(name, locator, text)] with .citation(); pass source=file to Record to preserve its revision and section. File dates are not observation dates.
- inputs.prompt() -> str; inputs.messages() -> [Message(message_id, message_identifier, text, datetime, author, group)].
- parse.split(text, marker_regex) -> blocks starting at matching lines; parse.kv(block) -> Fields with .first("Key", "Альтернатива"); parse.pair(text) -> (x, y) copied as written; parse.pairs(text); parse.dt(date, time=None) -> "YYYY-MM-DDTHH:MM:SS" or None; parse.lines(text).
- sidc.find(text, identity="unknown"|"friend"|"hostile"|"neutral"|"suspect", echelon=None) -> 20-digit SIDC from Ukrainian/English words ("" when unknown); sidc.set(code, identity=, status=, echelon=, hq=, symbol_set=, entity=); sidc.retype(code, "танк"); sidc.describe(code); sidc.search("radar") -> [(set, entity, label)].
- Record(name, x, y, crs="msk2000", sidc="", when=None, comments=[...], source=message) then emit_records([...]); pass this tool's id (a draft from echo_map_create). Long comments are split into cells automatically.
- current_map() -> Map with .records (MapRecord: id, name, sidc, when, comments, x, y, crs, selected, text, describe()), .selected(), .where(name=, text=, identity=, symbol_set=, entity=, selected=, predicate), .remove(*records), .add(Record), .title; emit_patch(map, summary="…") saves all changes as one revision.
print() and log() output is returned. Follow the same naming, comment, coordinate and date rules as for echo_map_append; copy source text into comments by passing the parsed block, never retype it.`;

export const MAP_GUIDANCE = `When asked for a map or CSV/KMZ from points, build a document with the map tools. Read every input record, preserve order and repeated coordinates, append up to 128 records per call (up to 512 in one document); preparation is automatically split into batches of at most 32. For verbose tickets/tables, process about 16 source rows per call to stay within output limits, including every event/subgroup within those rows, and publish only after all records are included. Use one main map and optional separate submaps. Include the exact published [мапа](echo-map:<id>) references beside relevant passages; the latest main map automatically appears at the end. Never invent an ID, claim a download exists before publishing, or print a download data URL. Do not expose map tool names or IDs in prose. Use echo_map_list to recover documents after compaction and echo_map_get to read full records in batches. Copy the user's supplied SIDCs and explicit naming overrides exactly. When coordinates are present but no APP6D SIDC was supplied, leave sidc empty; Echo assigns the standard symbol and a warning. Never invent a SIDC. For unit reports, derive the name only from the explicit Подразделение/Підрозділ field, or the leading unit designation when that field is absent. Never include the posting author, header username, drone/operator name, or recipient callsign from other fields. Order that supplied unit hierarchy from its smallest unit/team to the regiment; omit divisions and larger units. Preserve a callsign only when it is part of that unit designation or an explicit naming override. Join the unit names with spaces, preserving their spelling and case. Do not add commas, dashes, mission descriptions, cargo, equipment, or invented missing units to the name. Keep that information in comments. When every ticket/table field is requested, copy the complete original ticket or row into comments, preserving all field labels and values. Every record must be self-contained: repeat common values and never refer to a previous row instead of copying its fields. Use one or several comment cells for the complete source text; combine fields if a ticket has more fields than available cells, never stop at a cell limit. Preserve source wording, avoiding translation, paraphrase or shortened summaries. For table group names, follow the user's explicit group-code/callsign/unit naming rule. A group code is distinct from the table's ordinal row number. Keep applicable section headings and every supplied row-column value in comments when requested. In particular, explicitly repeat the original group code, callsign, personnel count and unit in comments even when the code/callsign/unit also appear in the name. Do not omit a requested comment field because its value is already represented by another record property. Preserve unselected position components exactly in comments, including extra or missing digits; never repair or truncate an unused coordinate. Use CAPDOC platform type. Prefer each event's date/time over posting headers; use the header date only when an event date is absent. Apply the supplied date policy: no date/time gives null, date only gives YYYY-MM-DDT00:00:00, date plus time gives YYYY-MM-DDTHH:mm:ss, time without a date gives null. When a posting header supplies the missing date, use that date with the event time. For tables, choose real position, then changed position, then previous position, and preserve unselected positions and other information in comments. In a flattened table, retain the position-column order: a later changed/real position pair takes precedence over the earlier previous position pair. Copy coordinates exactly from the chosen pair. Before publication, verify names, selected positions, input order, and total row count against the original input; use echo_map_get to inspect canonical records if needed. Normalize no coordinates yourself: copy original X/Y including malformed components and missing digits. Supplied MSK-2000 pairs use Echo's СК-42 conversion, not USK-2000. Invalid rows remain in CSV and are omitted from map geometry and KMZ; report their warnings and counts. Copy optional sources only from retrieved messages and fileSources only from retrieved device-file citations, preserving their revision, extractionRevision and section. Leave sources empty when the text was pasted and no message was retrieved; citations that were not retrieved are omitted. Do not paste a [мапа](echo-map:<id>) link until echo_map_publish returns it. If echo_map_append fails, correct the arguments and retry instead of claiming that the map exists. Lines, polygons and attachments are not supported.`;

export const SCRIPT_GUIDANCE = `For «Детали полета» UAV flight reports, call echo_map_from_reports on the draft instead of writing code or appending records yourself. When the user wants only some reports, custom names, or more than 512 records split into submaps, use echo_map_script with recipes.records() (the same parsed Record objects) and filter, rename or slice them before emit_records. For more than about 5 records from tickets, reports or tables, or for bulk changes to an open map, prefer echo_map_script: write a short Python script that parses the prompt or retrieved messages and emits records/edits, instead of typing records into echo_map_append. Pass parsed source blocks as comments so original text is copied, not retyped. If a script fails, read the error, fix the script and retry. Verify the returned counts against the input before publishing. When the user asks for a symbol type or affiliation (e.g. "ворожі танки", "дружні БпЛА"), choose the SIDC with sidc.find/sidc.set/sidc.retype; otherwise keep the rule about unsupplied SIDCs.`;

export const EDIT_GUIDANCE = `The user has a map open for editing. For any symbol, type, affiliation, status or echelon change use echo_map_set_symbol (target "all", "selected", ids or a name; a full sidc or plain words). For other changes use echo_map_edit; each call becomes one revision that the user can undo. Questions that do not ask for a change need no edit. Do not rebuild, republish, or resend the map document. Editing that map is the only permitted mutation; messages, settings, and other Echo data stay unchanged. Select points by id, exact name, SIDC, all, or selector.selected=true when the user refers to "these/selected" points. If a name matches more than one point, ask which one; do not guess. A new point needs explicit coordinates or exactly one unambiguous accessible source that already contains the location; otherwise ask where to place it. In echo_map_edit, use setSidc for a full SIDC and setComponents only with a components object; both preserve every other field. echo_map_get reads the current revision. Pass a short Ukrainian summary of the change. If an edit tool returns an error, fix the arguments using the error's example; never tell the user a change was made unless a tool call succeeded.`;
