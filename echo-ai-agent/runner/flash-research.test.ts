import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { outputRetrySystemPrompt, runAgent, validatePayload, validationFields } from "./runner.ts";
import {
  DEEP_RESEARCH_CONTINUATIONS,
  FlashResearch,
  FLASH_ENGINE,
  FLASH_INABILITY,
  FLASH_RESEARCH_PAGINATION_REQUIRED,
  RESEARCH_CONTINUATIONS,
  RESEARCH_TUNING,
  continuationLimit,
  finalizationMultipliers,
  normalizedResearchUpdate,
  synthesisTokenLimit,
  usesBoundedResearch,
  validatedFlashAnswer,
} from "./flash-research.ts";
import {
  providerCompletion,
  ResearchBudget,
  validateExecutionPolicy,
  type ExecutionPolicy,
} from "./execution-policy.ts";

const correlationId = "019fc7f7-9770-7f83-9c1a-211af29b02e6";
const citation = "/rer-analysis-neo?m=archive-1";
const sources = {
  citations: [{ messageId: 1, messageIdentifier: "archive-1" }],
  fileCitations: [],
};
const draft = `The archive received a botanical survey. [джерело](${citation})`;
const policy: ExecutionPolicy = {
  preset: "fast",
  api: "openai-completions",
  reasoningEffort: null,
  checkpointEffort: null,
  synthesisEffort: null,
  maxRuntimeSeconds: 120,
  finalizationSeconds: 60,
};
// Prod runs the 4-hour budget with hours left; only a real stop may qualify its answer.
const deepPolicy: ExecutionPolicy = {
  ...policy,
  preset: "deep",
  maxRuntimeSeconds: 14_400,
  finalizationSeconds: 600,
};
// A model turn that ends with text and no tool call.
const STOP = { name: "", args: {} };
// A model turn that ends with neither text nor a tool call, as GLM-5.3 does.
const EMPTY = { name: "", args: {} };
// Models that end the request without any evidence to cite.
const NO_EVIDENCE = ["deep-stalled", "deep-promise-only"];
const initial = {
  checklist: [
    { task: "PRIVATE_CHECKLIST: summarize archive records", status: "pending" },
  ],
  draft: "",
  gaps: ["Unread records"],
};
const updated = {
  checklist: [
    { task: "PRIVATE_CHECKLIST: summarize archive records", status: "done" },
  ],
  draft,
  gaps: [],
};
const period = { kind: "relative_days", days: 1 };
const synthesisRequest = (body: any) => JSON.parse(body.messages[1].content);

