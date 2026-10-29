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
  tool?: { name: string; args: unknown },
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
          tool_calls: [
            {
              index: 0,
              id: "call_fixture",
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.args),
              },
            },
          ],
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
  "legacy",
  "user-text",
  "user-map",
]) {
  test(`#3572 Flash harness: ${scenario}`, async (t) => {
    const events: any[] = [];
    const saved: any[] = [];
    const queries: any[] = [];
    const errors: unknown[] = [];
    const calls: { name: string; args: any }[] = [];
    const plan = () => calls.push({ name: "update_research", args: initial });
    const read = (args: any = { period }) =>
      calls.push({ name: "echo_inbox_messages", args });
    const refresh = () =>
      calls.push({
        name: "update_research",
        args:
          scenario === "incomplete"
            ? { ...updated, gaps: ["Earlier records remain unread"] }
            : updated,
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
    } else if (scenario === "pagination" || scenario === "refresh-required") {
      for (let page = 0; page < 10; page++) {
        read({ period, ...(page ? { cursor: page * 20 } : {}) });
        if ((page + 1) % 4 === 0 && scenario !== "refresh-required") refresh();
        if (page === 4 && scenario === "refresh-required") refresh();
      }
      refresh();
    } else {
      read();
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
        if (scenario === "selective" || scenario === "legacy")
          read({ period, search: "botanical survey" });
        refresh();
      }
    }
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
          if (scenario === "persistence-failure")
            return Response.json({ error: "unavailable" }, { status: 503 });
          const record = JSON.parse(init.body);
          assert.equal(record.sequence, saved.length + 1);
          saved.push(record);
          return Response.json({ sequence: record.sequence });
        }
        if (path === "/api/signal/inbox/messages") {
          queries.push(JSON.parse(init.body));
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
          assert.equal(synthesisCalls, 1);
          assert.ok((body.max_tokens ?? body.max_completion_tokens) <= 2048);
          assert.ok(!body.tools?.length);
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
            ["synthesis-failure", "empty-refresh", "no-draft"].includes(
              scenario,
            )
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
      if (["denied", "filtered", "persistence-failure"].includes(scenario))
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
      ["denied", "filtered", "persistence-failure", "cancel"].includes(scenario)
    ) {
      assert.equal(answer, undefined);
      if (scenario === "cancel" || scenario === "persistence-failure")
        assert.equal(synthesisCalls, 0);
      return;
    }
    assert.ok(answer);
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
    if (scenario === "refresh-required") assert.ok(queries.length <= 8);
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
