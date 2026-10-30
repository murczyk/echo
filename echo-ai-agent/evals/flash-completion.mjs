import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// All Echo endpoints are fixtures. Only provider inference leaves this process.
const [
  runnerPath,
  profilesPath,
  engine,
  scenario = "grouped",
  preset = "balanced",
  reserveMultiplier,
] = process.argv.slice(2);
const profile = JSON.parse(await readFile(profilesPath, "utf8")).find(
  (entry) => entry.engine === engine,
);
assert.ok(profile, "Configured evaluation provider is missing");
const { runAgent, validatePayload } = await import(
  pathToFileURL(resolve(runnerPath))
);
// Every non-OpenAI engine (GLM, Gemma) runs the bounded research harness. Only GLM-5.3
// varies reasoning by preset; Flash and Gemma run without a reasoning effort.
const openai = engine.startsWith("gpt-");
const reasons = openai || engine === "glm-5.3";
const api = openai ? "openai-responses" : "openai-completions";
// Non-OpenAI engines reserve twice the base synthesis time. A runner built before that
// change accepts the doubled reserve only for Flash: pass 1 as the sixth argument when
// comparing GLM-5.3 or Gemma against such a base runner.
const multiplier = Number(
  reserveMultiplier ?? (openai ? 1 : 2),
);
assert.ok([1, 2].includes(multiplier), "reserve multiplier must be 1 or 2");
const [runtime, reserve] = {
  fast: [120, 30],
  balanced: [300, 60],
  deep: [1800, 120],
}[preset];
const correlationId = "019fc7f7-9770-7f83-9c1a-211af29b02e6";
const teams = ["Iris", "Cedar", "Willow", "Maple", "Orchid", "Fern"];
const facts = [
  "catalogued twelve seed packets",
  "repaired the greenhouse sensor",
  "completed the soil survey",
  "received eight reference books",
  "digitized fourteen herbarium sheets",
  "reopened the north conservatory",
];
const records = Array.from(
  { length: scenario === "exhaustive" ? 45 : 100 },
  (_, index) => {
    const team = index % teams.length;
    const report =
      index >= (scenario === "exhaustive" ? 30 : 80) || scenario === "long";
    const fact = `Team ${teams[team]} ${facts[team]}.`;
    return [
      1000 - index,
      {
        message_uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        text: report
          ? `Botanical archive daily report. ${scenario === "long" ? "Routine archive administration. ".repeat(80) : ""}${fact}`
          : `Team ${teams[team]} routine check-in; no new archive event.`,
        timestamp: 1793268000 - index * 600,
      },
    ];
  },
);
const attachmentId = "01999999-1111-7111-8111-111111111111";
const attachmentRevision = "01999999-2222-7222-8222-222222222222";
const document = {
  mediaId: attachmentId,
  revision: attachmentRevision,
  messageId: records[0][0],
  messageUuid: records[0][1].message_uuid,
  fileName: "botanical-report.txt",
  summary: "Daily reports from six botanical archive teams",
  state: "ready",
};
const source = `/rer-analysis-neo?m=${records[0][1].message_uuid}`;
const priorAnswer = `Team Iris catalogued twelve seed packets. [джерело](${source})`;
const queries = [],
  events = [],
  saved = [],
  providerCalls = [];
