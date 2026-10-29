import { Type, type Static } from "typebox";
import { defineTool, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai/compat";
import { citationHref, type MessageCitation } from "./citations.ts";
import { fileCitationHref, type FileCitation } from "./devices.ts";
import type { ExecutionPolicy, ResearchBudget } from "./execution-policy.ts";
import type { WorkJournal } from "./work-memory.ts";

export const FLASH_ENGINE = "glm-5.3-flash-uncensored";
export const RESEARCH_TOOL_NAME = "update_research";
export const FLASH_SYNTHESIS_TOKENS = 2048;
export const FLASH_INABILITY =
  "Не вдалося підготувати перевірену відповідь за зібраними джерелами.";
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
const EVIDENCE_CHARACTERS = 1200;

export const FLASH_GUIDANCE = `Before retrieval, call update_research with a short task checklist. Save task status and factual findings only, never hidden reasoning or deliberation. For a broad summary, read an initial sample to orient focused searches; do not automatically page through the entire dataset. Choose searches from the user's scope and observed evidence, reassess their usefulness after results arrive, and adjust them when they add little evidence. Preserve all scope, permission, citation and search-semantics rules, including separate required search paths. Explicit exhaustive requests still require pagination; report incomplete coverage honestly when unfinished. Refresh update_research with a concise cited answer draft and remaining coverage gaps after at most four retrieval calls, and before finishing research. Actual queries and continuation cursors are tracked automatically. Reuse relevant compact saved findings in follow-ups and fetch detailed saved records only when needed. Private budget status is supplied before each provider turn: when warned, save the supported draft and finish. Keep tool arguments, the checklist, research narration and budget details out of the answer. Use report_progress for ordinary public progress. Answer concisely with inline citations and a brief coverage qualification when needed.`;

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
      maxLength: 2000,
      description:
        "Concise user-facing factual answer. Cite retrieved facts with exact inline source citations; user-provided facts need no invented citation. Empty before supporting evidence exists. No reasoning or research narration.",
    }),
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
  if (allowed.size && !links.some((href) => allowed.has(href)))
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

export class FlashResearch {
  private state?: ResearchUpdate;
  private draft?: string;
  private retrievals = 0;
  private readonly ledger: Retrieval[] = [];
  private readonly unread = new Map<string, boolean>();
  private observedMs = new Map<string, number>();
  private researchStartedAt?: number;
  private readonly sources: () => Sources;
  private readonly journal?: WorkJournal;

  constructor(sources: () => Sources, journal?: WorkJournal) {
    this.sources = sources;
    this.journal = journal;
  }

  tool(countInvocation: () => void) {
    return defineTool({
      name: RESEARCH_TOOL_NAME,
      label: "Private research state",
      description:
        "Save a short task checklist, cited factual answer draft and coverage gaps. Required before retrieval and after at most four retrieval calls. Do not supply reasoning, deliberation, queries or cursors. This state is private; report_progress is for public status.",
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
        return {
          content: [{ type: "text", text: "Research state saved privately." }],
          details: {},
        };
      },
    });
  }

  beforeRetrieval(): void {
    if (!this.state || this.retrievals >= REFRESH_RETRIEVALS)
      throw new Error("Call update_research before further retrieval");
    this.retrievals += 1;
  }

  record(tool: string, query: unknown, response: unknown): void {
    const next = continuation(response);
    this.ledger.push({ tool, query, continuation: next });
    const scope =
      query && typeof query === "object"
        ? Object.fromEntries(
            Object.entries(query)
              .filter(
                ([key]) =>
                  ![
                    "cursor",
                    "before_id_noninclusive",
                    "after_unit_id",
                    "after",
                    "offset",
                    "afterId",
                    "afterSectionId",
                    "beforeRequestId",
                  ].includes(key),
              )
              .sort(([a], [b]) => a.localeCompare(b)),
          )
        : query;
    this.unread.set(
      `${tool}:${JSON.stringify(scope)}`,
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

  researchCompleted(): void {
    if (this.researchStartedAt === undefined) return;
    this.completed("research", Date.now() - this.researchStartedAt);
    this.researchStartedAt = undefined;
  }

  beforeProvider(
    purpose: string,
    context: Context,
    budget: ResearchBudget | undefined,
    toolRemaining: number,
    contextWindow: number,
    outputTokens: number,
  ): Context {
    const expectedMs =
      this.observedMs.get(purpose) ?? Math.max(0, ...this.observedMs.values());
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
      updateRequired: !this.state || this.retrievals >= REFRESH_RETRIEVALS,
      warning:
        remainingMs !== undefined &&
        remainingMs <= Math.max(WARNING_MS, expectedMs * 2 + TURN_MARGIN_MS)
          ? "Research time is nearly spent. Save the cited draft and finish now."
          : null,
    };
    if (purpose === "research") this.researchStartedAt = Date.now();
    return {
      ...context,
      systemPrompt: `${context.systemPrompt}\nPrivate budget status (never quote in the answer): ${JSON.stringify(status)}`,
    };
  }
}

export function compactFlashEvidence<
  T extends {
    messages: { text: string }[];
    files: { text: string }[];
    saved?: { text: string; citations: string[] }[];
  },
>(evidence: T, state?: string): T {
  return {
    ...evidence,
    messages: evidence.messages.map((message) => ({
      ...message,
      text: message.text.slice(0, EVIDENCE_CHARACTERS),
    })),
    files: evidence.files.map((file) => ({
      ...file,
      text: file.text.slice(0, EVIDENCE_CHARACTERS),
    })),
    saved: state
      ? [
          { text: state, citations: [] },
          ...(evidence.saved ?? []).map((record) => ({
            ...record,
            text: record.text.slice(0, EVIDENCE_CHARACTERS),
          })),
        ]
      : evidence.saved,
  };
}
