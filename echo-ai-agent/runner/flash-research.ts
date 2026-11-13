import { Type, type Static } from "typebox";
import { defineTool, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai/compat";
import { citationHref, type MessageCitation } from "./citations.ts";
import { fileCitationHref, type FileCitation } from "./devices.ts";
import {
  BUDGET_INABILITY,
  synthesizeBudgetEvidence,
  SynthesisAuthorizationError,
  SynthesisContentFilterError,
  completionFailure,
  providerCompletion,
  type CompletionDiagnostic,
  type CompletionStatus,
  type ExecutionPolicy,
  type ResearchBudget,
} from "./execution-policy.ts";
import type { GroupOutcome } from "./group-scope.ts";
import type { WorkJournal } from "./work-memory.ts";

export const FLASH_ENGINE = "glm-5.3-flash-uncensored";
export const RESEARCH_TOOL_NAME = "update_research";
export const FLASH_RESEARCH_UPDATE_REQUIRED =
  "Call update_research before further retrieval";
export const FLASH_RESEARCH_PAGINATION_REQUIRED =
  "After the initial sample, use focused searches. Before continuing pagination, save the specific coverage requirement in update_research.paginationReason.";
// Hidden thinking counts against this: 8,192 ran out on Flash even for a 500-word retry.
export const FLASH_SYNTHESIS_TOKENS = 16_384;
export const FLASH_INABILITY = BUDGET_INABILITY;
// Coverage stayed incomplete although no budget limit stopped the research.
export const RESEARCH_INCOMPLETE_REASON = "incomplete_research";
// Re-prompts when research stops with work it declared unfinished. Deep has the budget
// to insist; the others usually have time for one.
export const RESEARCH_CONTINUATIONS = 1;
export const DEEP_RESEARCH_CONTINUATIONS = 3;
const DEEP_SEARCH_PROMPT =
  "Deep mode was requested, but no tool has run. Search Echo before answering from general knowledge: a word with an everyday meaning may be a callsign, a unit or a term from the reports. Only reformatting or translating earlier text, or a task answerable entirely from text, files or images the user supplied, needs no tool; in that case finish with a brief completion message.";
const FAILED_START_PROMPT =
  "The previous attempt failed before any work was done. Answer the user's request above now, starting with the tools it needs.";
export const FLASH_LEGACY_POLICY: ExecutionPolicy = {
  preset: "balanced",
  api: "openai-completions",
  reasoningEffort: null,
  checkpointEffort: null,
  synthesisEffort: null,
  maxRuntimeSeconds: 600,
  finalizationSeconds: 120,
};
const REFRESH_RETRIEVALS = 4;
const CHECKLIST_ITEMS = 4;
const TASK_CHARACTERS = 100;
const GAPS = 4;
const GAP_CHARACTERS = 160;
const DRAFT_CHARACTERS = 8000;
const PAGINATION_REASON_CHARACTERS = 200;
const LISTED_LINKS = 30;
const LISTED_INVALID_LINKS = 10;
const TURN_MARGIN_MS = 1000;
const WARNING_MS = 10_000;
const CURSOR_KEYS = [
  "cursor",
  "before_id_noninclusive",
  "after_unit_id",
  "after",
  "offset",
  "afterId",
  "afterSectionId",
  "beforeRequestId",
];

// Mirrors AI_AGENT_OPENAI_MODEL_PREFIXES in wdintel-rs/src/config.rs.
const OPENAI_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"];

export function isOpenAiModel(modelName: string): boolean {
  return OPENAI_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

// Flash always uses the bounded research harness. Any other non-OpenAI engine (GLM,
// Gemma) uses it when reasoning presets give the request a budget; without a budget
// there is nothing to bound. OpenAI engines keep the generic path.
export function usesBoundedResearch(
  modelName: string,
  executionPolicy?: ExecutionPolicy,
): boolean {
  return (
    modelName === FLASH_ENGINE ||
    (!isOpenAiModel(modelName) && executionPolicy !== undefined)
  );
}

// Flash and the other non-OpenAI engines reserve twice the base finalization time.
// Non-Flash engines also accept the base reserve so policies snapshotted before it
// was raised (queued or running requests) still validate during a rollout.
export function finalizationMultipliers(modelName: string): readonly number[] {
  if (modelName === FLASH_ENGINE) return [2];
  return isOpenAiModel(modelName) ? [1] : [1, 2];
}

export interface ResearchTuning {
  // Pages of one search read before continuing needs paginationReason.
  searchedPageLimit?: number;
  // Expected duration of a context checkpoint before one has been observed.
  checkpointPriorMs?: number;
}

// A single search was paged 22 times (440 records) on glm-5.3 before its deadline, and
// context compaction began with less research time left than it needed.
export const RESEARCH_TUNING: ResearchTuning = {
  searchedPageLimit: 3,
  checkpointPriorMs: 60_000,
};

export const FLASH_GUIDANCE = `Start working in your first turn: when the request needs Echo data, run the first retrieval right away, without announcing it first. Never end a turn with a plan, a promise or a progress note while work remains; call the tool in that same turn. update_research is not needed before retrieval. A name or unfamiliar word may be a callsign, a unit or a term from the reports even when it has an everyday meaning: search Echo for it before answering from general knowledge. Save task status and factual findings only, never hidden reasoning or deliberation. For a broad summary, read one initial sample, then use focused searches for substantive reports and the subjects actually found. Reassess coverage after the searches. Do not continue unfiltered pagination, or read more than three pages of one search, without recording a concrete coverage need in paginationReason or refining the search; explicit exhaustive requests may continue pagination. A cited partial answer with a stated coverage gap is better than none. A sample of the newest messages does not represent the whole reporting period. Choose searches from the user's scope and observed evidence, reassess their usefulness after results arrive, and adjust them when they add little evidence. Preserve all scope, permission, citation and search-semantics rules, including separate required search paths. Explicit exhaustive requests still require pagination; report incomplete coverage honestly when unfinished. Refresh update_research with a concise cited answer draft and remaining coverage gaps between tool batches after four retrieval calls, and before finishing research. An admitted batch may finish before this refresh; when it is due, the next turn requires update_research before retrieval resumes. Actual queries and continuation cursors are tracked automatically. For formatting, translation, or regrouping of the previous answer, reuse that answer and its citations without retrieval or rereading the work journal. Reuse relevant compact saved findings in other follow-ups and fetch only detailed records needed for a new factual question. Private budget status is supplied before each provider turn: when warned, save the supported draft and finish. Keep tool arguments, the checklist, research narration and budget details out of the answer. Send report_progress together with another tool call in the same turn, never as a turn of its own. Keep the answer readable: headings for requested groups, short cited bullets, and one brief coverage qualification when needed. Concise does not mean a single paragraph. When the user asks for a document, saving it with echo_document_script is part of research: save it before the final update_research, because the tool-free synthesis cannot create files; when the budget warning arrives before it is saved, save it now from the evidence collected so far. After the final update_research, finish research with a brief completion message; the next tool-free synthesis turn writes the full answer. A reply that calls no tool at all is delivered to the user as written: when the request needs no tool, such as reformatting or translating earlier text or applying the user's own instructions to text they supplied, write the complete answer in that reply, following the rules set earlier in the conversation, never a plan or a note.`;

// Limits live in normalizedResearchUpdate, not here: a schema violation costs a whole
// provider turn, and it was the most common failure of this tool in production.
const RESEARCH_PARAMETERS = Type.Object({
  checklist: Type.Optional(
    Type.Array(
      Type.Object({
        task: Type.String(),
        status: Type.String({ description: "pending, done or blocked" }),
      }),
      { description: "Up to four short tasks." },
    ),
  ),
  draft: Type.Optional(
    Type.String({
      description:
        "Complete user-facing Markdown answer, grouped by the requested entities with headings and short bullets. Keep factual detail rather than squeezing all groups into one paragraph. Cite retrieved facts with exact inline source citations; user-provided facts need no invented citation. Empty before supporting evidence exists. No reasoning or research narration.",
    }),
  ),
  paginationReason: Type.Optional(
    Type.String({
      description:
        "Factual coverage requirement for continuing pagination, such as the user explicitly requesting every record. Empty for ordinary broad summaries; use focused searches after the first sample.",
    }),
  ),
  gaps: Type.Optional(
    Type.Array(Type.String(), {
      description: "Up to four short coverage gaps.",
    }),
  ),
});

type ChecklistItem = { task: string; status: "pending" | "done" | "blocked" };
type ResearchUpdate = {
  checklist?: ChecklistItem[];
  draft?: string;
  paginationReason?: string;
  gaps?: string[];
};
type ResearchState = ResearchUpdate & {
  checklist: ChecklistItem[];
  draft: string;
  gaps: string[];
};
type Sources = {
  citations: MessageCitation[];
  fileCitations: FileCitation[];
  links?: string[];
  // False until this request's tools deliver a citable message or file, so an answer
  // built from the user's own text or from aggregate data may cite nothing even if
  // earlier turns of the conversation did.
  citationRequired?: boolean;
};
type Retrieval = {
  tool: string;
  query: unknown;
  continuation: Record<string, unknown>;
};
type CompletedAction = {
  tool: string;
  calls: number;
  failed: number;
  results?: number;
};

const clipped = (value: unknown, limit: number) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

function listOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return [value];
  }
}