function stream(
  content: string,
  tool?: { name: string; args: unknown } | { name: string; args: unknown }[],
  stop = "stop",
): Response {
  const chunk = (delta: unknown, finish: string | null) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  });
  const delta = {
    role: "assistant",
    content,
    ...(tool
      ? {
          tool_calls: (Array.isArray(tool) ? tool : [tool]).map(
            (call, index) => ({
              index,
              id: `call_fixture_${index}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            }),
          ),
        }
      : {}),
  };
  return new Response(
    `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? "tool_calls" : stop))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const scenarios = [
  "selective",
  "retry-length",
  "retry-citation",
  "retry-stream",
  "retry-empty",
  "retry-deadline",
  "long-evidence",
  "large-draft",
  "pagination-guard",
  "pagination-recovery",
  "pagination-recovery-rejected",
  "pagination-recovery-persistence-failure",
  "pagination-recovery-api-failure",
  "pagination-recovery-no-memory",
  "pagination-recovery-focused",
  "invalid-arguments",
  "refresh-final",
  "synthesis-cancel",
  "pagination",
  "follow-up",
  "incomplete",
  "no-draft",
  "synthesis-failure",
  "empty-refresh",
  "invalid-synthesis",
  "checkpoint-failure",
  "slow-provider",
  "deadline",
  "tool-limit",
  "cancel",
  "denied",
  "filtered",
  "persistence-failure",
  "no-initial-plan",
  "slow-first-turn",
  "lenient-tools",
  "invalid-progress",
  "continues-once",
  "deep-continues",
  "deep-stalled",
  "deep-promise-only",
  "deep-no-tools",
  "deep-gaps",
  "deep-hard-stop",
  "deep-synthesis-fallback",
  "empty-final-turn",
  "deep-empty-final-turn",
  "refresh-required",
  "batch-refresh",
  "batch-refresh-rejected",
  "batch-refresh-persistence-failure",
  "api-failure",
  "legacy",
  "user-text",
  "user-text-history",
  "history-aggregate",
  "user-map",
];

// Every non-OpenAI engine with a budget runs the same harness as Flash.
for (const [scenario, modelName] of [
  ...scenarios.map((scenario) => [scenario, FLASH_ENGINE] as const),
  ["selective", "glm-5.3"] as const,
  ["selective", "gemma-4"] as const,
]) {
  test(`#3572 Flash harness: ${scenario}${modelName === FLASH_ENGINE ? "" : ` on ${modelName}`}`, async (t) => {
    const events: any[] = [];
    const saved: any[] = [];
    const queries: any[] = [];
    const documents: any[] = [];
    const errors: unknown[] = [];
    const calls: { name: string; args: any }[] = [];
    const recoveringPagination = scenario.startsWith("pagination-recovery");
    const pagination =
      (recoveringPagination && scenario !== "pagination-recovery-focused") ||
      ["pagination", "refresh-required"].includes(scenario)
        ? { paginationReason: "User requested every archive record." }
        : {};
    const plan = () =>
      calls.push({
        name: "update_research",
        args: { ...initial, ...(recoveringPagination ? {} : pagination) },
      });
    const read = (args: any = { period }) =>
      calls.push({ name: "echo_inbox_messages", args });
    const refresh = () =>
      calls.push({
        name: "update_research",
        args:
          scenario === "incomplete"
            ? { ...updated, gaps: ["Earlier records remain unread"] }
            : {
                ...updated,
                ...pagination,
                ...(scenario === "large-draft"
                  ? {
                      draft: `## Archive\n\n- ${"Botanical findings. ".repeat(180)} ${draft}`,
                    }
                  : {}),
              },
      });
    plan();
    calls.push({
      name: "report_progress",
      args: { summary: "Reviewing botanical archive records." },
    });
    if (["user-text", "user-text-history", "user-map"].includes(scenario)) {
      calls.length = 0;
    } else if (scenario === "no-initial-plan") {
      calls.length = 0;
      read();
      refresh();
    } else if (scenario === "slow-first-turn") {
      read();
    } else if (scenario === "lenient-tools") {
      calls.length = 0;
      calls.push({
        name: "update_research",
        args: {
          checklist: [
            { task: "x".repeat(300), status: "in_progress" },
            ...["b", "c", "d", "e"].map((task) => ({ task, status: "done" })),
          ],
          gaps: JSON.stringify(["Unread records"]),
          unexpected: true,
        },
      });
      calls.push({
        name: "report_progress",
        args: { summary: `Reviewing\narchive ${"records ".repeat(60)}` },
      });
      read();
      refresh();
    } else if (scenario === "invalid-progress") {
      calls.push({ name: "report_progress", args: {} });
      read();
      refresh();
    } else if (scenario === "continues-once") {
      calls.push(STOP);
      read();
      calls.push(STOP);
      refresh();
    } else if (scenario === "deep-continues") {
      calls.push(STOP);
      read();
      calls.push(STOP);
      read({ period, search: "botanical survey" });
      refresh();
    } else if (scenario === "deep-stalled") {
      calls.push(STOP, STOP, STOP);
    } else if (scenario === "deep-promise-only") {
      calls.shift();
      calls.push(STOP, STOP, STOP);
    } else if (scenario === "deep-no-tools") {
      calls.length = 0;
      calls.push(STOP);
      read();
      refresh();
    } else if (scenario === "deep-gaps") {
      read();
      calls.push({
        name: "update_research",
        args: { ...updated, gaps: ["Nothing found on the second archive"] },
      });
    } else if (scenario === "deep-hard-stop") {
      read();
      read({ period, search: "botanical survey" });
    } else if (scenario === "deep-synthesis-fallback") {
      read();
      refresh();
    } else if (scenario.endsWith("empty-final-turn")) {
      read();
      refresh();
      calls.push(EMPTY);
    } else if (scenario === "follow-up") {
      refresh();
    } else if (scenario.startsWith("batch-refresh")) {
      for (let index = 0; index < 4; index++)
        read({ period, search: `botanical ${index}` });
      calls.push({
        name: "echo_attachment_get",
        args: { mediaId: correlationId },
      });
      read({ period, search: "after checkpoint" });
      refresh();
    } else if (scenario === "pagination" || scenario === "refresh-required") {
      for (let page = 0; page < 10; page++) {
        read({ period, ...(page ? { cursor: page * 20 } : {}) });
        if ((page + 1) % 4 === 0 && scenario !== "refresh-required") refresh();
        if (page === 4 && scenario === "refresh-required") refresh();
      }
      refresh();
    } else {
      read();
      if (scenario === "pagination-guard") read({ period, cursor: 20 });
      if (recoveringPagination) {
        read({ period, cursor: 20 });
        read(
          scenario === "pagination-recovery-focused"
            ? { period, search: "botanical survey" }
            : { period, cursor: 20 },
        );
      }
      if (scenario === "invalid-arguments")
        read({ period, cursor: "not-a-cursor" });
      if (
        ![
          "no-draft",
          "checkpoint-failure",
          "slow-provider",
          "deadline",
          "cancel",
          "denied",
          "filtered",
          "persistence-failure",
        ].includes(scenario)
      ) {
        if (["selective", "legacy", "api-failure"].includes(scenario))
          read({ period, search: "botanical survey" });
        refresh();
      }
    }
    if (scenario === "refresh-final")
      for (const search of ["late survey", "later survey", "latest survey"])
        read({ period, search });
    if (scenario === "empty-refresh")
      calls.push({ name: "update_research", args: initial });
    if (scenario === "tool-limit") {
      for (let i = 0; i < 130; i++)
        calls.push({
          name: "report_progress",
          args: { summary: "Grouping verified archive records." },
        });
    }
    let mapId = "";
    let researchCalls = 0;
    let synthesisCalls = 0;
    let checkpoints = 0;
    let forcedUpdates = 0;
    let clockOffset = 0;
    let continuations = 0;
    let rejectionNotices = 0;
    let deepSearchPrompts = 0;
    const synthesisBodies: string[] = [];
    const now = Date.now.bind(Date);
    t.mock.method(Date, "now", () => now() + clockOffset);
    const oldSignals = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const write = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, "write", (chunk: string, ...args: any[]) => {
      if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
        events.push(JSON.parse(chunk));
        return true;
      }
      return write(chunk, ...args);
    });
    t.mock.method(globalThis, "fetch", async (url: unknown, init: any) => {
      try {
        const path = new URL(String(url)).pathname;
        if (path === "/api/ai-agent/bootstrap/exchange")
          return Response.json(
            { correlationId },
            { headers: { "set-cookie": "session=fixture; HttpOnly" } },
          );
        if (path === "/api/ai-agent/work/append") {
          const record = JSON.parse(init.body);
          if (
            scenario === "persistence-failure" ||
            ([
              "batch-refresh-persistence-failure",
              "pagination-recovery-persistence-failure",
            ].includes(scenario) &&
              record.kind === "checkpoint" &&
              forcedUpdates > 0)
          )
            return Response.json({ error: "unavailable" }, { status: 503 });
          assert.equal(record.sequence, saved.length + 1);
          saved.push(record);
          return Response.json({ sequence: record.sequence });
        }
        if (path === "/api/signal/inbox/messages") {
          queries.push(JSON.parse(init.body));
          if (
            ["api-failure", "pagination-recovery-api-failure"].includes(
              scenario,
            ) &&
            queries.length === 2
          )
            return Response.json({ error: "unavailable" }, { status: 503 });
          if (scenario === "cancel") {
            process.emit("SIGTERM");
            throw new DOMException("Aborted", "AbortError");
          }
          if (scenario === "deadline") clockOffset += 61_000;
          if (scenario === "deep-hard-stop") clockOffset += 13_900_000;
          return Response.json({
            inbox_items: Array.from(
              {
                // history-aggregate: a retrieval that delivers nothing citable.
                length:
                  scenario === "history-aggregate"
                    ? 0
                    : scenario === "checkpoint-failure" ||
                        scenario === "pagination" ||
                        scenario === "incomplete"
                      ? 20
                      : 1,
              },
              (_, index) => [
                index + 1,
                {
                  message_uuid: `archive-${index + 1}`,
                  text:
                    "The archive received a botanical survey. " +
                    (scenario === "long-evidence"
                      ? "Archive context. ".repeat(100) +
                        "TAIL_FACT: the greenhouse reopened. "
                      : "") +
                    (scenario === "checkpoint-failure"
                      ? "Synthetic archive text. ".repeat(240)
                      : ""),
                  timestamp: 1791626400,
                },
              ],
            ),
            page_limit: 20,
          });
        }
        if (path === "/api/attachments/get") {
          assert.equal(queries.length, 4);
          assert.equal(forcedUpdates, 0);
          documents.push(JSON.parse(init.body));
          return Response.json({
            document: {
              mediaId: correlationId,
              fileName: "Botanical.pdf",
              citation,
            },
            sections: [],
          });
        }
        if (path === "/api/ai-agent/maps/prepare")
          return Response.json({
            records: JSON.parse(init.body).records.map((record: any) => ({
              ...record,
              originalX: record.x,
              originalY: record.y,
              platformType: "CAPDOC",
              latitude: 50,
              longitude: 30,
              warnings: [],
            })),
          });
        assert.ok(path.endsWith("/chat/completions"));
        const body = JSON.parse(init.body);
        const purpose = new Headers(init.headers).get("x-echo-ai-purpose");
        assert.ok(JSON.stringify(body).includes("Private budget status"));
        if (purpose === "checkpoint") {
          checkpoints++;
          assert.equal(scenario, "checkpoint-failure");
          return stream("UNFINISHED_CHECKPOINT", undefined, "length");
        }
        if (scenario === "legacy" && purpose !== "research")
          return Response.json(
            {
              error: {
                message:
                  "403 Forbidden: legacy grant requires research purpose",
              },
            },
            { status: 403 },
          );
        if (
          purpose === "synthesis" ||
          (scenario === "legacy" && !body.tools?.length)
        ) {
          if (scenario === "user-map") {
            assert.ok(JSON.stringify(body).includes(`echo-map:${mapId}`));
            assert.ok(synthesisRequest(body).completedActions.some(
              (action: any) => action.tool === "echo_map_append" && action.failed === 0,
            ));
          }
          // Incident 01a1b122: three searches found nothing and the answer said none ran.
          if (scenario === "history-aggregate") {
            assert.deepEqual(synthesisRequest(body).completedActions, [
              { tool: "echo_inbox_messages", calls: 1, failed: 0, results: 0 },
            ]);
            assert.ok(JSON.stringify(body).includes("A search with zero results found nothing"));
          }
          synthesisCalls++;
          synthesisBodies.push(JSON.stringify(body));
          assert.ok(synthesisCalls <= 2);
          assert.ok((body.max_tokens ?? body.max_completion_tokens) <= 8192);
          assert.ok(!body.tools?.length);
          if (scenario === "refresh-final")
            assert.ok(JSON.stringify(body).includes("LATEST_DRAFT"));
          if (scenario === "long-evidence")
            assert.ok(JSON.stringify(body).includes("TAIL_FACT"));
          if (scenario === "synthesis-cancel") process.emit("SIGTERM");
          if (synthesisCalls === 1) {
            if (scenario === "retry-deadline") clockOffset += 61_000;
            if (["retry-length", "retry-deadline"].includes(scenario))
              return stream("UNFINISHED", undefined, "length");
            if (scenario === "retry-citation")
              return stream("Invalid [source](/rer-analysis-neo?m=missing)");
            if (scenario === "retry-empty") return stream("");
            if (scenario === "retry-stream")
              return new Response(
                'data: {"choices":[{"index":0,"delta":{"content":"UNFINISHED"}}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } },
              );
          }

          assert.ok(!JSON.stringify(body).includes("UNFINISHED_CHECKPOINT"));
          if (scenario === "denied" || scenario === "filtered")
            return Response.json(
              {
                error: {
                  message:
                    scenario === "denied" ? "403 Forbidden" : "content_filter",
                },
              },
              { status: scenario === "denied" ? 403 : 400 },
            );
          if (
            [
              "synthesis-failure",
              "empty-refresh",
              "no-draft",
              "large-draft",
              "deep-synthesis-fallback",
            ].includes(scenario)
          )
            return stream("UNFINISHED_ANSWER", undefined, "length");
          if (scenario === "invalid-synthesis")
            return stream(
              `${draft} Invented [джерело](/rer-analysis-neo?m=missing)`,
            );
          return stream(
            scenario.startsWith("user-text") ||
              ["history-aggregate", ...NO_EVIDENCE].includes(scenario)
              ? "The botanical survey is ready."
              : scenario === "user-map"
                ? `[мапа](echo-map:${mapId})`
                : draft,
          );
        }
        assert.equal(purpose, "research");
        researchCalls++;
        assert.ok(researchCalls < 140);
        const lastInput = JSON.stringify(body.messages.at(-1)?.content);
        if (lastInput?.includes("The work is not finished")) continuations++;
        if (lastInput?.includes("but not the draft")) rejectionNotices++;
        if (lastInput?.includes("Deep mode was requested")) deepSearchPrompts++;
        // One turn eats over half of the 60 s research window before anything was found.
        if (scenario === "slow-first-turn" && researchCalls === 1)
          clockOffset += 31_000;
        if (body.tool_choice?.function?.name === "update_research") {
          forcedUpdates++;
          assert.deepEqual(
            body.tools.map((tool: any) => tool.function.name),
            ["update_research"],
          );
          if (scenario.startsWith("batch-refresh")) {
            assert.equal(queries.length, 4);
            assert.equal(documents.length, 1);
          }
          return stream("PRIVATE_RESEARCH_NARRATION", {
            name: "update_research",
            args: {
              ...updated,
              ...pagination,
              ...([
                "batch-refresh-rejected",
                "pagination-recovery-rejected",
              ].includes(scenario) && forcedUpdates === 1
                ? { draft: "Invented [source](/rer-analysis-neo?m=missing)" }
                : {}),
            },
          });
        }
        if (scenario.startsWith("batch-refresh") && queries.length === 3)
          return stream("PRIVATE_RESEARCH_NARRATION", calls.splice(0, 2));
        if (scenario === "follow-up")
          assert.ok(JSON.stringify(body).includes("Saved botanical survey"));
        if (
          scenario === "slow-provider" &&
          queries.length === 0 &&
          calls[0]?.name === "echo_inbox_messages"
        )
          clockOffset += 31_000;
        if (scenario === "user-map") {
          if (researchCalls === 1)
            return stream("PRIVATE_RESEARCH_NARRATION", {
              name: "echo_map_create",
              args: { title: "Botanical sites", isMain: true },
            });
          if (researchCalls === 2) {
            mapId = JSON.parse(
              body.messages.findLast((message: any) => message.role === "tool")
                .content,
            ).id;
            return stream("PRIVATE_RESEARCH_NARRATION", {
              name: "echo_map_append",
              args: {
                id: mapId,
                records: [
                  {
                    name: "Orchard",
                    sidc: "",
                    coordinateSystem: "latlon",
                    x: "50",
                    y: "30",
                    comments: [],
                    sources: [],
                  },
                ],
              },
            });
          }
        }
        if (
          scenario === "refresh-final" &&
          body.messages.at(-1)?.role === "user" &&
          JSON.stringify(body.messages.at(-1)?.content).includes(
            "Before final synthesis",
          )
        ) {
          return stream("", {
            name: "update_research",
            args: { ...updated, draft: `LATEST_DRAFT ${draft}` },
          });
        }
        const call = calls.shift();
        if (call === EMPTY) return stream("");
        return stream(
          "PRIVATE_RESEARCH_NARRATION",
          call === STOP ? undefined : call,
        );
      } catch (error) {
        if (error instanceof assert.AssertionError) errors.push(error);
        throw error;
      }
    });
    try {
      const payload = validatePayload(
        {
          prompt:
            scenario.startsWith("user-text")
              ? "Translate into English: Ботанічне дослідження готове."
              : scenario === "user-map"
                ? "Make a map of Orchard at latitude 50, longitude 30."
                : scenario === "pagination"
                  ? "Read every archive record and summarize them."
                  : "Summarize today's archive records.",
          modelName,
          providerTransport: "echo_gateway",
          providerApiKey: "fixture-capability",
          echoPublicHost: "echo.example.test",
          bootstrapToken: "A".repeat(43),
          correlationId,
          // An earlier cited answer must not demand citations for a source-free follow-up.
          ...(["user-text-history", "history-aggregate"].includes(scenario)
            ? {
                history: [
                  {
                    role: "assistant",
                    content: `Earlier answer ${draft}`,
                    citations: sources.citations,
                  },
                ],
              }
            : {}),
          contextWindow: 65_536,
          maxTokens: 8192,
          checkpointMaxTokens: 8192,
          compactionReserveTokens:
            scenario === "checkpoint-failure" ? 48_000 : 16_384,
          compactionKeepRecentTokens: 1024,
          ...(scenario === "legacy"
            ? {}
            : {
                executionPolicy: scenario.startsWith("deep-") ? deepPolicy : policy,
                deadlineAt:
                  Date.now() +
                  (scenario.startsWith("deep-")
                    ? deepPolicy.maxRuntimeSeconds * 1000
                    : scenario === "checkpoint-failure"
                      ? 300_000
                      : 120_000),
              }),
          timeContext: {
            timeZone: "Europe/Kyiv",
            requestStartedAtUtc: new Date(Date.now()).toISOString(),
          },
          ...(scenario === "pagination-recovery-no-memory"
            ? {}
            : {
                workMemory: {
                  version: 1,
                  ...(scenario === "follow-up"
                    ? { recap: `Saved botanical survey: ${draft}`, ...sources }
                    : { citations: [], fileCitations: [] }),
                },
              }),
          skills: [
            ...(scenario.startsWith("batch-refresh")
              ? [
                  {
                    method: "POST",
                    path: "/api/attachments/get",
                    skill: "attachment_get",
                    label: "Read document metadata",
                    requestKind: "attachmentRead",
                  },
                ]
              : []),
            ...(scenario === "user-map"
              ? [
                  {
                    method: "POST",
                    path: "/api/ai-agent/maps/prepare",
                    skill: "map_prepare",
                    label: "Prepare map",
                    requestKind: "mapRecords",
                  },
                  {
                    method: "POST",
                    path: "/api/ai-agent/maps/get",
                    skill: "map_get",
                    label: "Read map",
                    requestKind: "mapDocument",
                  },
                ]
              : []),
            {
              method: "POST",
              path: "/api/signal/inbox/messages",
              skill: "inbox_messages",
              label: "Read archive",
              requestKind: "inboxMessages",
            },
          ],
        },
        false,
      );
      if (
        [
          "denied",
          "filtered",
          "persistence-failure",
          "batch-refresh-persistence-failure",
          "pagination-recovery-persistence-failure",
          "pagination-recovery-persistence-failure",
        ].includes(scenario)
      )
        await assert.rejects(runAgent(payload));
      else await runAgent(payload);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        for (const listener of process.listeners(signal))
          if (!oldSignals[signal].includes(listener))
            process.removeListener(signal, listener);
    }
    assert.deepEqual(errors, []);
    // Failures of the private tools are named for the logs instead of "unknown".
    if (scenario === "persistence-failure")
      assert.ok(
        events.some(
          (event) =>
            event.type === "tool_diagnostic" && event.tool === "update_research",
        ),
      );
    if (scenario === "invalid-progress") {
      const diagnostic = events.find((event) => event.type === "tool_diagnostic");
      assert.equal(diagnostic.tool, "report_progress");
      assert.equal(diagnostic.reason, "invalid_arguments");
      assert.equal(diagnostic.fields, "summary:required");
    }
    assert.ok(!events.some((event) => event.type === "assistant_delta"));
    assert.ok(!JSON.stringify(events).includes("PRIVATE_"));
    // Private diagnostics name it for the logs and never reach the chat.
    assert.ok(
      !JSON.stringify(
        events.filter((event) => event.type !== "tool_diagnostic"),
      ).includes("update_research"),
    );
    assert.ok(
      !events.some((event) => event.type === "tool_start" && event.arguments),
    );
    const answer = events.findLast(
      (event) => event.type === "assistant_snapshot",
    )?.text;
    if (
      [
        "denied",
        "filtered",
        "persistence-failure",
        "batch-refresh-persistence-failure",
        "pagination-recovery-persistence-failure",
        "cancel",
        "synthesis-cancel",
      ].includes(scenario)
    ) {
      assert.equal(answer, undefined);
      if (
        [
          "cancel",
          "persistence-failure",
          "batch-refresh-persistence-failure",
        ].includes(scenario)
      )
        assert.equal(synthesisCalls, 0);
      if (scenario === "batch-refresh-persistence-failure") {
        assert.equal(queries.length, 4);
        assert.equal(documents.length, 1);
        assert.equal(forcedUpdates, 1);
      }
      if (scenario === "pagination-recovery-persistence-failure") {
        assert.equal(queries.length, 1);
        assert.equal(forcedUpdates, 1);
      }
      return;
    }
    assert.ok(answer);
    // #4031: the chat offers a Deep continuation from this metadata alone.
    const coverage = events.find(
      (event) => event.type === "completion_metadata",
    );
    if (scenario.startsWith("deep-")) {
      assert.ok(!answer.includes("Охоплення джерел неповне"));
      assert.equal(
        coverage?.reason,
        {
          "deep-hard-stop": "time_limit",
          "deep-stalled": "incomplete_research",
          "deep-promise-only": "incomplete_research",
          "deep-synthesis-fallback": "incomplete_research",
        }[scenario],
      );
      // A saved draft must not pass for a finished answer.
      assert.equal(
        answer.includes("Наведено останню збережену чернетку"),
        scenario === "deep-synthesis-fallback",
      );
      assert.equal(answer.includes("Вичерпано час глибокого режиму"), scenario === "deep-hard-stop");
      assert.equal(
        answer.includes("не виконавши всі заплановані кроки"),
        NO_EVIDENCE.includes(scenario),
      );
    } else assert.equal(Boolean(coverage), answer.includes("Охоплення джерел неповне"));
    const diagnostics = events.filter(
      (event) => event.type === "completion_diagnostic",
    );
    assert.ok(diagnostics.some((event) => event.stage === "answer"));
    if (
      [
        "retry-length",
        "retry-citation",
        "retry-empty",
        "retry-stream",
      ].includes(scenario)
    ) {
      assert.equal(synthesisCalls, 2);
      assert.equal(diagnostics.at(-1).outcome, "complete");
    }
    if (scenario === "retry-deadline") {
      assert.equal(synthesisCalls, 1);
      assert.equal(diagnostics.at(-1).outcome, "fallback");
    }
    if (scenario === "pagination-guard") assert.equal(queries.length, 1);
    if (recoveringPagination) {
      assert.equal(queries.length, 2);
      assert.equal(forcedUpdates, 1);
      if (scenario === "pagination-recovery-focused")
        assert.equal(queries[1].search, "botanical survey");
      else assert.equal(queries[1].before_id_noninclusive, 20);
    }
    if (scenario === "large-draft") {
      assert.ok(answer.length > 3000);
      assert.ok(answer.startsWith("## Archive"));
    }

    assert.ok(!answer.includes("UNFINISHED"));
    assert.ok(!answer.includes("уривки джерел"));
    if (scenario === "no-draft") assert.ok(answer.includes(FLASH_INABILITY));
    else if (NO_EVIDENCE.includes(scenario))
      assert.ok(answer.startsWith("The botanical survey is ready."));
    else if (
      scenario.startsWith("user-text") ||
      scenario === "history-aggregate"
    )
      assert.equal(answer.trim(), "The botanical survey is ready.");
    else if (scenario === "user-map") {
      assert.ok(answer.includes(`](echo-map:${mapId})`));
      assert.equal(
        events.filter((event) => event.type === "map_artifact").length,
        1,
      );
    } else assert.ok(answer.includes(citation));
    if (scenario === "selective" || scenario === "legacy") {
      assert.equal(queries.length, 2);
      assert.equal(queries[0].search, undefined);
      assert.equal(queries[1].search, "botanical survey");
    }
    if (scenario === "follow-up") assert.equal(queries.length, 0);
    if (scenario === "pagination") assert.equal(queries.length, 10);
    if (["no-initial-plan", "slow-first-turn", "continues-once"].includes(scenario))
      assert.equal(queries.length, 1);
    if (scenario === "refresh-required") {
      assert.equal(queries.length, 10);
      assert.ok(forcedUpdates > 0);
    }
    if (scenario.startsWith("batch-refresh")) {
      assert.equal(queries.length, 5);
      assert.equal(documents.length, 1);
      assert.equal(forcedUpdates, 1);
    }
    if (scenario.endsWith("-rejected")) {
      // The rejected draft is reported, and it no longer holds retrieval back.
      assert.equal(rejectionNotices, 1);
      assert.ok(
        diagnostics.some(
          (event) =>
            event.outcome === "citation_rejected" &&
            event.draftIssue === "no_citation",
        ),
      );
    }
    if (scenario === "lenient-tools") {
      assert.ok(!events.some((event) => event.type === "tool_diagnostic"));
      const progress = events.findLast((event) => event.summary?.startsWith("Reviewing"));
      assert.equal(progress.summary.length, 240);
      assert.ok(!progress.summary.includes("\n"));
      const first = JSON.parse(saved.find((record) => record.kind === "checkpoint").content);
      assert.equal(first.research.checklist.length, 4);
      assert.deepEqual(first.research.checklist[0], {
        task: "x".repeat(100),
        status: "pending",
      });
      assert.deepEqual(first.research.gaps, ["Unread records"]);
      assert.equal(queries.length, 1);
    }
    if (scenario.endsWith("empty-final-turn")) {
      // Finishing without text is not a provider failure.
      assert.equal(coverage, undefined);
      assert.equal(synthesisCalls, 1);
      assert.ok(!answer.includes("збій"));
      assert.ok(answer.includes(citation));
    }
    if (scenario === "continues-once")
      assert.equal(continuations, RESEARCH_CONTINUATIONS);
    // The shape of incident 01a1b176: Deep answered from memory in one turn.
    if (scenario === "deep-no-tools") {
      assert.equal(deepSearchPrompts, 1);
      assert.equal(queries.length, 1);
    }
    if (scenario === "deep-continues") {
      assert.equal(continuations, 2);
      assert.equal(queries.length, 2);
    }
    if (NO_EVIDENCE.includes(scenario)) {
      // The shape of incident 01a1b03b: plan, progress, stop. One unanswered prompt ends it.
      assert.equal(continuations, 1);
      assert.equal(researchCalls, scenario === "deep-stalled" ? 4 : 3);
      assert.equal(queries.length, 0);
    }
    if (scenario.startsWith("deep-") && scenario !== "deep-hard-stop") {
      const prompt = synthesisBodies.at(-1)!;
      assert.ok(!prompt.includes("time budget ended"));
      assert.ok(!prompt.includes("deep mode"));
      assert.ok(prompt.includes("No time, tool or budget limit stopped this work"));
      // Abandoned tasks may be stated; only finished work reports gaps as plain findings.
      assert.equal(
        prompt.includes("Do not add a section about incomplete coverage"),
        !NO_EVIDENCE.includes(scenario),
      );
    }
    if (NO_EVIDENCE.includes(scenario))
      assert.ok(synthesisBodies.at(-1)!.includes("No Echo data was searched"));
    const failures = events.filter(
      (event) => event.type === "tool_end" && event.is_error,
    );
    if (scenario === "pagination-guard" || recoveringPagination) {
      const deferred = events.filter(
        (event) =>
          event.type === "tool_diagnostic" &&
          event.reason === "research_pagination_required",
      );
      assert.equal(deferred.length, 1);
      assert.equal(deferred[0].handledPrivately, true);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "tool_start" && event.tool === "echo_inbox_messages",
        ).length,
        queries.length,
      );
      if (scenario !== "pagination-recovery-api-failure")
        assert.deepEqual(failures, []);
    }
    if (scenario === "invalid-arguments") {
      assert.equal(queries.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].errorReason, "invalid_arguments");
    }
    if (
      ["batch-refresh", "batch-refresh-rejected", "refresh-required"].includes(
        scenario,
      )
    )
      assert.deepEqual(failures, []);
    if (scenario === "no-initial-plan") assert.deepEqual(failures, []);
    if (["api-failure", "pagination-recovery-api-failure"].includes(scenario)) {
      assert.equal(queries.length, 2);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].errorReason, "http_error");
      const diagnostic = events.find(
        (event) =>
          event.type === "tool_diagnostic" && event.reason === "http_error",
      );
      assert.equal(diagnostic.httpStatus, 503);
      assert.equal(diagnostic.handledPrivately, false);
      assert.equal(
        failures[0].errorSummary,
        "Не вдалося завантажити дані за вказаними параметрами.",
      );
    }
    if (scenario === "slow-provider" || scenario === "deadline")
      assert.equal(queries.length, 1);
    if (scenario === "checkpoint-failure") assert.ok(checkpoints > 0);
    const coverageReason = (
      {
        incomplete: "incomplete_research",
        pagination: "incomplete_research",
        "invalid-synthesis": "incomplete_research",
        "tool-limit": "tool_limit",
        "slow-provider": "time_limit",
        "slow-first-turn": "time_limit",
        deadline: "time_limit",
        "checkpoint-failure": "context_limit",
      } as Record<string, string>
    )[scenario];
    if (coverageReason) {
      assert.deepEqual(coverage, {
        type: "completion_metadata",
        coverageLimited: true,
        reason: coverageReason,
      });
      assert.ok(answer.includes("Охоплення джерел неповне"));
    }
    if (scenario === "deep-hard-stop")
      assert.equal(coverage.reason, "time_limit");
    const checkpointsSaved = saved.filter(
      (record) => record.kind === "checkpoint",
    );
    if (["user-text", "user-text-history", "user-map"].includes(scenario))
      assert.equal(queries.length, 0);
    else if (
      ["pagination-recovery-no-memory", "deep-promise-only"].includes(scenario)
    )
      assert.equal(checkpointsSaved.length, 0);
    else assert.ok(checkpointsSaved.length);
    if (scenario === "selective") {
      const latest = JSON.parse(checkpointsSaved.at(-1).content);
      assert.equal(latest.retrievals.length, 2);
      assert.equal(latest.retrievals[1].query.search, "botanical survey");
      assert.equal(latest.research.draft, draft);
    }
  });
}

