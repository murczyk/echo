import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installContextCompaction } from "./context-compaction.ts";
import { assistantSnapshotEvent } from "./citations.ts";
import {
  createToolResponseCompactor,
  recoverFinalOutputLimit,
  validateFinalAssistantMessage,
  validatePayload,
  writeModelsFile,
} from "./runner.ts";

// Regression: https://github.com/echoua/echo/issues/3724
async function fixture(
  pages: number,
  checkpoint = "stop",
  restored = false,
  batchWidth = 1,
  checkpointSettings: {
    maxTokens?: number;
    reserveTokens: number;
    modelName?: string;
    finalOutput?: string;
  } = {
    maxTokens: 16_384,
    reserveTokens: 16_384,
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "echo-context-regression-"));
  let pagesRead = 0;
  let checkpointCalls = 0;
  let checkpointInterruptions = 0;
  let progressCalls = 0;
  let resetCalls = 0;
  let finalCalls = 0;
  let mutations = 0;
  const cursors: number[] = [];
  const requests: any[] = [];
  const errors: unknown[] = [];
  const firstCitation = "https://example.invalid/?m=fixture-1";
  const primaryMaxTokens =
    checkpointSettings.finalOutput === "large-draft" ? 16_384 : 8_192;
  const cancellation = new AbortController();
  const prompt = restored
    ? "Review this pending request. ".repeat(2_000)
    : "Report the fixed day, grouped by unit, with citations.";
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const system = body.messages[0].content;
      const summary = system.includes("Create a concise evidence checkpoint");
      assert.equal(
        body.model,
        summary ? (checkpointSettings.modelName ?? "fixture") : "fixture",
      );
      assert.equal(
        body.max_tokens ?? body.max_completion_tokens,
        summary ? (checkpointSettings.maxTokens ?? 8_192) : primaryMaxTokens,
      );
      let delta: any;
      let finishReason = "stop";
      if (summary) {
        checkpointCalls += 1;
        if (checkpoint === "denied") {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "Provider access denied" } }),
          );
          return;
        }
        if (
          checkpoint === "connection-error" ||
          (checkpoint === "connection-once" && checkpointCalls <= 3)
        ) {
          response.writeHead(502, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "Provider connection failed" },
            }),
          );
          return;
        }
        assert.ok(!body.messages[1].content.includes("Unfinished draft."));
        assert.ok(body.messages[1].content.includes("Original request:"));
        assert.ok(body.messages[1].content.includes("2026-10-09"));
        if (body.messages[1].content.includes("[Tool result]:")) {
          assert.ok(body.messages[1].content.includes("Late-page Bravo"));
          assert.ok(
            [...body.messages[1].content.matchAll(/\?m=fixture-(\d+)/g)].some(
              (match) => Number(match[1]) % 20 === 0,
            ),
          );
          assert.ok(
            !body.messages[1].content.includes("more characters truncated"),
          );
        }
        if (
          checkpoint === "cancel" ||
          (finalCalls > 0 &&
            checkpointSettings.finalOutput === "cancel-recovery")
        ) {
          cancellation.abort();
          response.destroy();
          return;
        }
        finishReason =
          checkpoint === "length" ||
          (finalCalls > 0 &&
            checkpointSettings.finalOutput === "checkpoint-limit")
            ? "length"
            : "stop";
        if (
          ["stream-error", "network-error", "filtered"].includes(checkpoint) ||
          (["stream-once", "network-once"].includes(checkpoint) &&
            checkpointCalls === 1) ||
          (checkpoint === "recovery-network" &&
            finalCalls > 0 &&
            checkpointInterruptions++ === 0)
        ) {
          finishReason = checkpoint.startsWith("stream-")
            ? ""
            : checkpoint === "filtered"
              ? "content_filter"
              : "network_error";
        }
        const content =
          finishReason !== "stop" && finishReason !== "length"
            ? "Unfinished checkpoint must not replace source evidence."
            : checkpoint === "empty"
              ? ""
              : checkpoint === "unchanged"
                ? "Non-reducing checkpoint. ".repeat(30_000)
                : `Original request preserved. Fixed day: 2026-10-08/2026-10-09. Alpha received documents, source ${firstCitation}. Continue nextCursor=${pagesRead * 20}; coverage remains incomplete.`;
        delta = { role: "assistant", content };
        if (checkpoint === "reasoning")
          delta.reasoning_content = "Evidence checkpoint reasoning";
      } else if (pagesRead < pages) {
        const tools = body.messages.filter(
          (message: any) => message.role === "tool",
        );
        if (pagesRead > 0) {
          if (checkpoint === "retained-batch" && tools.length === 0)
            assert.ok(
              JSON.stringify(body.messages).includes(
                `nextCursor=${pagesRead * 20}`,
              ),
            );
          else {
            assert.ok(
              tools.length > 0,
              "latest tool-call/result batch survives compaction",
            );
            assert.equal(
              JSON.parse(tools.at(-1).content).nextCursor,
              pagesRead * 20,
            );
          }
        }
        delta = {
          role: "assistant",
          tool_calls: Array.from(
            { length: Math.min(batchWidth, pages - pagesRead) },
            (_, index) => ({
              index,
              id: `call_${pagesRead + index}`,
              type: "function",
              function: {
                name: "echo_inbox_messages",
                arguments: JSON.stringify({ cursor: (pagesRead + index) * 20 }),
              },
            }),
          ),
        };
        finishReason = "tool_calls";
      } else if (
        checkpointSettings.finalOutput === "mutation" &&
        (mutations === 0 ||
          (mutations === 1 &&
            finalCalls > 0 &&
            body.tools?.some(
              (tool: any) => tool.function.name === "echo_map_edit",
            )))
      ) {
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `mutation_${mutations}`,
              type: "function",
              function: { name: "echo_map_edit", arguments: "{}" },
            },
          ],
        };
        finishReason = "tool_calls";
      } else {
        if (checkpointSettings.finalOutput && finalCalls > 0) {
          assert.ok(
            system.includes("final synthesis after evidence collection"),
          );
          assert.ok(system.includes("Respect fixture tenant instructions."));
          assert.ok(system.includes("2026-10-09T04:38:34Z"));
          assert.ok(system.includes("Europe/Kyiv"));
          assert.ok(!system.includes("Evidence report fixture."));
        }
        finalCalls += 1;
        assert.ok(JSON.stringify(body.messages).includes(firstCitation));
        if (
          finalCalls === 1 &&
          ["error-limit", "provider-error"].includes(
            checkpointSettings.finalOutput ?? "",
          )
        ) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message:
                  checkpointSettings.finalOutput === "error-limit"
                    ? "Provider output token limit reached"
                    : "Provider request validation failed",
              },
            }),
          );
          return;
        }
        delta = {
          role: "assistant",
          content: `Alpha: completed ${pagesRead * 20} fixture messages. [Source](${firstCitation})`,
        };
        if (
          checkpointSettings.finalOutput &&
          (finalCalls === 1 ||
            checkpointSettings.finalOutput === "always-length")
        ) {
          finishReason = "length";
          delta = {
            reasoning_content: "Synthetic unsuccessful provider reasoning",
            ...(checkpointSettings.finalOutput === "large-draft"
              ? { content: "Unfinished draft. ".repeat(3_800) }
              : {}),
          };
        }
      }
      const promptTokens = Math.ceil(
        (JSON.stringify(body.messages).length +
          JSON.stringify(body.tools ?? []).length) /
          4,
      );
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: promptTokens, completion_tokens: summary && checkpoint === "reasoning" ? 10_000 : 64, total_tokens: promptTokens + (summary && checkpoint === "reasoning" ? 10_000 : 64) } })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end("fixture failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const modelsPath = join(directory, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          compat: { supportsDeveloperRole: false },
          models: [
            {
              id: "fixture",
              name: "fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 65_536,
              maxTokens: primaryMaxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            ...(checkpointSettings.modelName &&
            checkpointSettings.modelName !== "fixture"
              ? [
                  {
                    id: checkpointSettings.modelName,
                    name: checkpointSettings.modelName,
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 65_536,
                    maxTokens: checkpointSettings.maxTokens ?? 8_192,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
  if (checkpointSettings.modelName === "fixture") {
    const payload = validatePayload(
      {
        echoPublicHost: "echo-staging.example.test",
        modelName: "fixture",
        checkpointModelName: "fixture",
        checkpointContextWindow: 65_536,
        providerTransport: "echo_gateway",
        providerApiKey: "fixture",
        contextWindow: 65_536,
        maxTokens: primaryMaxTokens,
        checkpointMaxTokens: checkpointSettings.maxTokens,
        compactionReserveTokens: checkpointSettings.reserveTokens,
        compactionKeepRecentTokens: 8_192,
        bootstrapToken: "A".repeat(43),
        correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e7",
        prompt,
        timeContext: {
          timeZone: "Europe/Kyiv",
          requestStartedAtUtc: "2026-10-09T04:38:34Z",
        },
        skills: [],
      },
      false,
    );
    const runtimeModelsPath = await writeModelsFile(directory, payload);
    const runtimeModels = JSON.parse(
      await readFile(runtimeModelsPath, "utf8"),
    );
    const provider = runtimeModels.providers["echo-vllm"];
    assert.equal(provider.models.length, 1);
    assert.equal(provider.models[0].maxTokens, primaryMaxTokens);
    provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      modelsPath,
      JSON.stringify({ providers: { fixture: provider } }),
    );
  }
  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    allowModelNetwork: false,
  });
  const selectedEngine = modelRuntime.getModel("fixture", "fixture");
  assert.ok(selectedEngine);
  const sessionManager = SessionManager.inMemory(directory);
  if (restored) {
    sessionManager.appendMessage({
      role: "user",
      content: "old-source ".repeat(9_000),
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      content: [{ type: "text", text: "old response ".repeat(2_500) }],
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 8_192,
    },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Evidence report fixture. ".repeat(
      checkpoint === "retained-batch" ? 6_000 : 800,
    ),
  });
  await resourceLoader.reload();
  const compact = createToolResponseCompactor();
  const tool = defineTool({
    name: "echo_inbox_messages",
    label: "Read fixture page",
    description: "Read the next page of fixture source messages.",
    parameters: Type.Object({ cursor: Type.Number() }),
    executionMode: "sequential",
    execute: async (_id, args) => {
      assert.equal(args.cursor, pagesRead * 20);
      cursors.push(args.cursor);
      const inbox_items = Array.from({ length: 20 }, (_, index) => {
        const id = pagesRead * 20 + index + 1;
        return [
          id,
          {
            message_uid: `fixture-${id}`,
            text:
              `Alpha fixture ${id}: ` +
              "Synthetic document event. ".repeat(65) +
              (index === 19 ? "Late-page Bravo received the documents." : ""),
            citation: `https://example.invalid/?m=fixture-${id}`,
          },
        ];
      });
      pagesRead += 1;
      return {
        content: [
          {
            type: "text",
            text: compact(
              { skill: "inbox_messages", requestKind: "inboxMessages" },
              { inbox_items, page_limit: 20 },
              20,
            ),
          },
        ],
      };
    },
  });
  const mutationTool = defineTool({
    name: "echo_map_edit",
    label: "Edit fixture map",
    description: "Add a fixture map point and advance its revision.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => ({
      content: [{ type: "text", text: `Map revision ${++mutations} saved` }],
    }),
  });
  const tools =
    checkpointSettings.finalOutput === "mutation"
      ? [tool, mutationTool]
      : [tool];
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: selectedEngine,
    thinkingLevel: "off",
    noTools: "all",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  const contextCompaction = installContextCompaction(
    session,
    {
      prompt,
      maxTokens: primaryMaxTokens,
      checkpointMaxTokens: checkpointSettings.maxTokens,
      checkpointEngine: checkpointSettings.modelName
        ? modelRuntime.getModel("fixture", checkpointSettings.modelName)
        : undefined,
      compactionReserveTokens: checkpointSettings.reserveTokens,
      compactionKeepRecentTokens: 8_192,
      providerApiKey: "fixture",
      timeContext: { requestStartedAtUtc: "2026-10-09T04:38:34Z" },
      signal: cancellation.signal,
    },
    () => (progressCalls += 1),
    (messages) => {
      resetCalls += 1;
      compact.reset(messages);
    },
  );
  return {
    session,
    prompt,
    errors,
    requests,
    cursors,
    firstCitation,
    checkpointCalls: () => checkpointCalls,
    finalCalls: () => finalCalls,
    mutations: () => mutations,
    progressCalls: () => progressCalls,
    resetCalls: () => resetCalls,
    contextFailure: contextCompaction.failure,
    contextCompaction,
    close: async () => {
      session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("#3724 preserves answer headroom while reasoning checkpoints exceed the answer output limit", async () => {
  const value = await fixture(7, "reasoning");
  try {
    await value.session.prompt(value.prompt);
    assert.equal(value.contextFailure(), undefined);
    validateFinalAssistantMessage(value.session.messages);
    assert.ok(value.checkpointCalls() > 0);
    assert.equal(value.cursors.length, 7);
    assert.deepEqual(value.errors, []);
  } finally {
    await value.close();
  }
});

test("#3724 keeps legacy checkpoint caps independent of larger context reserves", async () => {
  const value = await fixture(7, "stop", false, 1, { reserveTokens: 32_768 });
  try {
    await value.session.prompt(value.prompt);
    assert.equal(value.contextFailure(), undefined);
    validateFinalAssistantMessage(value.session.messages);
    assert.ok(value.checkpointCalls() > 0);
    assert.equal(value.cursors.length, 7);
    assert.deepEqual(value.errors, []);
  } finally {
    await value.close();
  }
});

for (const [pages, batchWidth] of [
  [7, 1],
  [14, 1],
  [14, 2],
]) {
  test(`#3724 resumes ${pages} pages in batches of ${batchWidth} through SDK compaction with full output budget and citations`, async () => {
    const value = await fixture(pages, "stop", false, batchWidth);
    try {
      await value.session.prompt(value.prompt);
      assert.deepEqual(value.errors, []);
      const last = value.session.messages.at(-1) as any;
      assert.notEqual(last.stopReason, "error", last.errorMessage);
      validateFinalAssistantMessage(value.session.messages);
      assert.ok(value.checkpointCalls() >= (pages === 7 ? 1 : 2));
      assert.equal(value.resetCalls(), value.checkpointCalls());
      assert.ok(value.progressCalls() > 0);
      assert.deepEqual(
        value.cursors,
        Array.from({ length: pages }, (_, index) => index * 20),
      );
      const final = value.session.messages.at(-1) as any;
      assert.ok(final.content[0].text.includes(value.firstCitation));
      await value.session.prompt("Summarize the same fixed period briefly.");
      validateFinalAssistantMessage(value.session.messages);
      assert.deepEqual(value.errors, []);
    } finally {
      await value.close();
    }
  });
}

test("#3724 checkpointed a large retained batch after a non-reducing prefix", async () => {
  const value = await fixture(4, "retained-batch", false, 2, {
    maxTokens: 8_192,
    reserveTokens: 16_384,
    modelName: "checkpoint",
  });
  try {
    await value.session.prompt(value.prompt);
    assert.ifError(value.contextFailure());
    validateFinalAssistantMessage(value.session.messages);
    assert.deepEqual(value.cursors, [0, 20, 40, 60]);
    assert.ok(value.checkpointCalls() >= 4);
    assert.ok(value.resetCalls() >= 2);
    assert.equal(
      value.session.sessionManager
        .getEntries()
        .filter(
          (entry: any) =>
            entry.type === "message" && entry.message.role === "toolResult",
        ).length,
      4,
    );
    assert.deepEqual(value.errors, []);
  } finally {
    await value.close();
  }
});

for (const checkpointModelName of ["checkpoint", "fixture"]) {
  test(`#3724 continued pagination and follow-ups with checkpoint engine ${checkpointModelName}`, async () => {
    const value = await fixture(14, "stop", false, 2, {
      maxTokens: 8_192,
      reserveTokens: 16_384,
      modelName: checkpointModelName,
    });
    try {
      await value.session.prompt(value.prompt);
      validateFinalAssistantMessage(value.session.messages);
      assert.ok(value.checkpointCalls() > 0);
      assert.equal(value.cursors.length, 14);
      await value.session.prompt("Summarize the same fixed period briefly.");
      validateFinalAssistantMessage(value.session.messages);
      assert.deepEqual(value.errors, []);
    } finally {
      await value.close();
    }
  });
}

for (const finalOutput of [
  "retry",
  "retry-network",
  "retry-primary",
  "mutation-primary",
  "large-draft",
  "error-limit",
  "provider-error",
  "mutation",
  "always-length",
  "checkpoint-limit",
  "cancel-recovery",
  "legacy",
]) {
  test(`#3724 bounded output recovery: ${finalOutput}`, async () => {
    const primaryCheckpoint = finalOutput.endsWith("-primary");
    const recoveryMode = primaryCheckpoint
      ? finalOutput.replace("-primary", "")
      : finalOutput;
    const value = await fixture(
      7,
      finalOutput === "retry-network" ? "recovery-network" : "stop",
      false,
      2,
      {
        maxTokens: primaryCheckpoint ? 16_384 : 8_192,
        reserveTokens: 16_384,
        modelName: finalOutput === "legacy" ? undefined : primaryCheckpoint ? "fixture" : "checkpoint",
        finalOutput: recoveryMode,
      },
    );
    const observed: unknown[] = [];
    const unsubscribe = value.session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        observed.push(event.message);
    });
    try {
      await value.session.prompt(value.prompt);
      assert.throws(
        () => validateFinalAssistantMessage(observed),
        finalOutput === "provider-error"
          ? /provider request failed/
          : /output token limit/,
      );
      const audit = structuredClone(value.session.sessionManager.getEntries());
      if (finalOutput === "large-draft")
        assert.ok(JSON.stringify(audit).includes("Unfinished draft."));
      const resets = value.resetCalls();
      const tools = value.session.agent.state.tools;
      const stream = value.session.agent.streamFunction;
      const emitAssistant = { current: true };
      const recovery = () =>
        recoverFinalOutputLimit(
          value.session,
          {
            prompt: value.prompt,
            checkpointModelName:
              finalOutput === "legacy" ? undefined : primaryCheckpoint ? "fixture" : "checkpoint",
            systemPrompt: "Respect fixture tenant instructions.",
            timeContext: {
              requestStartedAtUtc: "2026-10-09T04:38:34Z",
              requestStartedAtMs: Date.parse("2026-10-09T04:38:34Z"),
              timeZone: "Europe/Kyiv",
            },
          },
          observed,
          value.contextCompaction,
          emitAssistant,
        );
      if (
        finalOutput === "checkpoint-limit" ||
        finalOutput === "cancel-recovery"
      ) {
        await assert.rejects(recovery);
        assert.equal(value.resetCalls(), resets);
        assert.deepEqual(value.session.sessionManager.getEntries(), audit);
      } else {
        const recoverable = !["legacy", "provider-error"].includes(finalOutput);
        assert.equal(await recovery(), recoverable);
        assert.equal(value.finalCalls(), recoverable ? 2 : 1);
        assert.equal(value.resetCalls(), resets + (recoverable ? 1 : 0));
        assert.deepEqual(
          value.session.sessionManager.getEntries().slice(0, audit.length),
          audit,
        );
        if (
          [
            "retry",
            "retry-network",
            "large-draft",
            "mutation",
            "error-limit",
          ].includes(recoveryMode)
        ) {
          validateFinalAssistantMessage(observed);
          const answer = (observed.at(-1) as any).content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n");
          assert.deepEqual(assistantSnapshotEvent("", answer), {
            type: "assistant_snapshot",
            text: `Alpha: completed 140 fixture messages. [Source](${value.firstCitation})`,
          });
          assert.ok(
            !value.session.sessionManager
              .buildContextEntries()
              .some(
                (entry: any) =>
                  entry.type === "message" &&
                  entry.message.role === "toolResult",
              ),
          );
          assert.ok(
            !value.requests
              .at(-1)
              .messages.some((message: any) => message.role === "tool"),
          );
          assert.ok(!value.requests.at(-1).tools?.length);
          assert.ok(
            value.requests
              .at(-1)
              .messages.some(
                (message: any) =>
                  message.role === "user" &&
                  (message.content === value.prompt ||
                    (Array.isArray(message.content) &&
                      message.content.some(
                        (block: any) =>
                          block.type === "text" && block.text === value.prompt,
                      ))),
              ),
          );
        } else
          assert.throws(
            () => validateFinalAssistantMessage(observed),
            finalOutput === "provider-error"
              ? /provider request failed/
              : /output token limit/,
          );
      }
      assert.equal(value.mutations(), recoveryMode === "mutation" ? 1 : 0);
      assert.deepEqual(value.session.agent.state.tools, tools);
      assert.equal(value.session.agent.streamFunction, stream);
      assert.equal(emitAssistant.current, true);
      assert.deepEqual(value.errors, []);
    } finally {
      unsubscribe();
      await value.close();
    }
  });
}

