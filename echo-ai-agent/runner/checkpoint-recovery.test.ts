import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, validatePayload } from "./runner.ts";

const correlationId = "019fc7f7-9770-7f83-9c1a-211af29b02e6";
const citation = "/rer-analysis-neo?m=fixture-1";

function stream(
  api: string,
  content: string,
  stop: string,
  call?: number,
  outputTokens = 8192,
  recall = false,
): Response {
  const toolName = recall ? "echo_work_read" : "echo_inbox_messages";
  const args = JSON.stringify(recall ? { requestId: correlationId, after: 0, offset: 0 } : { period: { kind: "relative_days", days: 1 } });
  if (api === "openai-completions") {
    const delta =
      call === undefined
        ? { role: "assistant", content }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${call}`,
                type: "function",
                function: {
                  name: toolName,
                  arguments: args,
                },
              },
            ],
          };
    const chunk = (delta: unknown, finish: string | null) => ({
      id: "fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: outputTokens,
        total_tokens: 8292,
      },
    });
    return new Response(
      `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, call === undefined ? stop : "tool_calls"))}\n\ndata: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  }
  const item =
    call === undefined
      ? {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: content, annotations: [] }],
        }
      : {
          id: `fc_${call}`,
          type: "function_call",
          call_id: `call_${call}`,
          name: toolName,
          status: "completed",
          arguments: args,
        };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: call === undefined ? item : { ...item, arguments: "" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: stop === "length" ? "response.incomplete" : "response.completed",
      response: {
        id: "resp_fixture",
        status: stop === "length" ? "incomplete" : "completed",
        ...(stop === "length"
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: outputTokens,
          total_tokens: 8292,
        },
      },
    },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

