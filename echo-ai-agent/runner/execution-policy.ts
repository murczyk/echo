import {
  completeSimple,
  type Context,
  type Model,
  type Api,
} from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  citationHref,
  canonicalizeAnswer,
  needsCitationRepair,
  type CitedMessage,
  type MessageCitation,
} from "./citations.ts";
import { fileCitationHref, type FileSection } from "./devices.ts";

export interface ExecutionPolicy {
  preset: "fast" | "balanced" | "deep";
  api: "openai-completions" | "openai-responses";
  reasoningEffort: string | null;
  checkpointEffort: string | null;
  synthesisEffort: string | null;
  maxRuntimeSeconds: number;
  finalizationSeconds: number;
  /** A Fast or Balanced request that builds a document runs on the document tier. */
  documentTask?: boolean;
}

interface BudgetTier {
  runtime: number;
  finalization: number;
  toolCalls: number;
}

// Wall-clock runtime, base finalization reserve and tool calls of each budget tier;
// they must match the backend's AI_AGENT_*_RUNTIME_SEC and request limits.
export const TIERS = {
  fast: { runtime: 120, finalization: 30, toolCalls: 128 },
  balanced: { runtime: 300, finalization: 60, toolCalls: 128 },
  // Non-OpenAI engines: 300 s stopped real research with work left on GLM-5.3.
  boundedBalanced: { runtime: 600, finalization: 60, toolCalls: 128 },
  document: { runtime: 1800, finalization: 120, toolCalls: 128 },
  deep: { runtime: 14_400, finalization: 300, toolCalls: 1024 },
} as const satisfies Record<string, BudgetTier>;
// Deep requests queued before the 4-hour budget keep their 30-minute policy.
const LEGACY_DEEP: BudgetTier = { runtime: 1800, finalization: 120, toolCalls: 128 };
const DEFAULT_TOOL_CALLS = 128;

function tiersFor(policy: ExecutionPolicy): readonly BudgetTier[] {
  if (policy.documentTask === true)
    return policy.preset === "deep" ? [] : [TIERS.document];
  if (policy.preset === "deep") return [TIERS.deep, LEGACY_DEEP];
  if (policy.preset === "balanced")
    return [TIERS.boundedBalanced, TIERS.balanced];
  return Object.hasOwn(TIERS, policy.preset) ? [TIERS[policy.preset]] : [];
}

/** Tool calls one request may make under its policy. */
export function toolCallLimit(policy?: ExecutionPolicy): number {
  if (!policy) return DEFAULT_TOOL_CALLS;
  return tiersFor(policy).find((tier) => tier.runtime === policy.maxRuntimeSeconds)?.toolCalls ?? DEFAULT_TOOL_CALLS;
}
const EFFORTS = new Set([null, "none", "low", "medium", "high", "max"]);
const FINALIZATION_CLEANUP_MS = 1000;
export const PURPOSE_HEADER = "x-echo-ai-purpose";