test("#3572 duration guard stops checkpoints before consuming the research reserve", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const budget = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  const research = new FlashResearch(() => sources);
  const context = { systemPrompt: "Fixture", messages: [] };
  research.completed("research", 35_000);
  t.mock.timers.tick(30_000);
  assert.throws(() =>
    research.beforeProvider("checkpoint", context, budget, 50, 65536, 8192),
  );
  assert.equal(budget.reason, "time_limit");
  assert.equal(budget.finalization.signal.aborted, false);
  budget.dispose();
});

test("incident 01a1b038: one slow turn does not end research before anything was retrieved", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const context = { systemPrompt: "Fixture", messages: [] };
  const research = new FlashResearch(() => sources);
  const budget = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  research.completed("research", 35_000);
  t.mock.timers.tick(30_000);
  assert.doesNotThrow(() =>
    research.beforeProvider("research", context, budget, 50, 65536, 8192),
  );
  assert.equal(budget.reason, undefined);
  // Once there is something to summarize, the estimate may stop research as before.
  research.record("echo_inbox_messages", { period }, {});
  assert.throws(() =>
    research.beforeProvider("research", context, budget, 50, 65536, 8192),
  );
  assert.equal(budget.reason, "time_limit");
  budget.dispose();
});

test("#4031 a turn ending with declared work left is continued only while it is worth it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const budget = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  const research = new FlashResearch(() => sources);
  const save = (update: unknown) => (research.tool(() => {}) as any).execute("save", update);
  // No state and no promise: a direct answer, for example a translation.
  assert.equal(research.shouldContinue(budget), false);
  research.noteProgress();
  assert.equal(research.shouldContinue(budget), true);
  assert.match(research.continuationPrompt(), /announced work/);
  research.noteToolRun();
  assert.equal(research.shouldContinue(budget), false);
  // A promise made after earlier work still needs a tool of its own.
  research.noteProgress();
  assert.equal(research.shouldContinue(budget), true);
  research.noteToolRun();
  assert.equal(research.shouldContinue(budget), false);
  await save(initial);
  assert.equal(research.shouldContinue(budget), true);
  assert.match(research.continuationPrompt(), /PRIVATE_CHECKLIST/);
  // Without the time for another turn the answer matters more.
  research.completed("research", 90_000);
  assert.equal(research.shouldContinue(budget), false);
  research.completed("research", 0);
  await save({ ...updated, checklist: [{ task: "Second archive", status: "blocked" }] });
  assert.equal(new FlashResearch(() => sources).shouldContinue(budget), false);
  budget.dispose();
  assert.equal(continuationLimit(deepPolicy), DEEP_RESEARCH_CONTINUATIONS);
  assert.equal(continuationLimit(policy), RESEARCH_CONTINUATIONS);
});

