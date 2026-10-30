import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, validatePayload } from "./runner.ts";
import {
  FlashResearch,
  FLASH_ENGINE,
  FLASH_INABILITY,
  validatedFlashAnswer,
} from "./flash-research.ts";
import {
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

for (const scenario of [
  "selective",
  "retry-length",
  "retry-citation",
  "retry-stream",
  "retry-empty",
  "retry-deadline",
  "long-evidence",
  "large-draft",
  "pagination-guard",
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
  "plan-required",
  "refresh-required",
  "batch-refresh",
  "batch-refresh-rejected",
  "batch-refresh-persistence-failure",
  "api-failure",
  "legacy",
  "user-text",
  "user-map",
]) {
  test(`#3572 Flash harness: ${scenario}`, async (t) => {
    const events: any[] = [];
    const saved: any[] = [];
    const queries: any[] = [];
    const documents: any[] = [];
    const errors: unknown[] = [];
    const calls: { name: string; args: any }[] = [];
    const pagination = ["pagination", "refresh-required"].includes(scenario)
      ? { paginationReason: "User requested every archive record." }
      : {};
    const plan = () =>
      calls.push({
        name: "update_research",
        args: { ...initial, ...pagination },
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
    if (scenario === "plan-required") read();
    plan();
    calls.push({
      name: "report_progress",
      args: { summary: "Reviewing botanical archive records." },
    });
    if (["user-text", "user-map"].includes(scenario)) {
      calls.length = 0;
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
    if (scenario === "refresh-final") read({ period, search: "late survey" });
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
            (scenario === "batch-refresh-persistence-failure" &&
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
          if (scenario === "api-failure" && queries.length === 2)
            return Response.json({ error: "unavailable" }, { status: 503 });
          assert.ok(
            saved.some((record) => record.kind === "checkpoint"),
            "initial plan must be saved before retrieval",
          );
          if (scenario === "cancel") {
            process.emit("SIGTERM");
            throw new DOMException("Aborted", "AbortError");
          }
          if (scenario === "deadline") clockOffset += 61_000;
          return Response.json({
            inbox_items: Array.from(
              {
                length:
                  scenario === "checkpoint-failure" ||
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
          if (scenario === "user-map")
            assert.ok(JSON.stringify(body).includes(`echo-map:${mapId}`));
          synthesisCalls++;
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
            ].includes(scenario)
          )
            return stream("UNFINISHED_ANSWER", undefined, "length");
          if (scenario === "invalid-synthesis")
            return stream(
              `${draft} Invented [джерело](/rer-analysis-neo?m=missing)`,
            );
          return stream(
            scenario === "user-text"
              ? "The botanical survey is ready."
              : scenario === "user-map"
                ? `[мапа](echo-map:${mapId})`
                : draft,
          );
        }
        assert.equal(purpose, "research");
        researchCalls++;
        assert.ok(researchCalls < 140);
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
              ...(scenario === "batch-refresh-rejected" && forcedUpdates === 1
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
        return stream("PRIVATE_RESEARCH_NARRATION", call);
      } catch (error) {
        if (error instanceof assert.AssertionError) errors.push(error);
        throw error;
      }
    });
    try {
      const payload = validatePayload(
        {
          prompt:
            scenario === "user-text"
              ? "Translate into English: Ботанічне дослідження готове."
              : scenario === "user-map"
                ? "Make a map of Orchard at latitude 50, longitude 30."
                : scenario === "pagination"
                  ? "Read every archive record and summarize them."
                  : "Summarize today's archive records.",
          modelName: FLASH_ENGINE,
          providerTransport: "echo_gateway",
          providerApiKey: "fixture-capability",
          echoPublicHost: "echo.example.test",
          bootstrapToken: "A".repeat(43),
          correlationId,
          contextWindow: 65_536,
          maxTokens: 8192,
          checkpointMaxTokens: 8192,
          compactionReserveTokens:
            scenario === "checkpoint-failure" ? 48_000 : 16_384,
          compactionKeepRecentTokens: 1024,
          ...(scenario === "legacy"
            ? {}
            : { executionPolicy: policy, deadlineAt: Date.now() + 120_000 }),
          timeContext: {
            timeZone: "Europe/Kyiv",
            requestStartedAtUtc: new Date(Date.now()).toISOString(),
          },
          workMemory: {
            version: 1,
            ...(scenario === "follow-up"
              ? { recap: `Saved botanical survey: ${draft}`, ...sources }
              : { citations: [], fileCitations: [] }),
          },
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
    assert.ok(!events.some((event) => event.type === "assistant_delta"));
    assert.ok(!JSON.stringify(events).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(events).includes("update_research"));
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
      return;
    }
    assert.ok(answer);
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
    if (scenario === "large-draft") {
      assert.ok(answer.length > 3000);
      assert.ok(answer.startsWith("## Archive"));
    }

    assert.ok(!answer.includes("UNFINISHED"));
    assert.ok(!answer.includes("уривки джерел"));
    if (scenario === "no-draft") assert.ok(answer.includes(FLASH_INABILITY));
    else if (scenario === "user-text")
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
    if (scenario === "plan-required") assert.equal(queries.length, 1);
    if (scenario === "refresh-required") {
      assert.equal(queries.length, 10);
      assert.ok(forcedUpdates > 0);
    }
    if (scenario.startsWith("batch-refresh")) {
      assert.equal(queries.length, 5);
      assert.equal(documents.length, 1);
      assert.equal(
        forcedUpdates,
        scenario === "batch-refresh-rejected" ? 2 : 1,
      );
    }
    const failures = events.filter(
      (event) => event.type === "tool_end" && event.is_error,
    );
    if (
      ["batch-refresh", "batch-refresh-rejected", "refresh-required"].includes(
        scenario,
      )
    )
      assert.deepEqual(failures, []);
    if (scenario === "plan-required")
      assert.equal(
        failures[0].errorSummary,
        "Потрібно зберегти проміжні результати аналізу перед наступним пошуком.",
      );
    if (scenario === "api-failure") {
      assert.equal(queries.length, 2);
      assert.equal(failures.length, 1);
      assert.equal(
        failures[0].errorSummary,
        "Не вдалося завантажити дані за вказаними параметрами.",
      );
    }
    if (scenario === "slow-provider" || scenario === "deadline")
      assert.equal(queries.length, 1);
    if (scenario === "checkpoint-failure") assert.ok(checkpoints > 0);
    if (
      [
        "incomplete",
        "pagination",
        "tool-limit",
        "slow-provider",
        "deadline",
        "checkpoint-failure",
      ].includes(scenario)
    ) {
      if (!["incomplete", "pagination"].includes(scenario))
        assert.ok(
          events.some(
            (event) =>
              event.type === "completion_metadata" && event.coverageLimited,
          ),
        );
      assert.ok(answer.includes("Охоплення джерел неповне"));
    }
    const checkpointsSaved = saved.filter(
      (record) => record.kind === "checkpoint",
    );
    if (["user-text", "user-map"].includes(scenario))
      assert.equal(queries.length, 0);
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
    ["deep", 1800, 120],
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
    assert.throws(() => validateExecutionPolicy(original, 1000, true));
    assert.equal(
      validateExecutionPolicy(
        { ...original, finalizationSeconds: reserve * 2 },
        1000,
        true,
      )?.maxRuntimeSeconds,
      runtime,
    );
    assert.throws(() =>
      validateExecutionPolicy(
        { ...original, finalizationSeconds: reserve * 2 },
        1000,
      ),
    );
  }
});