test("#3724 includes system schemas and pending prompt when compacting restored history", async () => {
  const value = await fixture(0, "stop", true);
  try {
    await value.session.prompt(value.prompt);
    assert.deepEqual(value.errors, []);
    assert.ok(value.checkpointCalls() > 0);
    validateFinalAssistantMessage(value.session.messages);
    const request = value.requests.at(-1);
    assert.equal(
      request.messages.filter(
        (message: any) =>
          message.role === "user" &&
          (typeof message.content === "string"
            ? message.content
            : message.content.map((block: any) => block.text).join("")) ===
            value.prompt,
      ).length,
      1,
    );
  } finally {
    await value.close();
  }
});

for (const mode of ["stream-once", "network-once", "connection-once"]) {
  test(`#3724 retries an interrupted checkpoint once without replacing evidence with partial text: ${mode}`, async () => {
    const value = await fixture(7, mode);
    try {
      await value.session.prompt(value.prompt);
      assert.deepEqual(value.errors, []);
      validateFinalAssistantMessage(value.session.messages);
      assert.deepEqual(value.cursors, [0, 20, 40, 60, 80, 100, 120]);
      const checkpoints = value.requests.filter((request) =>
        request.messages[0].content.includes(
          "Create a concise evidence checkpoint",
        ),
      );
      assert.deepEqual(checkpoints[1], checkpoints[0]);
      assert.ok(value.resetCalls() > 0);
      assert.ok(
        !JSON.stringify(value.session.sessionManager.getEntries()).includes(
          "Unfinished checkpoint must not replace source evidence.",
        ),
      );
    } finally {
      await value.close();
    }
  });
}