test("incident 01a1b122: synthesis learns what really ran", () => {
  const research = new FlashResearch(() => sources);
  assert.deepEqual(research.completedActions(), []);
  research.record("echo_inbox_messages", { period }, { messages: [] });
  research.noteToolResult("echo_inbox_messages", false);
  research.record("echo_inbox_messages", { period }, { messages: [1, 2] });
  research.noteToolResult("echo_inbox_messages", false);
  research.noteToolResult("echo_inbox_messages", true);
  research.noteToolResult("echo_map_publish", false);
  assert.deepEqual(research.completedActions(), [
    { tool: "echo_inbox_messages", calls: 3, failed: 1, results: 2 },
    { tool: "echo_map_publish", calls: 1, failed: 0 },
  ]);
});

test("#4031 a closing note after real work is not unfinished work", () => {
  const budget = new ResearchBudget(deepPolicy, Date.now() + 14_400_000, () => {});
  const research = new FlashResearch(() => sources);
  research.noteToolRun();
  research.noteProgress();
  // It is worth one prompt, but the finished work must not be labelled incomplete.
  assert.equal(research.shouldContinue(budget), true);
  assert.equal(research.hasUnfinishedWork, false);
  assert.equal(research.hasGaps(), false);
  const idle = new FlashResearch(() => sources);
  idle.noteProgress();
  assert.equal(idle.hasUnfinishedWork, true);
  assert.equal(idle.hasGaps(), true);
  budget.dispose();
});

