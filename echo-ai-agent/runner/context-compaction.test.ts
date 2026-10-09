import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  createToolResponseCompactor,
  validateFinalAssistantMessage,
} from "./runner.ts";

// Regression: https://github.com/echoua/echo/issues/3724
async function fixture(
  pages: number,
  checkpoint = "stop",
  restored = false,
  batchWidth = 1,
  checkpointSettings: { maxTokens?: number; reserveTokens: number } = {
    maxTokens: 16_384,
    reserveTokens: 16_384,
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "echo-context-regression-"));
  let pagesRead = 0;
  let checkpointCalls = 0;
  let progressCalls = 0;
  let resetCalls = 0;
  const cursors: number[] = [];
  const requests: any[] = [];
  const errors: unknown[] = [];
  const firstCitation = "https://example.invalid/?m=fixture-1";
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
        body.max_tokens ?? body.max_completion_tokens,
        summary ? (checkpointSettings.maxTokens ?? 8_192) : 8_192,
      );
      let delta: any;
      let finishReason = "stop";
      if (summary) {
        checkpointCalls += 1;
        assert.ok(body.messages[1].content.includes("Original request:"));
        assert.ok(body.messages[1].content.includes("2026-10-09"));
        if (checkpoint === "cancel") {
          cancellation.abort();
          response.destroy();
          return;
        }
        finishReason = checkpoint === "length" ? "length" : "stop";
        const content =
          checkpoint === "empty"
            ? ""
            : checkpoint === "unchanged"
              ? "Non-reducing checkpoint. ".repeat(30_000)
              : `Original request preserved. Fixed day: 2026-10-08/2026-10-09. Alpha received documents, source ${firstCitation}. Continue the cursor from the retained latest page; coverage remains incomplete.`;
        delta = { role: "assistant", content };
        if (checkpoint === "reasoning")
          delta.reasoning_content = "Evidence checkpoint reasoning";
      } else if (pagesRead < pages) {
        const tools = body.messages.filter(
          (message: any) => message.role === "tool",
        );
        if (pagesRead > 0) {
          assert.ok(
            tools.length > 0,
            "latest tool-call/result batch survives compaction",
          );
          assert.equal(
            JSON.parse(tools.at(-1).content).nextCursor,
            pagesRead * 20,
          );
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
      } else {
        assert.ok(JSON.stringify(body.messages).includes(firstCitation));
        delta = {
          role: "assistant",
          content: `Alpha: completed ${pagesRead * 20} fixture messages. [Source](${firstCitation})`,
        };
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
              maxTokens: 8_192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
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
    systemPrompt: "Evidence report fixture. ".repeat(800),
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
              `Alpha fixture ${id}: ` + "Synthetic document event. ".repeat(65),
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
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: selectedEngine,
    thinkingLevel: "off",
    noTools: "all",
    tools: [tool.name],
    customTools: [tool],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  const contextFailure = installContextCompaction(
    session,
    {
      prompt,
      maxTokens: 8_192,
      checkpointMaxTokens: checkpointSettings.maxTokens,
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
    progressCalls: () => progressCalls,
    resetCalls: () => resetCalls,
    contextFailure,
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

for (const mode of ["length", "empty", "unchanged", "cancel"]) {
  test(`#3724 preserves source history when checkpoint is ${mode}`, async () => {
    const value = await fixture(7, mode);
    try {
      await value.session.prompt(value.prompt);
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
