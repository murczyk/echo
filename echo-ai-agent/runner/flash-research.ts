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
  providerCompletion,
  type CompletionDiagnostic,
  type CompletionStatus,
  type ExecutionPolicy,
  type ResearchBudget,
} from "./execution-policy.ts";
import type { WorkJournal } from "./work-memory.ts";

export const FLASH_ENGINE = "glm-5.3-flash-uncensored";
export const RESEARCH_TOOL_NAME = "update_research";
export const FLASH_RESEARCH_UPDATE_REQUIRED =
  "Call update_research before further retrieval";
export const FLASH_RESEARCH_PAGINATION_REQUIRED =
  "After the initial sample, use focused searches. Before continuing pagination, save the specific coverage requirement in update_research.paginationReason.";
export const FLASH_SYNTHESIS_TOKENS = 8192;
export const FLASH_INABILITY = BUDGET_INABILITY;
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

export const FLASH_GUIDANCE = `Before retrieval, call update_research with a short task checklist. Save task status and factual findings only, never hidden reasoning or deliberation. For a broad summary, read one initial sample, then use focused searches for substantive reports and the subjects actually found. Reassess coverage after the searches. Do not continue unfiltered pagination, or read more than three pages of one search, without recording a concrete coverage need in paginationReason or refining the search; explicit exhaustive requests may continue pagination. A cited partial answer with a stated coverage gap is better than none. A sample of the newest messages does not represent the whole reporting period. Choose searches from the user's scope and observed evidence, reassess their usefulness after results arrive, and adjust them when they add little evidence. Preserve all scope, permission, citation and search-semantics rules, including separate required search paths. Explicit exhaustive requests still require pagination; report incomplete coverage honestly when unfinished. Refresh update_research with a concise cited answer draft and remaining coverage gaps between tool batches after four retrieval calls, and before finishing research. An admitted batch may finish before this refresh; when it is due, the next turn requires update_research before retrieval resumes. Actual queries and continuation cursors are tracked automatically. For formatting, translation, or regrouping of the previous answer, reuse that answer and its citations without retrieval or rereading the work journal. Reuse relevant compact saved findings in other follow-ups and fetch only detailed records needed for a new factual question. Private budget status is supplied before each provider turn: when warned, save the supported draft and finish. Keep tool arguments, the checklist, research narration and budget details out of the answer. Use report_progress for ordinary public progress. Keep the answer readable: headings for requested groups, short cited bullets, and one brief coverage qualification when needed. Concise does not mean a single paragraph. After the final update_research, finish research with a brief completion message; the next tool-free synthesis turn writes the full answer.`;

const RESEARCH_PARAMETERS = Type.Object(
  {
    checklist: Type.Array(
      Type.Object(
        {
          task: Type.String({ minLength: 1, maxLength: 100 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("done"),
            Type.Literal("blocked"),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4 },
    ),
    draft: Type.String({
      maxLength: 8000,
      description:
        "Complete user-facing Markdown answer, grouped by the requested entities with headings and short bullets. Keep factual detail rather than squeezing all groups into one paragraph. Cite retrieved facts with exact inline source citations; user-provided facts need no invented citation. Empty before supporting evidence exists. No reasoning or research narration.",
    }),
    paginationReason: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          "Factual coverage requirement for continuing pagination, such as the user explicitly requesting every record. Empty for ordinary broad summaries; use focused searches after the first sample.",
      }),
    ),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      maxItems: 4,
    }),
  },
  { additionalProperties: false },
);

type ResearchUpdate = Static<typeof RESEARCH_PARAMETERS>;
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

