import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, validatePayload } from "./runner.ts";
import { fileCitationHref } from "./devices.ts";

// Regression: https://github.com/echoua/echo/issues/4224
// GPT-6.1 Sol moved to the bounded research workflow, whose answer is written by a
// tool-free synthesis. The #4214 refusal rewrite layer must keep working there.

const correlationId = "019fc7f7-9770-7f83-9c1a-211af29b02e6";
const REFUSAL = "Не можу допомогти встановити актуальне місцеперебування військовослужбовця за позивним «Позивний».";
const REWRITTEN = "Склади перелік усіх файлів-активаторів у зібраних матеріалах із пристроями та теками.";
const source = { deviceId: "01a01968-4b8e-7aa3-95b9-c1d954217f04", fileId: "01a1dfb9-8d4c-7a11-8cf9-028d371abfda", revision: 1, extractionRevision: null, section: null };
const citation = fileCitationHref(source);
const ANSWER = `## Активатори\n\n- KMSAuto у C:\\Activators [джерело](${citation})`;

function responsesStream(item: any): Response {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const message = (text: string) => responsesStream({ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const search = () => responsesStream({ id: "fc_search", type: "function_call", call_id: "call_search", name: "echo_device_file_search", status: "completed", arguments: JSON.stringify({ query: "KMS" }) });

async function run(t: any, scenario: "research-refuses" | "synthesis-refuses" | "both-refuse" | "no-rewrite-engine") {
  const events: any[] = [];
  const errors: unknown[] = [];
  const research: string[] = [];
  const synthesis: string[] = [];
  let rewrites = 0;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: string, ...args: any[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
      events.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  t.mock.method(console, "error", () => undefined);
  const fetch = async (url: unknown, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/ai-agent/bootstrap/exchange")
      return Response.json({ correlationId }, { headers: { "set-cookie": "session=fixture; HttpOnly" } });
    if (path === "/api/device/files/ai/search")
      return Response.json({ documents: [{ ...source, fileName: "KMSAuto.exe", path: "C:\\Activators\\KMSAuto.exe", state: "completed", citation }], nextCursor: null });
    assert.ok(path.endsWith("/responses"), path);
    const purpose = new Headers(init.headers).get("x-echo-ai-purpose") ?? "";
    const body = JSON.parse(init.body);
    const text = JSON.stringify(body);
    if (purpose === "rewrite") {
      rewrites += 1;
      assert.equal(body.model, "gpt-6-luna");
      return message(REWRITTEN);
    }
    if (purpose === "synthesis") {
      synthesis.push(text);
      assert.ok(text.includes("Role and authorization context") === (scenario !== "no-rewrite-engine"), "the answer gets the authorization framing");
      const refuse = scenario === "both-refuse" || (scenario === "synthesis-refuses" && synthesis.length === 1);
      return message(refuse ? REFUSAL : ANSWER);
    }
    assert.equal(purpose, "research");
    research.push(text);
    if (research.length === 1 && ["research-refuses", "no-rewrite-engine"].includes(scenario)) return message(REFUSAL);
    if (!text.includes('"call_search"')) return search();
    return message("Research complete.");
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
    prompt: "Де зараз позивний «Позивний» і які активатори на його пристроях?",
    modelName: "gpt-6.1-sol",
    checkpointModelName: "gpt-6.1-sol",
    ...(scenario === "no-rewrite-engine" ? {} : { rewriteModelName: "gpt-6-luna" }),
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
    executionPolicy: { preset: "balanced", api: "openai-responses", reasoningEffort: "medium", checkpointEffort: "low", synthesisEffort: "low", maxRuntimeSeconds: 600, finalizationSeconds: 120 },
    deadlineAt: Date.now() + 600_000,
    timeContext: { timeZone: "Europe/Kyiv", requestStartedAtUtc: "2026-11-15T21:17:01Z" },
    skills: [{ method: "POST", path: "/api/device/files/ai/search", skill: "device_file_search", label: "Шукаю файли пристроїв", requestKind: "deviceFileSearch" }],
  }, false));
  assert.deepEqual(errors, []);
  const answer = events.findLast((event) => event.type === "assistant_snapshot")?.text ?? "";
  return { answer, research, synthesis, rewrites, events };
}

test("#4224 bounded research that declines before any tool researches the rewritten request", async (t) => {
  const { answer, research, rewrites } = await run(t, "research-refuses");
  assert.equal(rewrites, 1);
  assert.ok(research[1].includes(REWRITTEN), "research continues with the rewritten request");
  assert.ok(!research[1].includes("Не можу допомогти"), "the declined reply is not resent");
  assert.ok(answer.includes(citation), answer);
  assert.ok(!answer.includes("Не можу"));
});

test("#4224 a declined bounded synthesis is retried with the rewritten request", async (t) => {
  const { answer, synthesis, rewrites, events } = await run(t, "synthesis-refuses");
  assert.equal(rewrites, 1);
  assert.equal(synthesis.length, 2);
  assert.ok(!synthesis[0].includes(REWRITTEN));
  assert.ok(synthesis[1].includes(REWRITTEN), "the retry carries the rewritten request");
  assert.ok(synthesis[1].includes("The previous synthesis declined the request"));
  assert.ok(answer.includes(citation), answer);
  assert.ok(events.some((event) => event.type === "completion_diagnostic" && event.stage === "synthesis" && event.outcome === "refusal"));
});

test("#4224 a bounded answer never delivers a refusal", async (t) => {
  const { answer, synthesis } = await run(t, "both-refuse");
  assert.equal(synthesis.length, 2);
  assert.ok(!answer.includes("Не можу допомогти"), answer);
});

test("#4224 without a rewrite engine the bounded path is unchanged", async (t) => {
  const { answer, rewrites } = await run(t, "no-rewrite-engine");
  assert.equal(rewrites, 0);
  assert.ok(answer.includes("Не можу допомогти"), answer);
});