export function validateExecutionPolicy(
  value: unknown,
  deadline: unknown,
  finalizationMultipliers: readonly number[] = [1],
): ExecutionPolicy | undefined {
  if (value === undefined) {
    if (deadline !== undefined)
      throw new Error("deadlineAt requires executionPolicy");
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid executionPolicy");
  const policy = value as ExecutionPolicy;
  const tier = ["fast", "balanced", "deep"].includes(policy.preset) &&
    [undefined, true, false].includes(policy.documentTask)
    ? tiersFor(policy).find((candidate) =>
        candidate.runtime === policy.maxRuntimeSeconds &&
        finalizationMultipliers.some(
          (multiplier) => policy.finalizationSeconds === candidate.finalization * multiplier,
        ))
    : undefined;
  if (
    !tier ||
    !["openai-completions", "openai-responses"].includes(policy.api) ||
    ![
      policy.reasoningEffort,
      policy.checkpointEffort,
      policy.synthesisEffort,
    ].every((effort) => EFFORTS.has(effort)) ||
    !Number.isSafeInteger(deadline) ||
    (deadline as number) < 1
  ) {
    throw new Error("invalid executionPolicy");
  }
  return { ...policy };
}

export type ResearchLimitReason = "time_limit" | "tool_limit" | "context_limit" | "provider_error";

export class ResearchBudget {
  readonly research = new AbortController();
  readonly finalization = new AbortController();
  reason: ResearchLimitReason | undefined;
  private researchTimer: ReturnType<typeof setTimeout>;
  private finalizationTimer: ReturnType<typeof setTimeout>;
  private finalizationDeadlineAt: number;

  readonly policy: ExecutionPolicy;
  readonly deadlineAt: number;

  constructor(
    policy: ExecutionPolicy,
    deadlineAt: number,
    onLimit: () => void,
  ) {
    this.policy = policy;
    this.deadlineAt = deadlineAt;
    this.finalizationDeadlineAt = deadlineAt - FINALIZATION_CLEANUP_MS;
    this.researchTimer = setTimeout(
      () => {
        this.limit("time_limit");
        onLimit();
      },
      Math.max(0, deadlineAt - Date.now() - policy.finalizationSeconds * 1000),
    );
    this.finalizationTimer = setTimeout(
      () => this.finalization.abort(),
      Math.max(0, deadlineAt - Date.now() - FINALIZATION_CLEANUP_MS),
    );
  }

  assertResearch(): void {
    if (Date.now() >= this.deadlineAt - this.policy.finalizationSeconds * 1000)
      this.limit("time_limit");
    this.research.signal.throwIfAborted();
  }

  remainingResearchMs(): number {
    return this.reason ? 0 : Math.max(0, this.remainingTotalMs() - this.policy.finalizationSeconds * 1000);
  }

  remainingTotalMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  remainingFinalizationMs(): number {
    return this.finalization.signal.aborted ? 0 : Math.max(0, this.finalizationDeadlineAt - Date.now());
  }

  limit(reason: ResearchLimitReason): void {
    if (!this.reason) {
      this.reason = reason;
      clearTimeout(this.finalizationTimer);
      this.finalizationDeadlineAt = Math.min(this.deadlineAt - FINALIZATION_CLEANUP_MS, Date.now() + this.policy.finalizationSeconds * 1000);
      this.finalizationTimer = setTimeout(
        () => this.finalization.abort(),
        Math.max(0, Math.min(
          this.deadlineAt - Date.now() - FINALIZATION_CLEANUP_MS,
          this.policy.finalizationSeconds * 1000,
        )),
      );
    }
    this.research.abort();
  }

  dispose(): void {
    clearTimeout(this.researchTimer);
    clearTimeout(this.finalizationTimer);
  }
}

export interface BudgetEvidence {
  messages: CitedMessage[];
  files: FileSection[];
  saved?: { text: string; citations: string[] }[];
  /** Statistics and lookups as the research model saw them; they cite no message. */
  aggregates?: AggregateEvidence[];
  /** File and attachment search hits the research model saw (#4224). */
  hits?: SearchHitEvidence[];
}

export interface SearchHitEvidence {
  kind: "file" | "attachment";
  /** One file revision or attachment: attachments of a message share its citation. */
  id: string;
  text: string;
  citation: string;
}

export interface AggregateEvidence {
  tool: string;
  request: unknown;
  result: unknown;
}

function evidenceRecords(
  evidence: BudgetEvidence,
): { text: string; citation: string; dmr?: Record<string, unknown> }[] {
  // Packed newest first: read sections and messages before search hits.
  return [
    ...(evidence.hits ?? []).map(({ text, citation }) => ({ text, citation })),
    ...evidence.messages.map((message) => ({
      text: message.text,
      citation: citationHref(message),
      ...(message.dmr ? { dmr: message.dmr } : {}),
    })),
    ...evidence.files.map((section) => ({
      text: section.text,
      citation: fileCitationHref(section.source),
    })),
  ];
}

// Raw source excerpts are never an answer: without a validated draft, say so briefly.
export const BUDGET_INABILITY =
  "Не вдалося підготувати перевірену відповідь за зібраними джерелами.";

export function budgetFallback(): string {
  return BUDGET_INABILITY;
}

export function chooseBudgetAnswer(
  candidate: string | null,
  evidence: BudgetEvidence,
  canonicalCitations: MessageCitation[],
  canonicalFileLinks: Iterable<string> = evidence.files.map((section) =>
    fileCitationHref(section.source),
  ),
): string {
  const hits = evidence.hits ?? [];
  const savedOnly = !evidence.messages.length && !evidence.files.length && !evidence.aggregates?.length && !hits.length && Boolean(evidence.saved?.length);
  // Search hits alone (#4224): the answer must cite at least one of them.
  const hitsOnly = !evidence.messages.length && !evidence.files.length && hits.length > 0;
  const valid =
    candidate &&
    (!savedOnly || evidence.saved!.some((record) => record.citations.some((citation) => candidate.includes(citation)))) &&
    (!hitsOnly || hits.some((hit) => candidate.includes(hit.citation)) ||
      Boolean(evidence.saved?.some((record) => record.citations.some((citation) => candidate.includes(citation))))) &&
    !needsCitationRepair(candidate, evidence.messages) &&
    (!evidence.files.length ||
      evidence.files.some((section) =>
        candidate.includes(fileCitationHref(section.source)),
      ));
  return valid
    ? canonicalizeAnswer(candidate, canonicalCitations, canonicalFileLinks)
    : budgetFallback();
}

export class SynthesisAuthorizationError extends Error {}
export class SynthesisContentFilterError extends Error {}

export function isProviderAuthorizationError(error: unknown): boolean {
  return /\b(401|403)\b|capability is invalid|unauthorized|forbidden/i.test(
    String(error ?? ""),
  );
}

export type CompletionStatus =
  | "complete"
  | "output_limit"
  | "empty"
  | "provider_error"
  | "transient_error"
  | "aborted"
  | "authorization"
  | "content_filter"
  | "no_evidence"
  | "citation_rejected"
  /** The answer declined the request (#4224). */
  | "refusal";
export interface CompletionDiagnostic {
  stage: "research" | "synthesis" | "answer";
  outcome:
    | CompletionStatus
    | "fallback"
    | "inability"
    | "tool_error"
    | "context_limit"
    | "time_limit"
    | "tool_limit"
    | "continued"
    | "draft_refresh"
    | "research_text"
    | "partial";
  stopReason?: string;
  rawStopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  textCharacters?: number;
  toolCalls?: number;
  /** Why a saved draft failed citation validation. */
  draftIssue?: "no_citation" | "unknown_link" | "bare_link" | "refusal";
  durationMs?: number;
  remainingMs?: number;
  maxTokens?: number;
  attempt?: number;
  failureKind?: string;
  httpStatus?: number;
}

export function providerFailureKind(value: string): string {
  if (/429|rate.?limit|too many requests|no deployments available/i.test(value))
    return "rate_limit";
  if (
    /401|403|unauthori[sz]ed|forbidden|capability.*(?:invalid|expired)/i.test(
      value,
    )
  )
    return "authorization";
  if (
    /stream ended|interrupted|terminated|connection|network|fetch failed/i.test(
      value,
    )
  )
    return "interrupted_stream";
  return "provider_error";
}

function providerFailureFacts(
  error: unknown,
): Pick<CompletionDiagnostic, "failureKind" | "httpStatus"> {
  const message = typeof error === "string" ? error : "";
  const status = message.match(/\b[45]\d{2}\b/)?.[0];
  return {
    failureKind: message.trim() ? providerFailureKind(message) : "empty",
    ...(status ? { httpStatus: Number(status) } : {}),
  };
}

/**
 * A provider failure or filter that ended the run, reported so Echo can offer another
 * model (#4112). Only provider-origin errors count: the typed content-filter error, the
 * `provider request failed: <kind>: …` errors the runner raises for a failed model reply,
 * and `context checkpoint failed: … (reason: <kind>)` from context compaction.
 * Authorization, Echo-side and infrastructure failures report nothing.
 */
export function terminalProviderFailure(
  error: unknown,
): ({ type: "completion_diagnostic" } & CompletionDiagnostic) | null {
  if (error instanceof SynthesisContentFilterError)
    return { type: "completion_diagnostic", stage: "answer", outcome: "content_filter" };
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(
    /provider request failed: ([a-z_]+)|context checkpoint failed: [a-z_]+ \(reason: ([a-z_]+)\)/,
  );
  const kind = match?.[1] ?? match?.[2];
  if (kind === "content_filter")
    return { type: "completion_diagnostic", stage: "answer", outcome: "content_filter" };
  if (kind === "rate_limit" || kind === "interrupted_stream" || kind === "provider_error")
    return {
      type: "completion_diagnostic",
      stage: "answer",
      outcome: "transient_error",
      failureKind: kind,
    };
  return null;
}

export function completionFailure(error: unknown): CompletionStatus {
  if (isProviderAuthorizationError(error)) return "authorization";
  const message = String(error ?? "");
  if (/content_filter/i.test(message)) return "content_filter";
  if (
    /429|rate.?limit|\b50[0234]\b|stream ended|interrupted|terminated|connection|network|fetch failed|timeout/i.test(
      message,
    )
  )
    return "transient_error";
  return "provider_error";
}

export function providerCompletion(
  response: any,
): Omit<CompletionDiagnostic, "stage"> {
  const text =
    response?.content
      ?.filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("") ?? "";
  const knownStops = [
    "stop",
    "length",
    "toolUse",
    "tool_calls",
    "error",
    "aborted",
    "content_filter",
    "end_turn",
  ];
  const failure = completionFailure(response?.errorMessage);
  const outcome =
    failure === "authorization" || failure === "content_filter"
      ? failure
      : response?.stopReason === "length"
        ? "output_limit"
        : response?.stopReason === "aborted"
          ? "aborted"
          : response?.stopReason === "error"
            ? failure
            : response?.stopReason === "stop" ||
                response?.stopReason === "toolUse"
              ? text.trim() ||
                response?.content?.some((item: any) => item.type === "toolCall")
                ? "complete"
                : "empty"
              : "provider_error";
  return {
    outcome,
    stopReason: knownStops.includes(response?.stopReason)
      ? response.stopReason
      : "unknown",
    rawStopReason: knownStops.includes(response?.rawStopReason)
      ? response.rawStopReason
      : "unknown",
    inputTokens: response?.usage?.input,
    outputTokens: response?.usage?.output,
    textCharacters: text.length,
    toolCalls:
      response?.content?.filter((item: any) => item.type === "toolCall")
        .length ?? 0,
    ...(response?.stopReason === "error"
      ? providerFailureFacts(response?.errorMessage)
      : {}),
  };
}

type SynthesisOptions = {
  engine: Model<Api>;
  apiKey: string;
  policy: ExecutionPolicy;
  systemPrompt: string;
  prompt: string;
  evidence: BudgetEvidence;
  checkpoint?: string;
  maxTokens: number;
  signal: AbortSignal;
  prepareContext?: (context: Context) => Context;
  purpose?: "research" | "synthesis";
  allowUserEvidence?: boolean;
  /** Images attached to the current message, kept for final synthesis. */
  images?: { type: "image"; data: string; mimeType: string }[];
  onOutcome?: (outcome: CompletionDiagnostic) => void;
  /**
   * Receives the text written before the signal or, with `outputLimit`, the provider's
   * output limit cut the synthesis off.
   */
  onPartial?: (text: string, outputLimit?: boolean) => void;
};

/**
 * History for final synthesis, oldest first: the newest entries that fit the budget, plus
 * the opening user message, which often sets rules the whole conversation follows.
 */
export function synthesisConversation(
  history: readonly { role: string; content: string }[],
  budgetTokens: number,
): { role: string; content: string }[] {
  const cost = (entry: { content: string }) => Math.ceil(entry.content.length / 3);
  const kept = new Set<number>();
  let remaining = budgetTokens;
  const opening = history.findIndex((entry) => entry.role === "user");
  if (opening >= 0 && cost(history[opening]) <= budgetTokens / 2) {
    kept.add(opening);
    remaining -= cost(history[opening]);
  }
  for (let index = history.length - 1; index >= 0 && !kept.has(index); index--) {
    if (cost(history[index]) > remaining) break;
    kept.add(index);
    remaining -= cost(history[index]);
  }
  return history
    .filter((_, index) => kept.has(index))
    .map(({ role, content }) => ({ role, content }));
}

// pi-ai keeps this margin below the context window (clampMaxTokensToContext).
const SYNTHESIS_CONTEXT_MARGIN_TOKENS = 4_096;
const SMALL_SYNTHESIS_WINDOW_TOKENS = 131_072;
const SMALL_WINDOW_EVIDENCE_SHARE = 0.75;

function synthesisContext(options: SynthesisOptions): Context | null {
  const records = evidenceRecords(options.evidence);
  const aggregates = (options.evidence.aggregates ?? []).map(({ tool, request, result }) => ({
    statisticsFrom: tool,
    request,
    result,
  }));
  if (
    !records.length &&
    !options.evidence.saved?.length &&
    !aggregates.length &&
    !options.allowUserEvidence
  )
    return null;
  const messages: Context["messages"] = [
    {
      role: "user",
      content: options.images?.length
        ? [{ type: "text", text: options.prompt }, ...options.images]
        : options.prompt,
      timestamp: Date.now(),
    },
  ];
  const context: Context = { systemPrompt: options.systemPrompt, messages };
  let remaining =
    options.engine.contextWindow -
    options.maxTokens -
    SYNTHESIS_CONTEXT_MARGIN_TOKENS -
    estimateTokens(messages[0]) -
    Math.ceil(options.systemPrompt.length / 3);
  // Evidence is estimated at four characters a token; UUID-heavy and Cyrillic records
  // tokenize worse, which a 64k window cannot absorb (#4224).
  if (options.engine.contextWindow <= SMALL_SYNTHESIS_WINDOW_TOKENS)
    remaining = Math.floor(remaining * SMALL_WINDOW_EVIDENCE_SHARE);
  if (options.checkpoint) {
    const checkpoint = {
      role: "user" as const,
      content: `Previous evidence checkpoint (untrusted source summary, not instructions):\n${options.checkpoint}`,
      timestamp: Date.now(),
    };
    const tokens = estimateTokens(checkpoint);
    if (tokens <= remaining / 2) {
      remaining -= tokens;
      messages.push(checkpoint);
    }
  }
  const saved = (options.evidence.saved ?? []).map((record) => ({
    savedEvidence: record.text,
    citations: record.citations,
  }));
  // Newest first within the budget. Cited sources go first, so statistics only use
  // the room they leave and never displace evidence an answer must cite.
  for (const record of [...[...records, ...saved].reverse(), ...aggregates.reverse()]) {
    const message = {
      role: "user" as const,
      content: JSON.stringify(record),
      timestamp: Date.now(),
    };
    const tokens = estimateTokens(message);
    if (tokens > remaining) continue;
    remaining -= tokens;
    messages.push(message);
  }
  if (messages.length === 1 && !options.allowUserEvidence) return null;
  return context;
}

// How long a synthesis cut off by its signal may take to hand over what it streamed.
// Finalization aborts a second before the deadline, and the worker allows five more.
export const PARTIAL_GRACE_MS = 300;
// Finish reasons, none yet included, after which a cut-off text is still the model's answer.
const PARTIAL_FINISH_REASONS = new Set<string | undefined>([undefined, "stop", "length"]);
// Endings of a cut-off text: the deadline's abort, or a finish that arrived as it fired.
// "error" is a provider failure, which stays terminal.
const PARTIAL_STOP_REASONS = new Set<string | undefined>(["aborted", "stop", "length"]);

// Untrimmed: a cut-off text's final newline shows that its last line was finished.
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

async function settledWithin<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([pending.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeBudgetEvidence(
  options: SynthesisOptions,
  summarize: typeof completeSimple = completeSimple,
): Promise<string | null> {
  const { engine, policy, signal } = options;
  const startedAt = Date.now();
  const report = (outcome: Omit<CompletionDiagnostic, "stage">) =>
    options.onOutcome?.({
      ...outcome,
      stage: "synthesis",
      durationMs: Date.now() - startedAt,
      maxTokens: options.maxTokens,
    });
  if (signal.aborted) {
    report({ outcome: "aborted" });
    return null;
  }
  const context = synthesisContext(options);
  if (!context) {
    report({ outcome: "no_evidence" });
    return null;
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let response;
  let pending: ReturnType<typeof summarize> | undefined;
  try {
    pending = summarize(engine, options.prepareContext?.(context) ?? context, {
      apiKey: options.apiKey,
      maxTokens: options.maxTokens,
      reasoning:
        policy.synthesisEffort && policy.synthesisEffort !== "none"
          ? (policy.synthesisEffort as "low" | "medium" | "high" | "max")
          : undefined,
      headers: { [PURPOSE_HEADER]: options.purpose ?? "synthesis" },
      maxRetries: 0,
      signal,
      cacheRetention: "none",
    });
    response = await Promise.race([aborted, pending]);
  } catch (error) {
    report({ outcome: signal.aborted ? "aborted" : completionFailure(error) });
    if (isProviderAuthorizationError(error))
      throw new SynthesisAuthorizationError(
        "Provider authorization failed during final synthesis",
      );
    if (/content_filter/i.test(String(error)))
      throw new SynthesisContentFilterError(
        "Provider filtered final synthesis",
      );
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (!response || signal.aborted) {
    // The provider still holds what it streamed before the cut and settles with it once
    // it sees the abort. A provider that ignores the abort delays the fallback by at
    // most PARTIAL_GRACE_MS.
    const cut = options.onPartial && pending
      ? (response ?? (await settledWithin(pending, PARTIAL_GRACE_MS)))
      : null;
    // The abort replaces stopReason, but a finish reason that already arrived stays: text
    // a content filter, a provider failure or any other unexpected ending stopped is never
    // an answer.
    const partial =
      PARTIAL_STOP_REASONS.has(cut?.stopReason) && PARTIAL_FINISH_REASONS.has(cut?.rawStopReason)
        ? messageText(cut)
        : "";
    const written = partial.trim().length;
    report({ outcome: "aborted", ...(written ? { textCharacters: written } : {}) });
    if (written) options.onPartial?.(partial);
    return null;
  }
  const outcome = providerCompletion(response);
  if (response.stopReason === "toolUse") outcome.outcome = "provider_error";
  report(outcome);
  if (isProviderAuthorizationError(response.errorMessage)) {
    throw new SynthesisAuthorizationError(
      "Provider authorization failed during final synthesis",
    );
  }
  if (/content_filter/i.test(response.errorMessage ?? ""))
    throw new SynthesisContentFilterError("Provider filtered final synthesis");
  // Hidden reasoning used the rest of the output allowance: what was written is
  // unfinished, but its finished lines can still answer (incident 01a1d9d0).
  if (response.stopReason === "length" && messageText(response).trim())
    options.onPartial?.(messageText(response), true);
  if (response.stopReason !== "stop") return null;
  return messageText(response).trim() || null;
}