test("incident 01a1b176: only Deep is sent back to search when no tool ran", () => {
  const deep = new ResearchBudget(deepPolicy, Date.now() + 14_400_000, () => {});
  const fast = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  const research = new FlashResearch(() => sources);
  assert.equal(research.shouldContinue(deep), true);
  assert.equal(research.shouldContinue(fast), false);
  assert.match(research.continuationPrompt(), /Deep mode was requested/);
  assert.match(research.continuationPrompt(), /files or images the user supplied/);
  // Not searching is not unfinished work: reformatting needs no tool.
  assert.equal(research.hasUnfinishedWork, false);
  research.noteToolRun();
  assert.equal(research.shouldContinue(deep), false);
  deep.dispose();
  fast.dispose();
});

test("#4031 a blocked task is finished work, not a reason to continue", async (t) => {
  const budget = new ResearchBudget(deepPolicy, Date.now() + 14_400_000, () => {});
  t.after(() => budget.dispose());
  const research = new FlashResearch(() => sources);
  research.noteToolRun();
  await (research.tool(() => {}) as any).execute("save", {
    ...updated,
    checklist: [{ task: "Second archive", status: "blocked" }],
  });
  assert.equal(research.shouldContinue(budget), false);
  budget.dispose();
});

test("#4031 retrieval needs no saved state and the budget status no longer demands one", () => {
  const research = new FlashResearch(() => sources);
  assert.doesNotThrow(() => research.beforeRetrieval("inbox_messages", { period }));
  const prompted = research.beforeProvider(
    "research",
    { systemPrompt: "Fixture", messages: [] },
    undefined,
    50,
    65536,
    8192,
  );
  assert.match(prompted.systemPrompt, /"updateRequired":false/);
  // Saving nothing is not a gap: only declared gaps and unread pages are.
  assert.equal(research.hasGaps(), false);
  research.record("echo_inbox_messages", { period }, { nextCursor: 1 });
  assert.equal(research.hasGaps(), true);
});