function researchStatus(value: unknown): ChecklistItem["status"] {
  const status = clipped(value, 20).toLowerCase();
  if (["done", "complete", "completed", "finished"].includes(status))
    return "done";
  if (["blocked", "failed", "skipped", "cancelled", "canceled"].includes(status))
    return "blocked";
  return "pending";
}

const STATUS_ORDER: Record<ChecklistItem["status"], number> = {
  pending: 0,
  blocked: 1,
  done: 2,
};

function checklistItem(value: unknown): ChecklistItem | undefined {
  const item = (typeof value === "string" ? { task: value } : value) as {
    task?: unknown;
    status?: unknown;
  } | null;
  const task = clipped(item?.task, TASK_CHARACTERS);
  return task ? { task, status: researchStatus(item?.status) } : undefined;
}

function checklistOf(value: unknown): ChecklistItem[] | undefined {
  const items = listOf(value)?.flatMap((item) => checklistItem(item) ?? []);
  if (!items?.length) return undefined;
  // Pending work is what the completion check needs, so it survives the cap.
  return items
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    .slice(0, CHECKLIST_ITEMS);
}

function clippedDraft(text: string): string {
  if (text.length <= DRAFT_CHARACTERS) return text;
  const head = text.slice(0, DRAFT_CHARACTERS);
  // An early newline would drop most of the draft; a space still keeps links whole.
  const line = head.lastIndexOf("\n");
  const cut = line >= DRAFT_CHARACTERS / 2 ? line : head.lastIndexOf(" ");
  return (cut > 0 ? head.slice(0, cut) : head).trimEnd();
}