for (const mode of [
  "stream-error",
  "network-error",
  "connection-error",
  "filtered",
  "denied",
]) {
  test(`#3724 preserves source evidence and bounds checkpoint retries: ${mode}`, async () => {
    const value = await fixture(7, mode);
    try {
      await value.session.prompt(value.prompt);
      assert.deepEqual(value.errors, []);
      assert.ok(value.contextFailure());
      assert.equal(
        value.checkpointCalls(),
        mode === "connection-error"
          ? 6
          : ["filtered", "denied"].includes(mode)
            ? 1
            : 2,
      );
      assert.equal(value.resetCalls(), 0);
      assert.equal(
        value.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction").length,
        0,
      );
      assert.ok(
        value.session.messages.some((message) => message.role === "toolResult"),
      );
    } finally {
      await value.close();
    }
  });
}

for (const mode of ["length", "empty", "unchanged", "cancel"]) {
  test(`#3724 preserves source history when checkpoint is ${mode}`, async () => {
    const value = await fixture(7, mode);
    try {
      await value.session.prompt(value.prompt);
      assert.deepEqual(value.errors, []);
      assert.throws(() =>
        validateFinalAssistantMessage(value.session.messages),
      );
      assert.equal(value.resetCalls(), 0);
      assert.ok(value.contextFailure());
      if (mode === "length")
        assert.match(
          String(value.contextFailure()),
          /context checkpoint failed: length/,
        );
      assert.equal(
        value.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction").length,
        0,
      );
      assert.ok(value.checkpointCalls() <= 2);
      assert.ok(
        value.session.messages.some((message) => message.role === "toolResult"),
      );
      assert.deepEqual(value.errors, []);
    } finally {
      await value.close();
    }
  });
}