test("#4031 research state accepts whatever shape a model sends", () => {
  assert.deepEqual(
    normalizedResearchUpdate({
      checklist: [
        "plain task",
        { task: "started", status: "in_progress" },
        { task: "finished", status: "COMPLETED" },
        { task: "skipped", status: "failed" },
        { task: "t".repeat(150), status: "done" },
        { status: "done" },
      ],
      gaps: "single gap",
      paginationReason: " ",
      draft: 7,
    }),
    {
      checklist: [
        { task: "plain task", status: "pending" },
        { task: "started", status: "pending" },
        { task: "skipped", status: "blocked" },
        { task: "finished", status: "done" },
      ],
      draft: undefined,
      gaps: ["single gap"],
    },
  );
  assert.deepEqual(
    normalizedResearchUpdate({
      checklist: [{ task: { nested: true }, status: "done" }],
      gaps: [{ gap: "object" }, "kept"],
    }).gaps,
    ["kept"],
  );
  // Blocked tasks must not push pending work out of the cap.
  assert.deepEqual(
    normalizedResearchUpdate({
      checklist: [
        ...["a", "b", "c", "d"].map((task) => ({ task, status: "blocked" })),
        { task: "still to do", status: "pending" },
      ],
    }).checklist?.[0],
    { task: "still to do", status: "pending" },
  );
  // An early heading must not become the whole draft, and a link must stay whole.
  const clipped = normalizedResearchUpdate({
    draft: `# Heading\n${`Fact [джерело](${citation}) `.repeat(800)}`,
  }).draft!;
  assert.ok(clipped.length > 7900 && clipped.length <= 8000);
  assert.equal(validatedFlashAnswer(clipped, sources), clipped);
  // Omitted fields stay undefined so that a partial update keeps saved state.
  assert.deepEqual(normalizedResearchUpdate(null), {
    checklist: undefined,
    draft: undefined,
    gaps: undefined,
  });
  const long = normalizedResearchUpdate({
    checklist: JSON.stringify([{ task: "from json", status: "done" }]),
    draft: `${"Line of the draft.\n".repeat(600)}`,
    gaps: Array.from({ length: 9 }, (_, index) => `${index}`.repeat(200)),
    paginationReason: "r".repeat(300),
  });
  assert.deepEqual(long.checklist, [{ task: "from json", status: "done" }]);
  assert.ok(long.draft!.length <= 8000);
  assert.ok(long.draft!.endsWith("Line of the draft."));
  assert.equal(long.gaps!.length, 4);
  assert.equal(long.gaps![0].length, 160);
  assert.equal(long.paginationReason!.length, 200);
});

test("#4031 a partial research update keeps the saved checklist, gaps and draft", async () => {
  const research = new FlashResearch(() => sources);
  const save = (update: unknown) => (research.tool(() => {}) as any).execute("save", update);
  await save(updated);
  await save({ gaps: ["Second archive"] });
  const saved = JSON.parse(research.compactEvidence()!);
  assert.equal(saved.draft, draft);
  assert.deepEqual(saved.gaps, ["Second archive"]);
  assert.equal(research.hasGaps(), true);
});

test("#4031 a rejected draft keeps the checklist and names the invalid link", async () => {
  const issues: unknown[] = [];
  const research = new FlashResearch(
    () => sources,
    undefined,
    (event) => issues.push(event),
  );
  const save = (update: unknown) => (research.tool(() => {}) as any).execute("save", update);
  await save(updated);
  const result = await save({
    checklist: initial.checklist,
    gaps: ["Unread records"],
    draft: `Finding [джерело](${citation}) and [джерело](/rer-analysis-neo?m=missing)`,
  });
  const text = result.content[0].text;
  assert.match(text, /but not the draft/);
  assert.match(text, /m=missing/);
  assert.ok(text.includes(citation));
  assert.deepEqual(issues, [
    { stage: "research", outcome: "citation_rejected", draftIssue: "unknown_link" },
  ]);
  const saved = JSON.parse(research.compactEvidence()!);
  assert.equal(saved.draft, draft);
  assert.deepEqual(saved.gaps, ["Unread records"]);
  assert.doesNotThrow(() => research.beforeRetrieval("inbox_messages", { period }));
  const failed = new FlashResearch(() => sources, undefined, (event) => issues.push(event));
  await (failed.tool(() => {}) as any).execute("save", { draft: "Uncited finding" });
  await (failed.tool(() => {}) as any).execute("save", { draft: `https://example.test ${draft}` });
  assert.deepEqual(
    issues.slice(1).map((event: any) => event.draftIssue),
    ["no_citation", "bare_link"],
  );
});

test("#4031 validation diagnostics carry field paths and never the received values", () => {
  const tool: any = {
    name: "fixture",
    description: "Fixture",
    parameters: Type.Object(
      {
        checklist: Type.Array(
          Type.Object({
            task: Type.String({ maxLength: 5 }),
            status: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
          }),
          { maxItems: 1 },
        ),
        draft: Type.String(),
        count: Type.Integer({ minimum: 3 }),
      },
      { additionalProperties: false },
    ),
  };
  const fieldsOf = (args: unknown) => {
    try {
      validateToolArguments(tool, { type: "toolCall", id: "1", name: "fixture", arguments: args } as any);
    } catch (error) {
      return validationFields({ content: [{ type: "text", text: String((error as Error).message) }] });
    }
    return "valid";
  };
  const fields = fieldsOf({
    checklist: [
      { task: "SENSITIVE VALUE", status: "in_progress" },
      { task: "b", status: "done" },
    ],
    count: 1,
    SENSITIVE_KEY: "SENSITIVE VALUE",
  });
  assert.doesNotMatch(fields!, /SENSITIVE/);
  for (const expected of [
    "draft:required",
    "checklist.0.task:size",
    "checklist.0.status:enum",
    "checklist:size",
    "count:size",
  ])
    assert.ok(fields!.split(", ").includes(expected), `${expected} in ${fields}`);
  assert.equal(new Set(fields!.split(", ")).size, fields!.split(", ").length);
  assert.equal(validationFields({ content: [{ type: "text", text: "Echo returned HTTP 500" }] }), undefined);
});