/** Accepts whatever shape a model sends rather than failing the turn over it. */
export function normalizedResearchUpdate(value: unknown): ResearchUpdate {
  const { checklist, draft, paginationReason, gaps } = (value ?? {}) as Record<
    string,
    unknown
  >;
  const reason = clipped(paginationReason, PAGINATION_REASON_CHARACTERS);
  return {
    checklist: checklistOf(checklist),
    draft: typeof draft === "string" ? clippedDraft(draft) : undefined,
    ...(reason ? { paginationReason: reason } : {}),
    gaps: listOf(gaps)
      ?.map((gap) => clipped(gap, GAP_CHARACTERS))
      .filter(Boolean)
      .slice(0, GAPS),
  };
}

const markdownLinks = (text: string) =>
  [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map((match) => match[1]);

type AnswerIssue = NonNullable<CompletionDiagnostic["draftIssue"]>;

const ANSWER_ISSUES: Record<AnswerIssue, string> = {
  no_citation: "it cites none of the available sources.",
  unknown_link: "it links to something no tool returned.",
  bare_link: "it contains a source link outside Markdown link syntax.",
};

function answerIssue(text: string, sources: Sources): AnswerIssue | undefined {
  const allowed = new Set([
    ...sources.citations.map(citationHref),
    ...sources.fileCitations.map(fileCitationHref),
  ]);
  const links = markdownLinks(text);
  if (
    allowed.size &&
    sources.citationRequired !== false &&
    !links.some((href) => allowed.has(href))
  )
    return "no_citation";
  if (
    links.some((href) => !allowed.has(href) && !sources.links?.includes(href))
  )
    return "unknown_link";
  // Reject bare or malformed source links as well as invented Markdown links.
  const withoutLinks = text.replace(/\[[^\]]*\]\([^\s)]+\)/g, "");
  return /\/rer-analysis-neo\?|\/api\/.*(?:file|attachment)|https?:\/\//i.test(
    withoutLinks,
  )
    ? "bare_link"
    : undefined;
}

