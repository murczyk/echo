export interface MessageCitation {
  messageId: number;
  messageIdentifier: string;
}

type JsonObject = Record<string, unknown>;

export function citationHref(citation: MessageCitation): string {
  return `/rer-analysis-neo?${new URLSearchParams({ m: citation.messageIdentifier })}`;
}

export function validateCitations(value: unknown): MessageCitation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid message citations");
  return value.map((item) => {
    if (
      !item ||
      !Number.isSafeInteger(item.messageId) ||
      item.messageId < 1 ||
      typeof item.messageIdentifier !== "string" ||
      !item.messageIdentifier.trim() ||
      item.messageIdentifier.length > 512
    )
      throw new Error("invalid message citation");
    return {
      messageId: item.messageId,
      messageIdentifier: item.messageIdentifier,
    };
  });
}

// DMR color codes are 0-15, so every distinct valid code fits; id lists are bounded.
export const DMR_COLOR_CODE_MAX = 15;
const DMR_COLOR_CODE_LIMIT = DMR_COLOR_CODE_MAX + 1;
const DMR_ID_LIMIT = 32;
const DMR_METADATA_VALUE_MAX_CHARACTERS = 64;

// "03" in a source header and "3" in a user query are the same color code.
export function canonicalColorCode(value: string): string {
  return /^\d+$/.test(value) ? String(Number(value)) : value;
}

function dmrValue(record: JsonObject, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, DMR_METADATA_VALUE_MAX_CHARACTERS)
    : undefined;
}

class BoundedDmrList {
  readonly entries = new Map<string, JsonObject | string>();
  truncated = false;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  add(key: string | undefined, entry: JsonObject | string): void {
    if (!key || this.entries.has(key)) return;
    if (this.entries.size >= this.limit) this.truncated = true;
    else this.entries.set(key, entry);
  }
}

function dmrIdEntry(record: JsonObject, idField: string, nameField: string): [string | undefined, JsonObject] {
  const id = dmrValue(record, idField);
  const name = dmrValue(record, nameField);
  return [id || name ? `${id ?? ""}\u0000${name ?? ""}` : undefined, { ...(id ? { id } : {}), ...(name ? { name } : {}) }];
}

// Parsed DMR metadata, deduplicated per message; truncated marks incomplete lists.
export function projectDmrMetadata(value: unknown): JsonObject | undefined {
  if (!Array.isArray(value)) return undefined;
  const colorCodes = new BoundedDmrList(DMR_COLOR_CODE_LIMIT);
  const callGroups = new BoundedDmrList(DMR_ID_LIMIT);
  const senders = new BoundedDmrList(DMR_ID_LIMIT);
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    const colorCode = dmrValue(record, "color_code");
    const canonical = colorCode && canonicalColorCode(colorCode);
    colorCodes.add(canonical, canonical ?? "");
    callGroups.add(...dmrIdEntry(record, "call_group_id", "call_group_name"));
    senders.add(...dmrIdEntry(record, "sender_id", "sender_name"));
  }
  const dmr: JsonObject = {};
  for (const [key, list] of Object.entries({ colorCodes, callGroups, senders }))
    if (list.entries.size) dmr[key] = [...list.entries.values()];
  if (!Object.keys(dmr).length) return undefined;
  return colorCodes.truncated || callGroups.truncated || senders.truncated ? { ...dmr, truncated: true } : dmr;
}

/** Full message text kept beside its citation for map scripts. */
export interface CitedMessage extends MessageCitation {
  text: string;
  datetime: string;
  author: string;
  group: string;
  /** Parsed DMR metadata, kept for synthesis when it is absent from the text. */
  dmr?: JsonObject;
}