export function validatedFlashAnswer(
  text: string | null,
  sources: Sources,
): string | undefined {
  if (!text?.trim()) return undefined;
  const allowed = new Set([
    ...sources.citations.map(citationHref),
    ...sources.fileCitations.map(fileCitationHref),
  ]);
  const links = [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(
    (match) => match[1],
  );
  if (
    allowed.size &&
    sources.citationRequired !== false &&
    !links.some((href) => allowed.has(href))
  )
    return undefined;
  if (
    links.some((href) => !allowed.has(href) && !sources.links?.includes(href))
  )
    return undefined;
  // Reject bare or malformed source links as well as invented Markdown links.
  const withoutLinks = text.replace(/\[[^\]]*\]\([^\s)]+\)/g, "");
  if (
    /\/rer-analysis-neo\?|\/api\/.*(?:file|attachment)|https?:\/\//i.test(
      withoutLinks,
    )
  )
    return undefined;
  return text.trim();
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
  private state?: ResearchUpdate;
  private draft?: string;
  private retrievals = 0;
  private retrievalBatchAllowed = true;
  private paginationUpdateRequired = false;
  private readonly ledger: Retrieval[] = [];
  private readonly unread = new Map<string, boolean>();
  private observedMs = new Map<string, number>();
  private researchStartedAt?: number;
  private readonly sources: () => Sources;
  private readonly journal?: WorkJournal;
  private readonly diagnostic: (event: CompletionDiagnostic) => void;
  private readonly tuning: ResearchTuning;
  usedFallback = false;

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
        "Save a short task checklist, cited factual answer draft and coverage gaps. Required before retrieval and between tool batches after four retrieval calls. Do not supply reasoning, deliberation, queries or cursors. This state is private; report_progress is for public status.",
      parameters: RESEARCH_PARAMETERS,
      executionMode: "sequential",
      execute: async (_id, update) => {
        countInvocation();
        const draft = validatedFlashAnswer(update.draft, this.sources());
        if (update.draft.trim() && !draft)
          throw new Error(
            "Draft must use only available source citations and registered map links",
          );
        const saved = { ...update, draft: draft ?? this.draft ?? "" };
        const content = this.serialize(saved);
        await this.journal?.checkpoint(content);
        this.state = saved;
        if (draft) this.draft = draft;
        this.retrievals = 0;
        this.retrievalBatchAllowed = true;
        this.paginationUpdateRequired = false;
        return {
          content: [{ type: "text", text: "Research state saved privately." }],
          details: {},
        };
      },
    });
  }

  get updateRequired(): boolean {
    return this.paginationUpdateRequired || this.retrievals >= REFRESH_RETRIEVALS;
  }

  beforeRetrieval(tool?: string, query?: Record<string, unknown>): void {
    if (!this.state || !this.retrievalBatchAllowed)
      throw new Error(FLASH_RESEARCH_UPDATE_REQUIRED);
    if (
      this.paginationNeedsReason(tool, query) &&
      !this.state.paginationReason?.trim()
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
    if (!query.search && !query.selected_freqs) return true;
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

  private serialize(state: ResearchUpdate): string {
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

  hasGaps(): boolean {
    return (
      (this.state
        ? this.state.gaps.length > 0 ||
          this.state.checklist.some((item) => item.status !== "done")
        : this.ledger.length > 0) || [...this.unread.values()].some(Boolean)
    );
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
    this.diagnostic({
      stage: "research",
      ...providerCompletion(message),
      durationMs,
      remainingMs: budget?.remainingTotalMs(),
    });
    this.researchStartedAt = undefined;
  }

  shouldRefreshDraft(budget: ResearchBudget): boolean {
    return (
      this.retrievals > 0 &&
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
    const answer = this.fallback();
    this.diagnostic({
      stage: "answer",
      outcome: answer === FLASH_INABILITY ? "inability" : "fallback",
      textCharacters: answer.length,
      remainingMs: budget.remainingFinalizationMs(),
    });
    return answer;
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
      this.diagnostic({
        stage: "synthesis",
        outcome,
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
      if (budget.remainingResearchMs() <= expectedMs + TURN_MARGIN_MS)
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
      updateRequired: !this.state || this.updateRequired,
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