/**
 * The part of a cut-off answer that was finished: its last line may stop mid-sentence
 * or mid-link, and a trailing heading would introduce nothing.
 */
export function completedLines(text: string): string {
  const lines = text.split("\n").slice(0, -1);
  while (lines.length && (!lines.at(-1)!.trim() || /^\s*#{1,6}\s/.test(lines.at(-1)!)))
    lines.pop();
  return lines.join("\n").trimEnd();
}

export function validatedFlashAnswer(
  text: string | null,
  sources: Sources,
): string | undefined {
  if (!text?.trim() || answerIssue(text, sources)) return undefined;
  return text.trim();
}

/** Tokens the final synthesis may use. Deep gets all the engine allows. */
export function synthesisTokenLimit(
  policy: ExecutionPolicy,
  maxTokens: number,
): number {
  return policy.preset === "deep"
    ? maxTokens
    : Math.min(FLASH_SYNTHESIS_TOKENS, maxTokens);
}

export function continuationLimit(policy: ExecutionPolicy): number {
  return policy.preset === "deep"
    ? DEEP_RESEARCH_CONTINUATIONS
    : RESEARCH_CONTINUATIONS;
}

function continuation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      /^(nextCursor|next_cursor|nextAfter|nextOffset|nextBeforeRequestId|hasMore|has_more)$/.test(
        key,
      ),
    ),
  );
}

function resultCount(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const lists = Object.values(response).filter(Array.isArray);
  return lists.length
    ? Math.max(...lists.map((list) => list.length))
    : undefined;
}