const fetchProvider = globalThis.fetch;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
    events.push(JSON.parse(chunk));
    return true;
  }
  return write(chunk, ...args);
};
globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  const body = init?.body ? JSON.parse(init.body) : {};
  if (path.endsWith("/bootstrap/exchange"))
    return Response.json(
      { correlationId },
      { headers: { "set-cookie": "fixture=yes; HttpOnly" } },
    );
  if (path.endsWith("/work/append")) {
    saved.push(body);
    return Response.json({ sequence: body.sequence });
  }
  if (path === "/api/attachments/search") {
    queries.push({ tool: "attachment_search", ...body });
    return Response.json({ documents: [document], nextCursor: null });
  }
  if (path === "/api/attachments/get") {
    queries.push({ tool: "attachment_get", ...body });
    assert.equal(body.mediaId, attachmentId);
    const sections = teams.map((team, ordinal) => ({
      ordinal,
      member: "botanical-report.txt",
      locator: `Team ${team}`,
      text: `${"Archive context. ".repeat(100)}Team ${team} ${facts[ordinal]}.`,
    }));
    return Response.json({ document, sections, nextAfter: null });
  }
  if (path === "/api/signal/inbox/messages") {
    queries.push(body);
    const terms = String(body.search ?? "")
      .toLowerCase()
      .split(/\s+or\s+/)
      .map((term) => term.replaceAll('"', "").trim())
      .filter(Boolean);
    const selected = records.filter(
      ([id, record]) =>
        (!body.before_id_noninclusive || id < body.before_id_noninclusive) &&
        (!terms.length ||
          terms.some((term) => record.text.toLowerCase().includes(term))),
    );
    return Response.json({
      inbox_items: selected.slice(0, 20),
      page_limit: 20,
    });
  }
  if (path.endsWith("/metadata-statistics"))
    return Response.json({
      groups: [{ name: "Botanical archive", count: records.length }],
    });
  assert.ok(
    path.endsWith("/chat/completions") || path.endsWith("/responses"),
    `Unexpected fixture endpoint ${path}`,
  );
  const purpose =
    new Headers(init.headers).get("x-echo-ai-purpose") ?? "research";
  body.store = false;
  if (api === "openai-responses") {
    for (const tool of body.tools ?? []) tool.strict ??= false;
    body.reasoning = { effort: purpose === "research" ? "medium" : "low" };
    body.include = ["reasoning.encrypted_content"];
  }
  const startedAt = Date.now();
  const entry = {
    purpose,
    maxTokens:
      body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
    inputMessages: body.messages?.length ?? body.input?.length,
  };
  providerCalls.push(entry);
  const endpoint =
    profile.url
      .replace(/\/(?:chat\/completions|responses)\/?$/, "")
      .replace(/\/$/, "") +
    (api === "openai-responses" ? "/responses" : "/chat/completions");
  const headers = new Headers({ "content-type": "application/json" });
  if (profile.token) headers.set("authorization", `Bearer ${profile.token}`);
  const response = await fetchProvider(endpoint, {
    ...init,
    headers,
    body: JSON.stringify(body),
  });
  entry.httpStatus = response.status;
  const text = await response.text();
  entry.durationMs = Date.now() - startedAt;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (chunk.choices?.[0]?.finish_reason)
      entry.finishReason = chunk.choices[0].finish_reason;
    if (chunk.usage) entry.usage = chunk.usage;
    if (chunk.response?.usage) entry.usage = chunk.response.usage;
    if (chunk.type === "response.completed") entry.finishReason = "stop";
    if (chunk.type === "response.incomplete")
      entry.finishReason = chunk.response?.incomplete_details?.reason;
  }
  write(JSON.stringify({ provider: entry }) + "\n");
  return new Response(text, {
    status: response.status,
    headers: response.headers,
  });
};
const startedAt = Date.now();
await runAgent(
  validatePayload(
    {
      prompt:
        scenario === "attachments"
          ? "Summarize the botanical report attachment from the last day, grouped by team. Read its full sections and use headings and citations."
          : scenario === "followup"
            ? "Reformat the previous answer with a heading per team and short cited bullets. Do not add new facts."
            : scenario === "exhaustive"
              ? "Read every archive record from the last day and summarize by team, citing the records."
              : "Summarize the archive events from the last day, grouped by team. Use clear headings and cited bullets. Look for substantive daily reports rather than routine check-ins.",
      modelName: engine,
      providerTransport: "echo_gateway",
      providerApiKey: "fixture",
      echoPublicHost: "echo.synthetic.test",
      bootstrapToken: "A".repeat(43),
      correlationId,
      contextWindow: profile.context,
      maxTokens: profile.maxTokens,
      checkpointMaxTokens: profile.maxTokens,
      compactionReserveTokens: openai ? 16384 : 32768,
      compactionKeepRecentTokens: 8192,
      executionPolicy: {
        preset,
        api,
        reasoningEffort: openai
          ? "medium"
          : engine === "glm-5.3"
            ? { fast: "low", balanced: "high", deep: "max" }[preset]
            : null,
        synthesisEffort: reasons ? "low" : null,
        checkpointEffort: reasons ? "low" : null,
        maxRuntimeSeconds: runtime,
        finalizationSeconds: reserve * multiplier,
      },
      deadlineAt: Date.now() + runtime * 1000,
      timeContext: {
        timeZone: "Europe/Kyiv",
        requestStartedAtUtc: "2026-10-29T10:00:00Z",
      },
      history:
        scenario === "followup"
          ? [
              { role: "user", content: "Summarize the archive events." },
              {
                role: "assistant",
                content: priorAnswer,
                citations: [
                  {
                    messageId: records[0][0],
                    messageIdentifier: records[0][1].message_uuid,
                  },
                ],
              },
            ]
          : [],
      workMemory: { version: 1, citations: [], fileCitations: [] },
      skills: [
        ...(scenario === "attachments"
          ? [
              {
                method: "POST",
                path: "/api/attachments/search",
                skill: "attachment_search",
                label: "Search botanical attachments",
                requestKind: "attachmentSearch",
              },
              {
                method: "POST",
                path: "/api/attachments/get",
                skill: "attachment_get",
                label: "Read botanical attachment",
                requestKind: "attachmentRead",
              },
            ]
          : []),
        {
          method: "POST",
          path: "/api/signal/inbox/messages",
          skill: "inbox_messages",
          label: "Read botanical archive",
          requestKind: "inboxMessages",
        },
      ],
    },
    false,
  ),
);
const answer =
  events.findLast((event) => event.type === "assistant_snapshot")?.text ??
  events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.delta)
    .join("");
const lastDraft = saved
  .filter((record) => record.kind === "checkpoint")
  .map((record) => {
    try {
      return JSON.parse(record.content).research?.draft;
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .at(-1);
write(
  JSON.stringify({
    result: {
      engine,
      scenario,
      preset,
      elapsedMs: Date.now() - startedAt,
      queries,
      providerCalls,
      answer,
      fallback: Boolean(lastDraft && answer.startsWith(lastDraft)),
      diagnostics: events.filter(
        (event) => event.type === "completion_diagnostic",
      ),
      completion: events.find((event) => event.type === "completion_metadata"),
    },
  }) + "\n",
);