test("#4031 synthesis never blames a limit that did not stop the work", () => {
  const payload = { systemPrompt: "" } as Parameters<typeof outputRetrySystemPrompt>[0];
  const timedOut = outputRetrySystemPrompt(payload, { retrieved: false, limit: "time_limit" });
  assert.match(timedOut, /time budget ended/);
  assert.match(timedOut, /in the deep mode if needed/);
  assert.doesNotMatch(timedOut, /No time, tool or budget limit/);
  const deepTimedOut = outputRetrySystemPrompt(payload, { retrieved: false, limit: "time_limit", deep: true });
  assert.doesNotMatch(deepTimedOut, /deep mode/);
  assert.match(deepTimedOut, /State remaining coverage limitations honestly/);
  // A translation of the previous answer searches nothing and hit no limit.
  const direct = outputRetrySystemPrompt(payload, { retrieved: false, limit: null });
  assert.match(direct, /if the request needed Echo data, say that the search did not run/);
  assert.doesNotMatch(direct, /time budget ended|deep mode/);
  assert.match(direct, /No time, tool or budget limit stopped this work/);
  // An unknown outcome keeps saying nothing about limits.
  assert.doesNotMatch(outputRetrySystemPrompt(payload), /No time, tool or budget limit/);
});

test("#4031 synthesis keeps room for hidden thinking within the engine's output cap", () => {
  assert.equal(synthesisTokenLimit(policy, 16_384), 16_384);
  assert.equal(synthesisTokenLimit(policy, 65_536), 16_384);
  assert.equal(synthesisTokenLimit(policy, 8192), 8192);
  assert.equal(synthesisTokenLimit(deepPolicy, 65_536), 65_536);
});

test("incident 01a18e18: a checkpoint is not started with less research time than it needs", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const context = { systemPrompt: "Fixture", messages: [] };
  const tuned = new FlashResearch(() => sources, undefined, undefined, RESEARCH_TUNING);
  const budget = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  // 60 s of research remain and no checkpoint has been observed yet.
  assert.throws(() =>
    tuned.beforeProvider("checkpoint", context, budget, 50, 65536, 8192),
  );
  assert.equal(budget.reason, "time_limit");
  budget.dispose();
  const untuned = new FlashResearch(() => sources);
  const other = new ResearchBudget(policy, Date.now() + 120_000, () => {});
  assert.doesNotThrow(() =>
    untuned.beforeProvider("checkpoint", context, other, 50, 65536, 8192),
  );
  other.dispose();
});

test("incident 01a18e18: paging one search beyond the limit needs a coverage reason", async () => {
  const research = new FlashResearch(() => sources, undefined, undefined, RESEARCH_TUNING);
  const save = (extra: Record<string, unknown> = {}) =>
    (research.tool(() => {}) as any).execute("save", { ...updated, ...extra });
  const query = (search: string, cursor?: number) => ({
    period,
    search,
    ...(cursor ? { before_id_noninclusive: cursor } : {}),
  });
  const page = (search: string, cursor?: number) => {
    research.beforeRetrieval("inbox_messages", query(search, cursor));
    research.record("echo_inbox_messages", query(search, cursor), { nextCursor: 1 });
  };
  await save();
  page("грибники");
  page("грибники", 400);
  page("грибники", 300);
  page("тюльпани"); // another search starts its own page count
  await save();
  assert.throws(
    () => research.beforeRetrieval("inbox_messages", query("грибники", 200)),
    { message: FLASH_RESEARCH_PAGINATION_REQUIRED },
  );
  assert.equal(research.updateRequired, true);
  // The refusal does not authorize pagination: a checkpoint without a reason keeps it blocked.
  await save();
  assert.throws(() =>
    research.beforeRetrieval("inbox_messages", query("грибники", 200)),
  );
  await save({ paginationReason: "User asked for every mention of this callsign." });
  assert.doesNotThrow(() =>
    research.beforeRetrieval("inbox_messages", query("грибники", 200)),
  );
  // Without tuning (the previous behavior) searched pagination is not limited.
  const plain = new FlashResearch(() => sources);
  await (plain.tool(() => {}) as any).execute("save", updated);
  for (let index = 1; index <= 5; index++) {
    const request = query("грибники", index * 100);
    plain.beforeRetrieval("inbox_messages", request);
    plain.record("echo_inbox_messages", request, { nextCursor: 1 });
    await (plain.tool(() => {}) as any).execute("save", updated);
  }
});

test("incident 01a1a1d8: frequency-filtered pages count as a focused search", async () => {
  const research = new FlashResearch(() => sources, undefined, undefined, RESEARCH_TUNING);
  await (research.tool(() => {}) as any).execute("save", updated);
  const query = (cursor?: number) => ({
    period,
    selected_freqs: ["163.9350"],
    ...(cursor ? { before_id_noninclusive: cursor } : {}),
  });
  for (const cursor of [undefined, 400, 300]) {
    assert.doesNotThrow(() => research.beforeRetrieval("inbox_messages", query(cursor)));
    research.record("echo_inbox_messages", query(cursor), { nextCursor: 1 });
  }
  await (research.tool(() => {}) as any).execute("save", updated);
  assert.throws(
    () => research.beforeRetrieval("inbox_messages", query(200)),
    { message: FLASH_RESEARCH_PAGINATION_REQUIRED },
  );
});

test("#4053 reading one named group counts as a focused search", async () => {
  const research = new FlashResearch(() => sources, undefined, undefined, RESEARCH_TUNING);
  await (research.tool(() => {}) as any).execute("save", updated);
  const query = (cursor?: number) => ({
    period,
    selected_groups: ["group.devops"],
    ...(cursor ? { before_id_noninclusive: cursor } : {}),
  });
  for (const cursor of [undefined, 400, 300]) {
    assert.doesNotThrow(() => research.beforeRetrieval("inbox_messages", query(cursor)));
    research.record("echo_inbox_messages", query(cursor), { nextCursor: 1 });
  }
  await (research.tool(() => {}) as any).execute("save", updated);
  // A very large group still needs a reason to keep paging.
  assert.throws(
    () => research.beforeRetrieval("inbox_messages", query(200)),
    { message: FLASH_RESEARCH_PAGINATION_REQUIRED },
  );
  // An empty selection is no scope, so an unfiltered page still needs one.
  const plain = new FlashResearch(() => sources, undefined, undefined, RESEARCH_TUNING);
  await (plain.tool(() => {}) as any).execute("save", updated);
  assert.throws(
    () =>
      plain.beforeRetrieval("inbox_messages", {
        period,
        selected_groups: [],
        before_id_noninclusive: 400,
      }),
    { message: FLASH_RESEARCH_PAGINATION_REQUIRED },
  );
});