for (const api of ["openai-responses", "openai-completions"]) {
  for (const outcome of [
    "answer",
    "empty-401",
    "length-403",
    "context-error",
    "output-error",
    "budget-error",
    "after-checkpoint",
    "length",
    "uncited",
    "denied",
    "filtered",
    "denied-synthesis",
    "filtered-synthesis",
    "cancel",
    "persistence-failure",
  ]) {
    test(`#3724 runner recovers checkpoint exhaustion via ${api}: ${outcome}`, async (t) => {
      const events: any[] = [];
      const errors: unknown[] = [];
      let pages = 0;
      let checkpoints = 0;
      let synthesis = 0;
      const savedWork: any[] = [];
      const oldSignals = {
        SIGINT: process.listeners("SIGINT"),
        SIGTERM: process.listeners("SIGTERM"),
      };
      const write = process.stdout.write.bind(process.stdout);
      t.mock.method(
        process.stdout,
        "write",
        (chunk: string, ...args: any[]) => {
          if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
            events.push(JSON.parse(chunk));
            return true;
          }
          return write(chunk, ...args);
        },
      );
      const fetch = async (url: unknown, init: any) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/ai-agent/bootstrap/exchange")
          return Response.json(
            { correlationId },
            { headers: { "set-cookie": "session=fixture; HttpOnly" } },
          );
        if (path === "/api/ai-agent/work/append") {
          if (outcome === "persistence-failure") return Response.json({ error: "storage unavailable" }, { status: 503 });
          const record = JSON.parse(init.body);
          assert.equal(record.sequence, savedWork.length + 1);
          savedWork.push(record);
          return Response.json({ sequence: record.sequence });
        }
        if (path === "/api/ai-agent/work/read") {
          pages += 1;
          assert.ok(pages <= 6);
          return Response.json({ requestId: correlationId, records: [{
            sequence: 1, kind: "tool", tool: "echo_inbox_messages", query: {},
            content: `Record 1: synthetic document received [джерело](${citation}). ` + "Synthetic archive text. ".repeat(3000),
            citations: [{ messageId: 1, messageIdentifier: "fixture-1" }], fileCitations: [],
          }], nextAfter: null, nextOffset: 0 });
        }
        if (path === "/api/signal/inbox/messages") {
          pages += 1;
          assert.ok(pages <= 6, "compaction must run before further tools");
          return Response.json({
            inbox_items: Array.from({ length: 20 }, (_, index) => {
              const id = (pages - 1) * 20 + index + 1;
              return [
                id,
                {
                  message_uuid: `fixture-${id}`,
                  text:
                    `Record ${id}: synthetic document received. ` +
                    "Synthetic archive text. ".repeat(210),
                  timestamp: 1791626400,
                },
              ];
            }),
            page_limit: 20,
          });
        }
        assert.ok(
          path.endsWith(
            api === "openai-responses" ? "/responses" : "/chat/completions",
          ),
        );
        const body = JSON.parse(init.body);
        const purpose = new Headers(init.headers).get("x-echo-ai-purpose");
        if (purpose === "checkpoint") {
          checkpoints += 1;
          assert.ok(checkpoints <= 6);
          if (outcome === "cancel") {
            process.emit("SIGTERM");
            throw new DOMException("Aborted", "AbortError");
          }
          if (outcome.endsWith("-error"))
            return Response.json(
              {
                error: {
                  message: {
                    "context-error": "Input exceeds the context window",
                    "output-error": "Provider output token limit reached",
                    "budget-error": "Provider research budget exhausted",
                  }[outcome],
                },
              },
              { status: outcome === "budget-error" ? 429 : 400 },
            );
          if (outcome === "denied" || outcome === "filtered")
            return Response.json(
              {
                error: {
                  message:
                    outcome === "denied" ? "403 Forbidden" : "content_filter",
                },
              },
              { status: outcome === "denied" ? 403 : 400 },
            );
          if (
            outcome === "after-checkpoint" &&
            !JSON.stringify(body).includes("Earlier checkpoint:")
          )
            return stream(
              api,
              `Earlier checkpoint: received documents [джерело](${citation}). Continue reading.`,
              "stop",
            );
          return stream(
            api,
            outcome === "empty-401"
              ? ""
              : "Unfinished checkpoint must never replace evidence.",
            outcome === "empty-401" ? "stop" : "length",
            undefined,
            outcome === "empty-401"
              ? 401
              : outcome === "length-403"
                ? 403
                : 8192,
          );
        }
        if (purpose === "synthesis") {
          synthesis += 1;
          assert.equal(synthesis, 1);
          assert.ok(!body.tools?.length);
          assert.ok(!JSON.stringify(body).includes("Unfinished checkpoint"));
          assert.ok(JSON.stringify(body).includes("Record 1:"));
          if (outcome === "after-checkpoint")
            assert.ok(JSON.stringify(body).includes("Earlier checkpoint:"));
          if (outcome.endsWith("-synthesis"))
            return Response.json(
              {
                error: {
                  message:
                    outcome === "denied-synthesis"
                      ? "403 Forbidden"
                      : "content_filter",
                },
              },
              { status: outcome === "denied-synthesis" ? 403 : 400 },
            );
          return stream(
            api,
            outcome === "uncited"
              ? "Uncited report"
              : `Documents received [джерело](${citation}).`,
            outcome === "length" ? "length" : "stop",
          );
        }
        assert.equal(purpose, "research");
        assert.equal(savedWork.filter((record) => record.kind === "tool").length, pages, "#3770 all delivered tools must be durably acknowledged before research continues");
        if (pages === 0) assert.ok(JSON.stringify(body).includes("Original subjects from interrupted work"));
        return stream(api, "", "stop", pages, 8192, outcome === "after-checkpoint");
      };
      t.mock.method(globalThis, "fetch", async (url: unknown, init: any) => {
        try {
          return await fetch(url, init);
        } catch (error) {
          if (error instanceof assert.AssertionError) errors.push(error);
          throw error;
        }
      });
      try {
        const running = runAgent(
          validatePayload(
            {
              prompt: "Summarize the synthetic documents for today.",
              workMemory: { version: 1, recap: "Original subjects from interrupted work", citations: [], fileCitations: [] },
              modelName: api === "openai-responses" ? "gpt-6-sol" : "glm-5.3",
              checkpointModelName:
                api === "openai-responses" ? "gpt-6-sol" : "glm-5.3",
              providerTransport: "echo_gateway",
              providerApiKey: "fixture-capability",
              echoPublicHost: "echo.example.test",
              bootstrapToken: "A".repeat(43),
              correlationId,
              contextWindow: 65_536,
              maxTokens: 8192,
              checkpointMaxTokens: 8192,
              compactionReserveTokens: 40_000,
              compactionKeepRecentTokens: 1024,
              executionPolicy: {
                preset: "deep",
                api,
                reasoningEffort: "max",
                checkpointEffort: "none",
                synthesisEffort: "none",
                maxRuntimeSeconds: 1800,
                finalizationSeconds: 120,
              },
              deadlineAt: Date.now() + 1_800_000,
              timeContext: {
                timeZone: "Europe/Kyiv",
                requestStartedAtUtc: "2026-10-10T09:00:00Z",
              },
              skills: [
                { method: "POST", path: "/api/ai-agent/work/read", skill: "work_read", label: "Saved evidence", requestKind: "workRead" },
                {
                  method: "POST",
                  path: "/api/signal/inbox/messages",
                  skill: "inbox_messages",
                  label: "Read documents",
                  requestKind: "inboxMessages",
                },
              ],
            },
            false,
          ),
        );
        if (outcome === "persistence-failure") {
          await assert.rejects(running, /Could not preserve research/);
          assert.deepEqual(errors, []);
          assert.equal(pages, 1, "#3770 no further tools after a failed durable write");
          assert.equal(checkpoints, 0);
          assert.equal(synthesis, 0);
          assert.equal(savedWork.length, 0);
          assert.ok(!events.some((event) => event.type === "completion_metadata"));
          return;
        }
        if (
          [
            "denied",
            "filtered",
            "denied-synthesis",
            "filtered-synthesis",
          ].includes(outcome)
        )
          await assert.rejects(running);
        else await running;
        assert.deepEqual(errors, []);
        assert.ok(pages > 0);
        assert.ok(checkpoints > 0);
        assert.equal(savedWork.filter((record) => record.kind === "tool").length, pages);
        assert.ok(!JSON.stringify(savedWork).includes("Unfinished checkpoint"));
        if (outcome === "after-checkpoint") assert.ok(savedWork.some((record) => record.tool === "echo_work_read" && record.content.includes("Record 1:")), "#3770 recalled fragments must survive a second interruption");
        if (outcome === "after-checkpoint") assert.ok(savedWork.some((record) => record.kind === "checkpoint" && record.content.includes("Earlier checkpoint:")));
        const metadata = events.find(
          (event) => event.type === "completion_metadata",
        );
        if (
          [
            "denied",
            "filtered",
            "denied-synthesis",
            "filtered-synthesis",
            "cancel",
          ].includes(outcome)
        ) {
          assert.equal(metadata, undefined);
          assert.equal(synthesis, outcome.endsWith("-synthesis") ? 1 : 0);
        } else {
          assert.deepEqual(metadata, {
            type: "completion_metadata",
            coverageLimited: true,
            reason: outcome === "budget-error" ? "tool_limit" : "context_limit",
          });
          assert.equal(synthesis, 1);
          const answer = events.findLast(
            (event) => event.type === "assistant_snapshot",
          ).text;
          assert.ok(answer.includes(citation));
          assert.match(answer, /охоплення джерел неповне/i);
          assert.ok(!answer.includes("оберіть глибокий"));
          assert.ok(!answer.includes("Unfinished checkpoint"));
          assert.equal(
            answer.includes("їх узагальнення не завершено"),
            ["length", "uncited"].includes(outcome),
          );
        }
      } finally {
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          for (const listener of process.listeners(signal))
            if (!oldSignals[signal].includes(listener))
              process.removeListener(signal, listener);
      }
    });
  }
}