export function prepareMessageCitations(
  skill: string,
  value: unknown,
): {
  body: unknown;
  citations: MessageCitation[];
  messages: CitedMessage[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { body: value, citations: [], messages: [] };
  }
  const body = { ...(value as JsonObject) };
  const citations: MessageCitation[] = [];
  const messages: CitedMessage[] = [];
  const enrich = (item: unknown): unknown => {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      !Number.isSafeInteger(item[0]) ||
      item[0] < 1
    )
      return item;
    const message = item[1];
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.text !== "string"
    )
      return item;
    const identifier =
      [message.message_uuid, message.message_uid]
        .find((value) => typeof value === "string" && value.trim())
        ?.trim() ?? String(item[0]);
    if (identifier.length > 512) return item;
    const citation = { messageId: item[0], messageIdentifier: identifier };
    citations.push(citation);
    const dmr = projectDmrMetadata(message.metadata);
    messages.push({
      ...citation,
      text: message.text,
      datetime:
        typeof message.timestamp === "number"
          ? new Date(message.timestamp * 1000).toISOString()
          : "",
      author: typeof message.sender === "string" ? message.sender : "",
      group:
        typeof message.group_master_key === "string"
          ? message.group_master_key
          : "",
      ...(dmr ? { dmr } : {}),
    });
    return [item[0], { ...message, citation: citationHref(citation) }];
  };
  if (skill === "inbox_messages" && Array.isArray(body.inbox_items)) {
    body.inbox_items = body.inbox_items.map(enrich);
  } else if (skill === "interception_context") {
    body.message = enrich(body.message);
  } else if (
    ["messages_by_id", "messages_by_uuid"].includes(skill) &&
    Array.isArray(body.messages)
  ) {
    body.messages = body.messages.map(enrich);
  }
  if (skill.startsWith("attachment_")) {
    const result = body.result && typeof body.result === "object" ? body.result as JsonObject : body;
    const documents = Array.isArray(result.documents) ? result.documents : result.document ? [result.document] : [];
    for (const document of documents as JsonObject[]) {
      if (!Number.isSafeInteger(document.messageId) || (document.messageId as number) < 1) continue;
      const identifier = typeof document.messageUuid === "string" ? document.messageUuid : String(document.messageId);
      const citation = { messageId: document.messageId as number, messageIdentifier: identifier };
      document.citation = citationHref(citation);
      document.text = typeof document.summary === "string" ? document.summary : String(document.fileName ?? "");
      citations.push(citation);
      if (Array.isArray(result.sections)) {
        const sections = result.sections as JsonObject[];
        for (const section of sections) section.citation = document.citation;
        messages.push({ ...citation, text: sections.map((section) => `${section.member} — ${section.locator}:\n${section.text ?? section.markdown ?? ""}`).join("\n\n"), datetime: "", author: "", group: "" });
      }
    }
  }
  return { body, citations, messages };
}

export function deliveredCitations(
  text: string,
  candidates: MessageCitation[],
): MessageCitation[] {
  const hrefs = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as JsonObject;
    if (typeof item.citation === "string" && typeof item.text === "string")
      hrefs.add(item.citation);
    Object.values(item).forEach(visit);
  };
  visit(JSON.parse(text));
  return candidates.filter((citation) => hrefs.has(citationHref(citation)));
}

const ANALYSIS_PATH = "/rer-analysis-neo?";
// Matches wdintel-rs AI_AGENT_EVENT_PAYLOAD_MAX_BYTES.
const ASSISTANT_SNAPSHOT_MAX_BYTES = 256 * 1024;
const HREF_BOUNDARY = new Set([
  "&",
  ")",
  "#",
  ">",
  '"',
  "'",
  "`",
  "]",
  " ",
  "\n",
  "\t",
  "\r",
]);

function analysisIdentifier(target: string): string | null {
  const start = target.indexOf(ANALYSIS_PATH);
  if (start < 0) return null;
  const query =
    target.slice(start + ANALYSIS_PATH.length).split(/[#\s]/, 1)[0] ?? "";
  const identifier = new URLSearchParams(query).get("m")?.trim();
  return identifier ? identifier : null;
}

function registeredCitation(
  target: string,
  citations: MessageCitation[],
): MessageCitation | undefined {
  const identifier = analysisIdentifier(target);
  if (!identifier) return undefined;
  return (
    citations.find((citation) => citation.messageIdentifier === identifier) ??
    citations.find((citation) => String(citation.messageId) === identifier)
  );
}

function citationForToken(
  token: string,
  citations: MessageCitation[],
): MessageCitation | undefined {
  return (
    citations.find((citation) => citation.messageIdentifier === token) ??
    citations.find((citation) => String(citation.messageId) === token)
  );
}

function markdownCitationLinks(
  target: string,
  citations: MessageCitation[],
): string | null {
  const tokens = target
    .split(/[,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  const matched = tokens.map((token) => citationForToken(token, citations));
  if (matched.some((citation) => !citation)) return null;
  return matched
    .map((citation) => `[джерело](${citationHref(citation!)})`)
    .join("");
}

function hrefIsPresent(text: string, href: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(href, from);
    if (at < 0) return false;
    const next = text[at + href.length];
    if (next === undefined || HREF_BOUNDARY.has(next)) return true;
    from = at + href.length;
  }
  return false;
}

export function answerUsesCitation(
  text: string,
  citations: MessageCitation[],
): boolean {
  return citations.some((citation) =>
    hrefIsPresent(text, citationHref(citation)),
  );
}

export function canonicalizeAnswer(
  text: string,
  citations: MessageCitation[],
  sourceLinks: Iterable<string> = [],
): string {
  const retainedLinks = new Set(sourceLinks);
  const markdownLink = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  const bareAnalysisUrl =
    /(?<!\]\()(?:https?:\/\/[^\s/)]+)?\/rer-analysis-neo\?[^\s)]+/g;
  const linked = text.replace(
    markdownLink,
    (match, label: string, target: string) => {
      const normalizedTarget = target.trim();
      if (retainedLinks.has(normalizedTarget)) return match;
      if (normalizedTarget.includes(ANALYSIS_PATH)) {
        const citation = registeredCitation(normalizedTarget, citations);
        if (!citation)
          return label.trim() && label.trim() !== "джерело" ? label : "";
        return `[джерело](${citationHref(citation)})`;
      }
      const rewritten = markdownCitationLinks(normalizedTarget, citations);
      if (rewritten) return rewritten;
      if (label.trim() === "джерело") return "";
      return match;
    },
  );
  return linked.replace(bareAnalysisUrl, (target: string) => {
    const trimmed = target.replace(/[.,;:!?]+$/, "");
    const suffix = target.slice(trimmed.length);
    const citation = registeredCitation(trimmed, citations);
    return citation ? `[джерело](${citationHref(citation)})${suffix}` : suffix;
  });
}

function uniqueCitations(citations: MessageCitation[]): MessageCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.messageIdentifier)) return false;
    seen.add(citation.messageIdentifier);
    return true;
  });
}