function retrievalKey(tool: string, query: unknown): string {
  const scope =
    query && typeof query === "object"
      ? Object.fromEntries(
          Object.entries(query)
            .filter(([key]) => !CURSOR_KEYS.includes(key))
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : query;
  return `${tool}:${JSON.stringify(scope)}`;
}

export class FlashResearch {
  private state?: ResearchState;
  private draft?: string;
  private retrievals = 0;
  private toolRunsAtProgress?: number;
  private publicToolRuns = 0;
  private startFailed = false;
  // The gateway answered a call before the first tool with a cooldown (429): no
  // deployment of the model was ready, and pi's retries already waited it out.
  private startCooldown = false;
  private readonly groupProblems = new Set<string>();
  private readonly groupsRead = new Set<string>();
  private readonly actions = new Map<string, CompletedAction>();
  private retrievalBatchAllowed = true;
  private paginationUpdateRequired = false;
  private readonly ledger: Retrieval[] = [];
  private readonly unread = new Map<string, boolean>();
  private observedMs = new Map<string, number>();
  private researchStartedAt?: number;
  // The longest validated part of a synthesis the finalization deadline cut off.
  private partial?: string;
  private readonly sources: () => Sources;
  private readonly journal?: WorkJournal;
  private readonly diagnostic: (event: CompletionDiagnostic) => void;
  private readonly tuning: ResearchTuning;
  usedFallback = false;
  /** The answer is the finished part of a synthesis cut off by the deadline. */
  usedPartial = false;

  constructor(
    sources: () => Sources,
    journal?: WorkJournal,
    diagnostic: (event: CompletionDiagnostic) => void = () => {},
    tuning: ResearchTuning = {},
  ) {
    this.sources = sources;
    this.journal = journal;
    this.diagnostic = diagnostic;
    this.tuning = tuning;
  }

  tool(countInvocation: () => void) {
    return defineTool({
      name: RESEARCH_TOOL_NAME,
      label: "Private research state",
      description:
        "Save a short task checklist, cited factual answer draft and coverage gaps. Not needed before the first retrieval; required between tool batches after four retrieval calls. Do not supply reasoning, deliberation, queries or cursors. This state is private; report_progress is for public status.",
      parameters: RESEARCH_PARAMETERS,
      executionMode: "sequential",
      prepareArguments: (args: unknown) => normalizedResearchUpdate(args) as any,
      execute: async (_id, update: ResearchUpdate) => {
        countInvocation();
        const candidate = update.draft ?? "";
        const draft = validatedFlashAnswer(candidate, this.sources());
        const issue =
          candidate.trim() && !draft
            ? answerIssue(candidate, this.sources())
            : undefined;
        if (issue)
          this.diagnostic({
            stage: "research",
            outcome: "citation_rejected",
            draftIssue: issue,
          });
        const saved: ResearchState = {
          ...update,
          checklist: update.checklist ?? this.state?.checklist ?? [],
          gaps: update.gaps ?? this.state?.gaps ?? [],
          draft: draft ?? this.draft ?? "",
        };
        const content = this.serialize(saved);
        await this.journal?.checkpoint(content);
        this.state = saved;
        if (draft) this.draft = draft;
        this.retrievals = 0;
        this.retrievalBatchAllowed = true;
        this.paginationUpdateRequired = false;
        const text = issue
          ? this.rejectedDraftNotice(candidate, issue)
          : "Research state saved privately.";
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  get updateRequired(): boolean {
    return this.paginationUpdateRequired || this.retrievals >= REFRESH_RETRIEVALS;
  }

  beforeRetrieval(tool?: string, query?: Record<string, unknown>): void {
    if (!this.retrievalBatchAllowed)
      throw new Error(FLASH_RESEARCH_UPDATE_REQUIRED);
    if (
      this.paginationNeedsReason(tool, query) &&
      !this.state?.paginationReason?.trim()
    ) {
      this.paginationUpdateRequired = true;
      throw new Error(FLASH_RESEARCH_PAGINATION_REQUIRED);
    }
    this.retrievals += 1;
  }

  private paginationNeedsReason(
    tool?: string,
    query?: Record<string, unknown>,
  ): boolean {
    if (tool !== "inbox_messages" || query?.before_id_noninclusive == null)
      return false;
    const focused =
      query.search ||
      query.selected_freqs ||
      (Array.isArray(query.selected_groups) && query.selected_groups.length > 0);
    if (!focused) return true;
    const limit = this.tuning.searchedPageLimit;
    if (limit === undefined) return false;
    const scope = retrievalKey(`echo_${tool}`, query);
    return (
      this.ledger.filter((entry) => retrievalKey(entry.tool, entry.query) === scope)
        .length >= limit
    );
  }

  record(tool: string, query: unknown, response: unknown): void {
    const next = continuation(response);
    this.ledger.push({ tool, query, continuation: next });
    const results = resultCount(response);
    if (results !== undefined) {
      const action = this.action(tool);
      action.results = (action.results ?? 0) + results;
    }
    this.unread.set(
      retrievalKey(tool, query),
      Object.entries(next).some(
        ([key, value]) =>
          key !== "nextOffset" &&
          value !== null &&
          value !== false &&
          value !== undefined,
      ),
    );
  }

  private serialize(state: ResearchState): string {
    return JSON.stringify({ research: state, retrievals: this.ledger });
  }

  checkpoint(summary: string): string {
    return this.state
      ? `${this.serialize(this.state)}\nEvidence checkpoint:\n${summary}`
      : summary;
  }

  compactEvidence(): string | undefined {
    return this.state
      ? JSON.stringify({ draft: this.state.draft, gaps: this.state.gaps })
      : undefined;
  }

  fallback(): string {
    return (
      validatedFlashAnswer(this.draft ?? null, this.sources()) ??
      FLASH_INABILITY
    );
  }

  /** Research that called no tool wrote the answer itself, from the whole conversation. */
  directAnswer(text: string, budget: ResearchBudget): string | undefined {
    const answer = validatedFlashAnswer(text, this.sources());
    if (answer)
      this.diagnostic({
        stage: "answer",
        outcome: "research_text",
        textCharacters: answer.length,
        remainingMs: budget.remainingFinalizationMs(),
      });
    return answer;
  }

  /**
   * Research that wrote the cited answer after its tools already did synthesis's work;
   * rewriting it would spend the time left on the same evidence (incident 01a1d04a).
   * Only a report longer than any draft counts: a shorter text may be the completion
   * note research ends with, and the draft or synthesis covers it. It must cite a source
   * this request's tools returned, so an answer repeated from history is not one.
   */
  researchReport(
    text: string,
    budget: ResearchBudget,
    retrieved: ReadonlySet<string>,
  ): string | undefined {
    return text.trim().length > DRAFT_CHARACTERS &&
      markdownLinks(text).some((href) => retrieved.has(href))
      ? this.directAnswer(text, budget)
      : undefined;
  }

  hasGaps(): boolean {
    return (
      (this.state
        ? this.state.gaps.length > 0 ||
          this.state.checklist.some((item) => item.status !== "done")
        : this.hasUnfinishedWork) || [...this.unread.values()].some(Boolean)
    );
  }

  noteProgress(): void {
    this.toolRunsAtProgress = this.publicToolRuns;
  }

  noteToolRun(): void {
    this.publicToolRuns += 1;
  }

  noteGroups({ problems = [], read = [] }: GroupOutcome): void {
    for (const problem of problems) this.groupProblems.add(problem);
    for (const name of read) this.groupsRead.add(name);
  }

  // Tool-free synthesis would otherwise see only a failed call, not that the
  // group the user named does not exist, or which group an empty read covered.
  groupScope(): { groupProblems: string[]; groupsRead: string[] } {
    return { groupProblems: [...this.groupProblems], groupsRead: [...this.groupsRead] };
  }

  private action(tool: string): CompletedAction {
    const action = this.actions.get(tool) ?? { tool, calls: 0, failed: 0 };
    this.actions.set(tool, action);
    return action;
  }

  noteToolResult(tool: string, failed: boolean): void {
    const action = this.action(tool);
    action.calls += 1;
    if (failed) action.failed += 1;
  }

  // Tool-free synthesis sees only delivered evidence, so without this record it cannot
  // tell a search that found nothing, or a published map, from work that never ran.
  completedActions(): CompletedAction[] {
    return [...this.actions.values()];
  }

  get toolRunCount(): number {
    return this.publicToolRuns;
  }

  private get pendingTasks(): string[] {
    return (this.state?.checklist ?? [])
      .filter((item) => item.status === "pending")
      .map((item) => item.task);
  }

  get hasPendingTasks(): boolean {
    return this.pendingTasks.length > 0;
  }

  // Work the answer must not pass off as done. A note after real work earns a re-prompt
  // but not this label: models also announce the final summary that way.
  get hasUnfinishedWork(): boolean {
    return (
      this.hasPendingTasks ||
      (!this.state && this.publicToolRuns === 0 && this.toolRunsAtProgress === 0)
    );
  }

  // With saved state the checklist decides. Without it, the one sign of unfinished work
  // is a public promise of progress that no tool call followed.
  private get unfinished(): boolean {
    return this.state
      ? this.hasPendingTasks
      : this.toolRunsAtProgress === this.publicToolRuns;
  }

  // Deep was asked for more effort, so it must not simply end on an answer from memory.
  // A provider failure before the first tool call loses no work, so one more
  // attempt beats telling the user to repeat the request. Not after a cooldown: the
  // gateway had no deployment of the model, and another attempt only waits out
  // another one (incident 01a1d35e).
  noteFailedStart(message?: { stopReason?: unknown; errorMessage?: unknown }): boolean {
    const failure = completionFailure(message?.errorMessage);
    this.startFailed =
      message?.stopReason === "error" &&
      this.publicToolRuns === 0 &&
      !this.startCooldown &&
      (failure === "provider_error" || failure === "transient_error");
    return this.startFailed;
  }

  /** No tool ran and research saved nothing, so synthesis would have no evidence of its own. */
  get gatheredNothing(): boolean {
    return this.publicToolRuns === 0 && this.retrievals === 0 && !this.state && !this.draft;
  }

  private get failedStart(): boolean {
    return this.startFailed && this.publicToolRuns === 0;
  }

  shouldContinue(budget: ResearchBudget): boolean {
    const skippedTools =
      budget.policy.preset === "deep" && this.publicToolRuns === 0;
    return (
      (this.unfinished || skippedTools || this.failedStart) &&
      budget.remainingResearchMs() >
        Math.max(0, ...this.observedMs.values()) + TURN_MARGIN_MS
    );
  }

  continuationPrompt(): string {
    if (this.failedStart) return FAILED_START_PROMPT;
    const pending = this.pendingTasks;
    if (!pending.length && !this.unfinished) return DEEP_SEARCH_PROMPT;
    const reason = pending.length
      ? `these tasks are still pending: ${JSON.stringify(pending)}`
      : "you announced work but ran no tool";
    return `The work is not finished: ${reason}. Do the remaining work now by calling the tools it needs; a text reply does not do it. If a task cannot be done or needs no tool, mark it done or blocked with update_research, then finish with a brief completion message.`;
  }

  completed(purpose: string, durationMs: number): void {
    this.observedMs.set(
      purpose,
      Math.max(durationMs, this.observedMs.get(purpose) ?? 0),
    );
  }

  researchCompleted(message?: unknown, budget?: ResearchBudget): void {
    if (this.researchStartedAt === undefined) return;
    const durationMs = Date.now() - this.researchStartedAt;
    this.completed("research", durationMs);
    const completion = providerCompletion(message);
    if (completion.failureKind === "rate_limit" && this.publicToolRuns === 0)
      this.startCooldown = true;
    this.diagnostic({
      stage: "research",
      ...completion,
      durationMs,
      remainingMs: budget?.remainingTotalMs(),
    });
    this.researchStartedAt = undefined;
  }

  // The refresh only protects against a failed synthesis, and it costs research-effort
  // turns: minutes on GLM-5.3. A short answer is not worth that, and synthesis has its evidence.
  shouldRefreshDraft(budget: ResearchBudget): boolean {
    return (
      this.retrievals > 0 &&
      this.ledger.length >= REFRESH_RETRIEVALS &&
      budget.remainingResearchMs() >
        2 * Math.max(0, ...this.observedMs.values()) + TURN_MARGIN_MS
    );
  }

  async complete(
    options: Parameters<typeof synthesizeBudgetEvidence>[0],
    budget: ResearchBudget,
  ): Promise<string> {
    let correction = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.synthesisAttempt(
        { ...options, systemPrompt: options.systemPrompt + correction },
        budget,
        attempt,
      );
      if (result.answer && !options.signal.aborted) {
        this.diagnostic({
          stage: "answer",
          outcome: "complete",
          attempt,
          textCharacters: result.answer.length,
        });
        return result.answer;
      }
      if (
        attempt === 2 ||
        options.signal.aborted ||
        budget.remainingFinalizationMs() <=
          result.durationMs * 1.25 + TURN_MARGIN_MS ||
        ![
          "output_limit",
          "empty",
          "transient_error",
          "citation_rejected",
        ].includes(result.outcome)
      )
        break;
      correction = this.correctionInstructions(result.outcome);
    }
    this.usedFallback = true;
    const draft = this.fallback();
    // Either is validated; the longer one keeps more of the cited findings.
    this.usedPartial = Boolean(
      this.partial &&
        (draft === FLASH_INABILITY || this.partial.length > draft.length),
    );
    const answer = this.usedPartial ? this.partial! : draft;
    this.diagnostic({
      stage: "answer",
      outcome: this.usedPartial
        ? "partial"
        : answer === FLASH_INABILITY
          ? "inability"
          : "fallback",
      textCharacters: answer.length,
      remainingMs: budget.remainingFinalizationMs(),
    });
    return answer;
  }

  private notePartial(text: string): void {
    const answer = validatedFlashAnswer(completedLines(text), this.sources());
    if (answer && answer.length > (this.partial?.length ?? 0))
      this.partial = answer;
  }

  private async synthesisAttempt(
    options: Parameters<typeof synthesizeBudgetEvidence>[0],
    budget: ResearchBudget,
    attempt: number,
  ): Promise<{
    answer?: string;
    outcome: CompletionStatus;
    durationMs: number;
  }> {
    let outcome: CompletionStatus = "provider_error";
    let durationMs = 0;
    const candidate = await synthesizeBudgetEvidence({
      ...options,
      onPartial: (text) => this.notePartial(text),
      onOutcome: (event) => {
        outcome = event.outcome as CompletionStatus;
        durationMs = event.durationMs ?? 0;
        this.diagnostic({
          ...event,
          attempt,
          remainingMs: budget.remainingFinalizationMs(),
        });
      },
    }).catch((error) => {
      if (
        error instanceof SynthesisAuthorizationError ||
        error instanceof SynthesisContentFilterError
      )
        throw error;
      return null;
    });
    const answer = validatedFlashAnswer(candidate, this.sources());
    if (candidate && !answer) {
      outcome = "citation_rejected";
      const draftIssue = answerIssue(candidate, this.sources());
      this.diagnostic({
        stage: "synthesis",
        outcome,
        ...(draftIssue ? { draftIssue } : {}),
        attempt,
        durationMs,
        remainingMs: budget.remainingFinalizationMs(),
      });
    }
    return { answer, outcome, durationMs };
  }

  private correctionInstructions(outcome: CompletionStatus): string {
    return outcome === "citation_rejected"
      ? `\nThe previous synthesis did not pass citation validation. Write the answer again using only these exact source and registered artifact links: ${JSON.stringify(this.allowedLinks())}. Keep citations beside each supported claim; do not invent URLs.`
      : "\nThe previous synthesis did not complete. Produce a complete shorter answer now, at most 500 words, with headings and cited bullets. Include only the most relevant supported findings; omit preamble and research narration.";
  }

  private rejectedDraftNotice(draft: string, issue: AnswerIssue): string {
    const allowed = this.allowedLinks();
    const invalid = markdownLinks(draft)
      .filter((href) => !allowed.includes(href))
      .slice(0, LISTED_INVALID_LINKS);
    const listing = invalid.length
      ? ` Invalid links: ${JSON.stringify(invalid)}.`
      : "";
    return `Checklist and gaps saved, but not the draft: ${ANSWER_ISSUES[issue]}${listing} Available links include: ${JSON.stringify(allowed.slice(-LISTED_LINKS))}. Continue the work and correct the draft in the next update.`;
  }

  private allowedLinks(): string[] {
    const sources = this.sources();
    return [
      ...sources.citations.map(citationHref),
      ...sources.fileCitations.map(fileCitationHref),
      ...(sources.links ?? []),
    ];
  }

  beforeProvider(
    purpose: string,
    context: Context,
    budget: ResearchBudget | undefined,
    toolRemaining: number,
    contextWindow: number,
    outputTokens: number,
  ): Context {
    if (purpose === "research")
      this.retrievalBatchAllowed = !this.updateRequired;
    const expectedMs =
      this.observedMs.get(purpose) ??
      Math.max(
        purpose === "checkpoint" ? (this.tuning.checkpointPriorMs ?? 0) : 0,
        ...this.observedMs.values(),
      );
    if (purpose !== "synthesis" && budget) {
      if (toolRemaining <= 0) budget.limit("tool_limit");
      // Stopping before anything was retrieved guarantees a useless answer, while a turn
      // cut off by the research deadline costs nothing: the synthesis reserve stays intact.
      const skippable = purpose !== "research" || this.ledger.length > 0;
      if (
        skippable &&
        budget.remainingResearchMs() <= expectedMs + TURN_MARGIN_MS
      )
        budget.limit("time_limit");
      budget.assertResearch();
    }
    const headroom = Math.max(
      0,
      contextWindow -
        outputTokens -
        Math.ceil(context.systemPrompt.length / 3) -
        context.messages.reduce(
          (total, message) => total + estimateTokens(message),
          0,
        ) -
        Math.ceil(JSON.stringify(context.tools ?? []).length / 3) -
        1024,
    );
    const remainingMs = budget?.remainingResearchMs();
    const status = {
      researchSeconds:
        remainingMs === undefined ? null : Math.floor(remainingMs / 1000),
      totalSeconds: budget
        ? Math.floor(budget.remainingTotalMs() / 1000)
        : null,
      toolRemaining,
      estimatedContextHeadroomTokens: headroom,
      updateRequired: this.updateRequired,
      paginationUpdateRequired: this.paginationUpdateRequired,
      warning:
        remainingMs !== undefined &&
        remainingMs <= Math.max(WARNING_MS, expectedMs * 2 + TURN_MARGIN_MS)
          ? "Research time is nearly spent. Save the cited draft and finish now."
          : null,
    };
    if (purpose === "research") this.researchStartedAt = Date.now();
    return {
      ...context,
      tools:
        purpose === "research" && this.updateRequired
          ? context.tools?.filter((tool) => tool.name === RESEARCH_TOOL_NAME)
          : context.tools,
      systemPrompt: `${context.systemPrompt}\nPrivate budget status (never quote in the answer): ${JSON.stringify(status)}`,
    };
  }
}