test("bounded research covers every non-OpenAI engine with a budget", () => {
  assert.equal(usesBoundedResearch(FLASH_ENGINE), true);
  assert.equal(usesBoundedResearch("glm-5.3", policy), true);
  assert.equal(usesBoundedResearch("gemma-4", policy), true);
  // Without reasoning presets these engines have no budget to bound.
  assert.equal(usesBoundedResearch("glm-5.3"), false);
  assert.equal(usesBoundedResearch("gemma-4"), false);
  for (const openai of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol", "o1", "o3-mini", "o4-mini"])
    assert.equal(usesBoundedResearch(openai, policy), false);
});

test("#3572 draft reuse validates against current access, including every cited link", () => {
  assert.equal(validatedFlashAnswer(draft, sources), draft);
  assert.equal(
    validatedFlashAnswer(draft, { citations: [], fileCitations: [] }),
    undefined,
  );
  assert.equal(
    validatedFlashAnswer(
      `${draft} [source](/rer-analysis-neo?m=other)`,
      sources,
    ),
    undefined,
  );
  assert.equal(validatedFlashAnswer("Uncited findings", sources), undefined);
});

test("#3572 Flash reserves synthesis inside unchanged presets without altering other engines", () => {
  for (const [preset, runtime, reserve] of [
    ["fast", 120, 30],
    ["balanced", 300, 60],
    ["balanced", 600, 60],
    ["deep", 1800, 120],
    ["deep", 14_400, 300],
  ] as const) {
    const original = {
      ...policy,
      preset,
      maxRuntimeSeconds: runtime,
      finalizationSeconds: reserve,
    };
    assert.equal(
      validateExecutionPolicy(original, 1000)?.finalizationSeconds,
      reserve,
    );
    assert.throws(() => validateExecutionPolicy(original, 1000, [2]));
    assert.equal(
      validateExecutionPolicy(
        { ...original, finalizationSeconds: reserve * 2 },
        1000,
        [2],
      )?.maxRuntimeSeconds,
      runtime,
    );
    // Other non-OpenAI engines accept both reserves so snapshotted policies survive a rollout.
    for (const modelName of ["glm-5.3", "gemma-4"]) {
      const multipliers = finalizationMultipliers(modelName);
      assert.equal(validateExecutionPolicy(original, 1000, multipliers)?.finalizationSeconds, reserve);
      assert.equal(
        validateExecutionPolicy({ ...original, finalizationSeconds: reserve * 2 }, 1000, multipliers)?.finalizationSeconds,
        reserve * 2,
      );
    }
    assert.deepEqual(finalizationMultipliers(FLASH_ENGINE), [2]);
    assert.deepEqual(finalizationMultipliers("gpt-6.1-sol"), [1]);
    assert.throws(() =>
      validateExecutionPolicy(
        { ...original, finalizationSeconds: reserve * 2 },
        1000,
      ),
    );
  }
});

const providerRejection = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function researchWithProviderScript(
  t: any,
  script: (() => Response)[],
  policyForRun: ExecutionPolicy = policy,
) {
  const events: any[] = [];
  const reads: unknown[] = [];
  const synthesisBodies: string[] = [];
  let researchCalls = 0;
  const oldSignals = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: string, ...args: any[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
      events.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  t.mock.method(globalThis, "fetch", async (url: unknown, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/ai-agent/bootstrap/exchange")
      return Response.json(
        { correlationId },
        { headers: { "set-cookie": "session=fixture; HttpOnly" } },
      );
    if (path === "/api/signal/inbox/messages") {
      reads.push(JSON.parse(init.body));
      return Response.json({ inbox_items: [], page_limit: 20 });
    }
    if (path === "/api/user/sigint-groups-detailed")
      return Response.json([{ master_key: "group.devops", name: "DEVOPS" }]);
    const purpose = new Headers(init.headers).get("x-echo-ai-purpose");
    if (purpose === "synthesis") {
      synthesisBodies.push(init.body);
      return stream("Підсумок.");
    }
    return script[researchCalls++]?.() ?? stream("");
  });
  try {
    await runAgent(
      validatePayload(
        {
          prompt: "Що відбулось за сьогодні в чаті DEVOPS",
          modelName: "glm-5.3",
          providerTransport: "echo_gateway",
          providerApiKey: "fixture-capability",
          echoPublicHost: "echo.example.test",
          bootstrapToken: "A".repeat(43),
          correlationId,
          contextWindow: 65_536,
          maxTokens: 8192,
          checkpointMaxTokens: 8192,
          compactionReserveTokens: 16_384,
          compactionKeepRecentTokens: 1024,
          executionPolicy: policyForRun,
          deadlineAt: Date.now() + policyForRun.maxRuntimeSeconds * 1000,
          timeContext: {
            timeZone: "Europe/Kyiv",
            requestStartedAtUtc: new Date().toISOString(),
          },
          skills: [
            {
              method: "POST",
              path: "/api/user/sigint-groups-detailed",
              skill: "accessible_group_details",
              label: "List groups",
              requestKind: "json",
            },
            {
              method: "POST",
              path: "/api/signal/inbox/messages",
              skill: "inbox_messages",
              label: "Read archive",
              requestKind: "inboxMessages",
            },
          ],
        },
        false,
      ),
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      for (const listener of process.listeners(signal))
        if (!oldSignals[signal].includes(listener))
          process.removeListener(signal, listener);
  }
  const metadata = events.find((event) => event.type === "completion_metadata");
  const reason = metadata?.reason;
  return { events, metadata, reads, reason, researchCalls, synthesisBodies };
}

const readArchive = () =>
  stream("", { name: "echo_inbox_messages", args: { period } });

test("incident 01a1b210: a model failure before any tool gets one more attempt", async (t) => {
  const { events, reads, reason, researchCalls } =
    await researchWithProviderScript(t, [
      () => providerRejection(400, "unexpected model state"),
      readArchive,
      () => stream("Готово."),
    ]);
  assert.equal(reads.length, 1);
  assert.equal(researchCalls, 3);
  assert.notEqual(reason, "provider_error");
  const failed = events.find(
    (event) => event.type === "completion_diagnostic" && event.stopReason === "error",
  );
  assert.equal(failed.failureKind, "provider_error");
  assert.equal(failed.httpStatus, 400);
  assert.ok(
    events.some(
      (event) => event.type === "completion_diagnostic" && event.outcome === "continued",
    ),
  );
});

test("incident 01a1b210: a repeated failure stops after one extra attempt", async (t) => {
  const { reads, reason, researchCalls } = await researchWithProviderScript(t, [
    () => providerRejection(400, "unexpected model state"),
    () => providerRejection(400, "unexpected model state"),
    readArchive,
  ]);
  assert.equal(researchCalls, 2);
  assert.equal(reads.length, 0);
  assert.equal(reason, "provider_error");
});

test("incident 01a1b210: a failure after work started keeps the evidence and does not retry", async (t) => {
  const { reads, reason, researchCalls } = await researchWithProviderScript(t, [
    readArchive,
    () => providerRejection(400, "unexpected model state"),
    readArchive,
  ]);
  assert.equal(researchCalls, 2);
  assert.equal(reads.length, 1);
  assert.equal(reason, "provider_error");
});

test("incident 01a1b210: a rejected credential is not retried", async (t) => {
  await assert.rejects(
    researchWithProviderScript(t, [
      () => providerRejection(401, "unauthorized"),
      readArchive,
    ]),
  );
  assert.equal(
    (globalThis.fetch as any).mock.calls.filter((call: any) =>
      String(call.arguments[0]).endsWith("/chat/completions"),
    ).length,
    1,
  );
});

test("#4053 synthesis learns that a named group was not found", async (t) => {
  const { reads, synthesisBodies } = await researchWithProviderScript(t, [
    () =>
      stream("", {
        name: "echo_inbox_messages",
        args: { period, selectedGroups: ["Горобець"] },
      }),
    () => stream(""),
  ]);
  assert.equal(reads.length, 0);
  assert.equal(synthesisBodies.length, 1);
  const request = JSON.parse(JSON.parse(synthesisBodies[0]).messages[1].content);
  assert.deepEqual(request.unresolvedGroups, ["Горобець"]);
});

test("#4053 a failed-start message never logs the provider's text", () => {
  const research = providerCompletion({
    stopReason: "error",
    errorMessage: "400 private prompt text: secret-value",
    content: [],
  });
  assert.equal(research.failureKind, "provider_error");
  assert.equal(research.httpStatus, 400);
  assert.ok(!JSON.stringify(research).includes("secret-value"));
  assert.equal(
    providerCompletion({ stopReason: "error", content: [] }).failureKind,
    "empty",
  );
  assert.equal(
    providerCompletion({ stopReason: "stop", content: [] }).failureKind,
    undefined,
  );
});
