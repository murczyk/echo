import assert from "node:assert/strict";
import test from "node:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  ResearchBudget,
  SynthesisAuthorizationError,
  SynthesisContentFilterError,
  BUDGET_INABILITY,
  budgetFallback,
  chooseBudgetAnswer,
  synthesizeBudgetEvidence,
  toolCallLimit,
  terminalProviderFailure,
  validateExecutionPolicy,
  type ExecutionPolicy,
  synthesisConversation,
} from "./execution-policy.ts";
import { fileCitationHref } from "./devices.ts";

const policy: ExecutionPolicy = {
  preset: "fast",
  api: "openai-responses",
  reasoningEffort: "none",
  checkpointEffort: "none",
  synthesisEffort: "none",
  maxRuntimeSeconds: 120,
  finalizationSeconds: 30,
};
const evidence = {
  messages: [
    {
      messageId: 42,
      messageIdentifier: "source-42",
      text: "Verified source text",
      datetime: "2026-10-09T10:00:00Z",
      author: "",
      group: "",
    },
  ],
  files: [],
};
const engine = {
  id: "gpt-6-sol",
  name: "Sol",
  provider: "echo-fixture",
  api: "openai-responses" as const,
  reasoning: true,
  baseUrl: "https://echo.example.test/api/ai-agent/provider/v1",
  input: ["text" as const],
  contextWindow: 65536,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { off: "none" },
};

test("#3746 validates partial follow-ups against current evidence, retaining historical links only for canonicalization", () => {
  const section = {
    source: {
      deviceId: "01999999-1111-7111-8111-111111111111",
      fileId: "01999999-2222-7222-8222-222222222222",
      revision: 3,
    },
    name: "report.txt",
    locator: "page 1",
    text: "Retrieved file excerpt",
  };
  const files = { messages: [], files: [section] };
  const fileAnswer = `File summary [джерело](${fileCitationHref(section.source)})`;
  assert.equal(
    chooseBudgetAnswer(fileAnswer, files, evidence.messages),
    fileAnswer,
  );
  const oldMessageAnswer =
    "Earlier message [джерело](/rer-analysis-neo?m=source-42)";
  assert.equal(
    chooseBudgetAnswer(oldMessageAnswer, files, evidence.messages),
    budgetFallback(),
  );
  assert.equal(
    chooseBudgetAnswer(oldMessageAnswer, evidence, evidence.messages),
    oldMessageAnswer,
  );
  assert.equal(
    chooseBudgetAnswer("Uncited summary", evidence, evidence.messages),
    budgetFallback(),
  );
  const historical = { messageId: 7, messageIdentifier: "historical-7" };
  const mixed = `${fileAnswer}\n${oldMessageAnswer}\nEarlier [source](/rer-analysis-neo?m=7)`;
  assert.equal(
    chooseBudgetAnswer(mixed, { ...evidence, files: [section] }, [
      ...evidence.messages,
      historical,
    ]),
    `${fileAnswer}\n${oldMessageAnswer}\nEarlier [джерело](/rer-analysis-neo?m=historical-7)`,
  );
});

