import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, validatePayload } from "./runner.ts";
import { fileCitationHref } from "./devices.ts";

// Regression: https://github.com/echoua/echo/issues/4224
// echo-cbr request 01a1e112: GPT-6.1 Sol (65,536 / 8,192 / 16,384 / 8,192) ran six
// searches in its first turn, the context overflowed, the checkpoint summarized only the
// prompt and the answer was "Не вдалося підготувати перевірену відповідь…" after 25 s.

const correlationId = "019fc7f7-9770-7f83-9c1a-211af29b02e6";
const deviceId = "01a01968-4b8e-7aa3-95b9-c1d954217f04";
const SEARCHES = [
  { name: "echo_device_file_search", arguments: { limit: 50, query: "activator" } },
  { name: "echo_device_file_search", arguments: { limit: 50, query: "KMS" } },
  { name: "echo_device_file_search", arguments: { limit: 50, query: "активатор" } },
  { name: "echo_attachment_search", arguments: { limit: 50, query: "activator" } },
  { name: "echo_attachment_search", arguments: { limit: 50, query: "KMS" } },
  { name: "echo_device_search", arguments: { limit: 50 } },
];

function fileHit(query: string, index: number) {
  const source = {
    deviceId,
    fileId: `01a1dfb9-8d4c-7a11-8cf9-${String(query.length * 1000 + index).padStart(12, "0")}`,
    revision: 1,
    extractionRevision: null,
    section: null,
  };
  return {
    ...source,
    fileName: `KMSAuto-${query}-${index}.exe`,
    path: `C:\\Users\\operator\\Downloads\\Activators\\KMSAuto-${query}-${index}.exe`,
    format: "exe",
    modifiedAt: 1_790_000_000_000,
    current: true,
    hasContent: true,
    state: "completed",
    extractionRevision: null,
    complete: true,
    summary: "KMS-активатор Windows і Office, портативна збірка Ratiborus. ".repeat(32),
    summaryState: "completed",
    positionState: "completed",
    snippet: `page 1: ${"KMS activation ".repeat(40)}`,
    citation: fileCitationHref(source),
  };
}

function responsesStream(output: unknown[]): Response {
  const events = [
    ...output.flatMap((item: any, index) => [
      { type: "response.output_item.added", output_index: index, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: { id: "resp_fixture", status: "completed", output, usage: { input_tokens: 20_000, output_tokens: 200, total_tokens: 20_200 } },
    },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const message = (text: string) => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

test("#4224 six parallel full searches on a 64k window end with a cited answer", async (t) => {
  const events: any[] = [];
  const errors: unknown[] = [];
  const purposes: string[] = [];
  let research = 0;
  const firstCitation = fileHit("activator", 0).citation;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: string, ...args: any[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
      events.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  const fetch = async (url: unknown, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/ai-agent/bootstrap/exchange")
      return Response.json({ correlationId }, { headers: { "set-cookie": "session=fixture; HttpOnly" } });
    if (path === "/api/device/files/ai/search") {
      const { query } = JSON.parse(init.body);
      return Response.json({ documents: Array.from({ length: 50 }, (_, index) => fileHit(query, index)), nextCursor: "next" });
    }
    if (path === "/api/attachments/search") return Response.json({ documents: [], nextCursor: null });
    if (path === "/api/device/ai/search")
      return Response.json({ devices: Array.from({ length: 50 }, (_, index) => ({ id: `01a01968-0000-7000-8000-${String(index).padStart(12, "0")}`, name: `Ноутбук-${index}` })), nextCursor: null });
    assert.ok(path.endsWith("/responses"), path);
    const purpose = new Headers(init.headers).get("x-echo-ai-purpose") ?? "";
    purposes.push(purpose);
    const body = JSON.parse(init.body);
    if (purpose === "checkpoint") {
      const content = JSON.stringify(body.input);
      assert.ok(content.includes("[Tool result]"), "the checkpoint carries the search results, not only the prompt");
      return responsesStream([message(`KMSAuto found on device [джерело](${firstCitation}). Six searches read; nextCursor remains for each.`)]);
    }
    if (purpose === "synthesis") return responsesStream([message(`KMSAuto [джерело](${firstCitation})`)]);
    assert.equal(purpose, "research");
    research += 1;
    if (research === 1)
      return responsesStream(SEARCHES.map((call, index) => ({
        id: `fc_${index}`, type: "function_call", call_id: `call_${index}`, name: call.name, status: "completed", arguments: JSON.stringify(call.arguments),
      })));
    return responsesStream([message(`## KMS-активатори\n\n- KMSAuto у C:\\Users\\operator\\Downloads\\Activators [джерело](${firstCitation})`)]);
  };
  t.mock.method(globalThis, "fetch", async (url: unknown, init: any) => {
    try {
      return await fetch(url, init);
    } catch (error) {
      errors.push(error);
      throw error;
    }
  });
  await runAgent(validatePayload({
    prompt: "Знайди серед файлів активатори віндоус та інші, опиши на твою думку де який",
    modelName: "gpt-6-sol",
    checkpointModelName: "gpt-6-sol",
    providerTransport: "echo_gateway",
    providerApiKey: "fixture-capability",
    echoPublicHost: "echo.example.test",
    bootstrapToken: "A".repeat(43),
    correlationId,
    contextWindow: 65_536,
    maxTokens: 8192,
    checkpointMaxTokens: 8192,
    compactionReserveTokens: 16_384,
    compactionKeepRecentTokens: 8_192,
    executionPolicy: { preset: "balanced", api: "openai-responses", reasoningEffort: "medium", checkpointEffort: "low", synthesisEffort: "low", maxRuntimeSeconds: 300, finalizationSeconds: 60 },
    deadlineAt: Date.now() + 300_000,
    timeContext: { timeZone: "Europe/Kyiv", requestStartedAtUtc: "2026-11-15T21:17:01Z" },
    skills: [
      { method: "POST", path: "/api/device/files/ai/search", skill: "device_file_search", label: "Шукаю файли пристроїв", requestKind: "deviceFileSearch" },
      { method: "POST", path: "/api/attachments/search", skill: "attachment_search", label: "Шукаю документи", requestKind: "attachmentSearch" },
      { method: "POST", path: "/api/device/ai/search", skill: "device_search", label: "Шукаю пристрої", requestKind: "deviceSearch" },
    ],
  }, false));
  assert.deepEqual(errors, []);
  assert.ok(!events.some((event) => event.type === "completion_metadata" && event.reason === "context_limit"), JSON.stringify(events.filter((event) => event.type === "completion_metadata")));
  assert.ok(!events.some((event) => event.type === "tool_end" && event.is_error), "every search delivers data");
  assert.equal(research, 2);
  assert.ok(!purposes.includes("synthesis"), "research finished on its own");
  const answer = events.filter((event) => event.type === "assistant_delta").map((event) => event.delta).join("") ||
    events.findLast((event) => event.type === "assistant_snapshot")?.text;
  assert.ok(answer?.includes(firstCitation), answer);
  assert.ok(events.some((event) => event.type === "file_citations" && event.citations.some((citation: any) => fileCitationHref(citation) === firstCitation)));
});