export function citationsForCanonical(
  delivered: MessageCitation[],
  history: MessageCitation[],
): MessageCitation[] {
  return uniqueCitations([...delivered, ...history]);
}

export function citationsForRepair(
  delivered: MessageCitation[],
  history: MessageCitation[],
  prompt: string,
): MessageCitation[] {
  const source = delivered.length
    ? delivered
    : /посилан|джерел|citation/i.test(prompt)
      ? history
      : [];
  return uniqueCitations(source);
}

export function needsCitationRepair(
  text: string,
  citations: MessageCitation[],
): boolean {
  return (
    citations.length > 0 &&
    !answerUsesCitation(canonicalizeAnswer(text, citations), citations)
  );
}

export function preserveRequestedCitation(
  text: string,
  citations: MessageCitation[],
  deliveredCount: number,
): string {
  if (
    deliveredCount > 0 ||
    !citations.length ||
    answerUsesCitation(text, citations)
  ) {
    return text;
  }
  return `${text.trim()}\n\n[джерело](${citationHref(citations[0])})`;
}

export function chooseCitedAnswer(
  draft: string,
  repair: string | null,
  citations: MessageCitation[],
  canonicalCitations: MessageCitation[] = citations,
  sourceLinks: Iterable<string> = [],
): string {
  const retainedLinks = [...sourceLinks];
  const canonicalDraft = canonicalizeAnswer(draft, canonicalCitations, retainedLinks);
  if (!needsCitationRepair(draft, citations) || repair === null)
    return canonicalDraft;
  const canonicalRepair = canonicalizeAnswer(repair, canonicalCitations, retainedLinks);
  return answerUsesCitation(canonicalRepair, citations)
    ? canonicalRepair
    : canonicalDraft;
}

export function citationRepairPrompt(
  draft: string,
  citations: MessageCitation[],
  mapReferences: string[] = [],
): string {
  const links = [
    ...new Map(
      citations.map((citation) => [
        citation.messageIdentifier,
        citationHref(citation),
      ]),
    ).values(),
  ]
    .map((href) => `[джерело](${href})`)
    .join("\n");
  return [
    "Rewrite the draft so every claim taken from an individual message is followed immediately by that message's markdown link.",
    "Copy only links from the list, character for character. A message id, tool name, or shortened URL is not a citation. Do not invent, alter, or add any other link. Do not call tools. Keep the same facts and language.",
    "If a listed message was not used, do not cite it.",
    ...(mapReferences.length ? ["Preserve the draft's registered map links from this list without changing their IDs:", ...mapReferences] : []),
    "",
    "Links:",
    links,
    "",
    "Draft:",
    draft,
  ].join("\n");
}

export function assistantSnapshotEvent(
  draft: string,
  finalText: string,
): { type: "assistant_snapshot"; text: string } | null {
  if (!finalText || finalText === draft) return null;
  const payload = JSON.stringify({ text: finalText });
  if (new TextEncoder().encode(payload).length > ASSISTANT_SNAPSHOT_MAX_BYTES)
    return null;
  return { type: "assistant_snapshot", text: finalText };
}