test("#3998 final synthesis keeps parsed DMR metadata beside the message text", async () => {
  let serialized = "";
  await synthesizeBudgetEvidence(
    {
      engine,
      apiKey: "fixture-capability",
      policy,
      systemPrompt: "Summarize evidence",
      prompt: "144.8450 Мишаня Якудза, СС3",
      evidence: { messages: [{ ...evidence.messages[0], dmr: { colorCodes: ["3"], callGroups: [{ id: "24538" }] } }], files: [] },
      maxTokens: 8192,
      signal: new AbortController().signal,
    },
    async (_engine, context) => {
      serialized = JSON.stringify(context.messages);
      return { stopReason: "stop", content: [{ type: "text", text: "done" }] } as any;
    },
  );
  assert.match(serialized, /\\"dmr\\":\{\\"colorCodes\\":\[\\"3\\"\]/);
});

test("#3724 reserves finalization after the original deadline without restarting on checkpoints", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let stopped = 0;
  const budget = new ResearchBudget(policy, 121000, () => stopped++);
  try {
    t.mock.timers.tick(89999);
    budget.assertResearch();
    t.mock.timers.tick(1);
    assert.equal(stopped, 1);
    assert.equal(budget.reason, "time_limit");
    assert.throws(() => budget.assertResearch());
    assert.equal(budget.finalization.signal.aborted, false);
    t.mock.timers.tick(29000);
    assert.equal(budget.finalization.signal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test("#3724 returns a short notice, never raw excerpts, when synthesis ignores cancellation", async () => {
  const cancellation = new AbortController();
  let calls = 0;
  const response = synthesizeBudgetEvidence(
    {
      engine,
      apiKey: "fixture-capability",
      policy,
      systemPrompt: "Summarize evidence",
      prompt: "Report",
      evidence,
      maxTokens: 8192,
      signal: cancellation.signal,
    },
    async () => {
      calls++;
      return await new Promise(() => undefined);
    },
  );
  cancellation.abort();
  assert.equal(await response, null);
  assert.equal(calls, 1);
  const fallback = budgetFallback();
  assert.equal(fallback, BUDGET_INABILITY);
  assert.ok(!fallback.includes("Verified source text"));
  assert.ok(!fallback.includes("уривки джерел"));
  assert.ok(!fallback.includes("/rer-analysis-neo"));
});

test("#3724 synthesizes from a checkpoint when collected raw evidence exceeds context", async () => {
  const oversized = {
    ...evidence,
    messages: [
      {
        ...evidence.messages[0],
        text: "Verified source text. ".repeat(40_000),
      },
    ],
  };
  const checkpoint =
    "Verified source summary [джерело](/rer-analysis-neo?m=source-42)";
  for (const scenario of [
    { evidence: oversized, checkpoint, expectedCalls: 1 },
    { evidence: oversized, checkpoint: undefined, expectedCalls: 0 },
    {
      evidence: oversized,
      checkpoint: checkpoint.repeat(10_000),
      expectedCalls: 0,
    },
    { evidence: { messages: [], files: [] }, checkpoint, expectedCalls: 0 },
  ]) {
    let calls = 0;
    const answer = await synthesizeBudgetEvidence(
      {
        engine,
        apiKey: "fixture-capability",
        policy,
        systemPrompt: "Summarize evidence",
        prompt: "Report",
        evidence: scenario.evidence,
        checkpoint: scenario.checkpoint,
        maxTokens: 8192,
        signal: new AbortController().signal,
      },
      async (_engine, context) => {
        calls++;
        assert.equal(context.messages.length, 2);
        assert.ok(JSON.stringify(context.messages[1]).includes(checkpoint));
        return {
          stopReason: "stop",
          content: [{ type: "text", text: checkpoint }],
        } as any;
      },
    );
    assert.equal(calls, scenario.expectedCalls);
    if (scenario.expectedCalls) {
      assert.equal(
        chooseBudgetAnswer(answer, oversized, evidence.messages),
        checkpoint,
      );
      assert.equal(
        chooseBudgetAnswer("Uncited summary", oversized, evidence.messages),
        budgetFallback(),
      );
    } else assert.equal(answer, null);
  }
});

test("#3724 does not turn revoked provider access into a completed partial answer", async () => {
  for (const summarize of [
    async () =>
      ({
        stopReason: "error",
        errorMessage: "401 Provider capability is invalid or expired",
      }) as any,
    async () => {
      throw new Error("403 Forbidden");
    },
  ])
    await assert.rejects(
      synthesizeBudgetEvidence(
        {
          engine,
          apiKey: "revoked-capability",
          policy,
          systemPrompt: "Summarize evidence",
          prompt: "Report",
          evidence,
          maxTokens: 8192,
          signal: new AbortController().signal,
        },
        summarize,
      ),
      SynthesisAuthorizationError,
    );
});

function responseStream(output: Record<string, unknown>[]): Response {
  const events = output.flatMap((item, index) => [
    {
      type: "response.output_item.added",
      output_index: index,
      item: {
        ...item,
        ...(item.type === "function_call" ? { arguments: "" } : {}),
      },
    },
    { type: "response.output_item.done", output_index: index, item },
  ]);
  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture",
      status: "completed",
      output,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  } as any);
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("#3724 Responses keeps encrypted reasoning and call IDs across a tool round trip", async () => {
  const bodies: any[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${engine.baseUrl}/responses`);
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "medium");
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    return responseStream(
      bodies.length === 1
        ? [
            {
              id: "rs_fixture",
              type: "reasoning",
              summary: [],
              encrypted_content: "opaque-fixture",
            },
            {
              id: "fc_fixture",
              type: "function_call",
              call_id: "call_fixture",
              name: "echo_lookup",
              arguments: '{"query":"fixture"}',
              status: "completed",
            },
          ]
        : [
            {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Found [джерело](/rer-analysis-neo?m=source-42)",
                  annotations: [],
                },
              ],
            },
          ],
    );
  };
  const tools = [
    {
      name: "echo_lookup",
      description: "Look up evidence",
      parameters: Type.Object({ query: Type.String() }),
    },
  ];
  const prompt = {
    role: "user" as const,
    content: "Find fixture",
    timestamp: Date.now(),
  };
  const options = {
    apiKey: "fixture-capability",
    reasoning: "medium" as const,
    fetch,
    maxRetries: 0,
  };
  const first = await completeSimple(
    engine,
    { messages: [prompt], tools },
    options,
  );
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  const call = first.content.find((item) => item.type === "toolCall");
  assert.ok(call);
  const second = await completeSimple(
    engine,
    {
      messages: [
        prompt,
        first,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: evidence.messages[0].text }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      tools,
    },
    options,
  );
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.ok(
    bodies[1].input.some(
      (item: any) =>
        item.type === "reasoning" &&
        item.encrypted_content === "opaque-fixture",
    ),
  );
  const replay = bodies[1].input.find(
    (item: any) => item.type === "function_call",
  );
  const result = bodies[1].input.find(
    (item: any) => item.type === "function_call_output",
  );
  assert.equal(replay.call_id, result.call_id);
  assert.equal(result.output, evidence.messages[0].text);
});


test("#3724 bounds early context recovery by the finalization allowance", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const budget = new ResearchBudget(policy, 121000, () => {});
  try {
    budget.limit("context_limit");
    assert.equal(budget.research.signal.aborted, true);
    t.mock.timers.tick(29999);
    assert.equal(budget.finalization.signal.aborted, false);
    budget.limit("tool_limit");
    assert.equal(budget.reason, "context_limit");
    t.mock.timers.tick(1);
    assert.equal(budget.finalization.signal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test("#3985 document requests in short modes and Deep runs get their own budgets", () => {
  const balanced = { ...policy, preset: "balanced" as const, maxRuntimeSeconds: 300, finalizationSeconds: 60 };
  const document = { ...balanced, maxRuntimeSeconds: 1800, finalizationSeconds: 240, documentTask: true };
  // A bounded engine's document request keeps Balanced effort with the doubled 30-minute reserve.
  assert.equal(validateExecutionPolicy(document, 1000, [1, 2])?.maxRuntimeSeconds, 1800);
  assert.throws(() => validateExecutionPolicy({ ...document, documentTask: false }, 1000, [1, 2]));
  assert.throws(() => validateExecutionPolicy({ ...document, preset: "deep" }, 1000, [1, 2]));
  assert.throws(() => validateExecutionPolicy({ ...document, documentTask: "yes" }, 1000, [1, 2]));
  const deep = { ...policy, preset: "deep" as const, maxRuntimeSeconds: 14_400, finalizationSeconds: 600 };
  assert.equal(validateExecutionPolicy(deep, 1000, [1, 2])?.maxRuntimeSeconds, 14_400);
  // Deep requests queued before the 4-hour budget still run on their 30-minute policy.
  const queued = { ...deep, maxRuntimeSeconds: 1800, finalizationSeconds: 240 };
  assert.equal(validateExecutionPolicy(queued, 1000, [1, 2])?.maxRuntimeSeconds, 1800);
  assert.deepEqual(
    [toolCallLimit(undefined), toolCallLimit(balanced), toolCallLimit(document), toolCallLimit(queued), toolCallLimit(deep)],
    [128, 128, 128, 128, 1024],
  );
});

test("#4112 reports provider failures that end a run so Echo can offer another model", () => {
  assert.deepEqual(
    terminalProviderFailure(
      new Error("provider request failed: provider_error: unclassified provider failure"),
    ),
    {
      type: "completion_diagnostic",
      stage: "answer",
      outcome: "transient_error",
      failureKind: "provider_error",
    },
  );
  assert.equal(
    terminalProviderFailure(
      new Error("provider request failed: rate_limit: provider rate limit or model deployment cooldown"),
    )?.failureKind,
    "rate_limit",
  );
  assert.deepEqual(terminalProviderFailure(new SynthesisContentFilterError("filtered")), {
    type: "completion_diagnostic",
    stage: "answer",
    outcome: "content_filter",
  });
  assert.equal(
    terminalProviderFailure(
      new Error("provider request failed: content_filter: provider content filter"),
    )?.outcome,
    "content_filter",
  );
  assert.equal(
    terminalProviderFailure(
      new Error("provider request failed: authorization: provider authorization rejected"),
    ),
    null,
  );
  assert.equal(
    terminalProviderFailure(new Error("context checkpoint failed: error (reason: provider_error)"))
      ?.outcome,
    "transient_error",
  );
  assert.equal(
    terminalProviderFailure(new Error("context checkpoint failed: error (reason: content_filter)"))
      ?.outcome,
    "content_filter",
  );
  assert.equal(
    terminalProviderFailure(new Error("context checkpoint failed: error (reason: authorization)")),
    null,
  );
  assert.equal(terminalProviderFailure(new Error("bootstrap exchange returned HTTP 500")), null);
  assert.equal(terminalProviderFailure(new Error("work journal append failed")), null);
});

test("#4115 synthesis keeps the opening rules and the newest turns within its budget", () => {
  const entry = (role: string, chars: number, tag: string) => ({ role, content: `${tag}${"x".repeat(chars - tag.length)}` });
  const history = [
    entry("user", 30, "rules"),
    entry("assistant", 300, "a1"),
    entry("user", 300, "u2"),
    entry("assistant", 300, "a2"),
    entry("user", 300, "u3"),
  ];
  const tags = (budget: number, from = history) =>
    synthesisConversation(from, budget).map(({ content }) => content.replace(/x+$/, ""));
  // 10 tokens of rules, then 100 per entry, newest first, oldest first in the result.
  assert.deepEqual(tags(230), ["rules", "a2", "u3"]);
  // A gap stops filling, so the recent part stays contiguous.
  assert.deepEqual(tags(320, [...history.slice(0, 3), entry("assistant", 900, "big"), history[4]]), ["rules", "u3"]);
  // Rules larger than half the budget give way to recent turns.
  assert.deepEqual(tags(210, [entry("user", 330, "rules"), ...history.slice(1)]), ["a2", "u3"]);
  // A short history is kept whole, without a duplicate opening.
  assert.deepEqual(tags(10_000), ["rules", "a1", "u2", "a2", "u3"]);
  assert.deepEqual(synthesisConversation([], 1000), []);
  assert.deepEqual(Object.keys(synthesisConversation([{ role: "user", content: "a", citations: [] } as any], 10)[0]), ["role", "content"]);
});
