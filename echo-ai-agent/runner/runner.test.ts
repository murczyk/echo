import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analysisPeriodRequestBody,
  callsignFrequencyMatchesRequestBody,
  compactHistoryIfNeeded,
  compactInboxResponse,
  compactToolResponse,
  createToolLifecycleGuard,
  createToolInvocationGuard,
  createToolResponseCompactor,
  dailyActivityRequestBody,
  directionFindingsRequestBody,
  inboxMessagesRequestBody,
  interceptionContextRequestBody,
  messagesByIdRequestBody,
  normalizedToolLifecycleEvent,
  runnerHello,
  sourceEvent,
  systemPrompt,
  testConnection,
  completedRepairText,
  validateFinalAssistantMessage,
  validatePayload,
  validateSkill,
  writeModelsFile,
} from "./runner.ts";

test("accepts a non-empty final assistant response", () => {
  assert.doesNotThrow(() =>
    validateFinalAssistantMessage([
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Done" }],
      },
    ]),
  );
});

test("rejects provider errors and empty assistant responses", () => {
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        { role: "assistant", stopReason: "error", content: [] },
      ]),
    /provider request failed/,
  );
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        { role: "assistant", stopReason: "stop", content: [] },
      ]),
    /provider response is empty/,
  );
});

test("classifies provider output and context limits", () => {
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        { role: "assistant", stopReason: "length", content: [] },
      ]),
    /output token limit/,
  );
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Input exceeds the context window",
          content: [],
        },
      ]),
    /context window exceeded/,
  );
});

const normalPayload = {
  prompt: "Summarize activity",
  modelName: "google/gemma-4-26B-A4B-it",
  history: [{ role: "user", content: "Earlier question" }],
  echoPublicHost: "echo-staging.example.test",
  bootstrapToken: "A".repeat(43),
  correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
  timeContext: {
    timeZone: "Europe/Kyiv",
    requestStartedAtUtc: "2026-08-04T12:00:00Z",
  },
  skills: [
    {
      method: "GET",
      path: "/api/user",
      skill: "current_user",
      label: "Перевірка профілю користувача",
      requestKind: "none",
    },
  ],
};

test("accepts the backend camelCase runner contract", () => {
  const payload = validatePayload(
    { ...normalPayload, providerApiKey: "budget-limited-token" },
    false,
  );
  assert.equal(payload.modelName, normalPayload.modelName);
  assert.equal(payload.providerApiKey, "budget-limited-token");
  assert.equal(payload.providerTransport, "direct_http");
  assert.equal(payload.skills[0].method, "GET");
});

test("uses provider-specific context and compaction settings", () => {
  const payload = validatePayload(
    {
      ...normalPayload,
      modelName: "gpt-5.6-sol",
      contextWindow: 1_050_000,
      maxTokens: 65_536,
      compactionReserveTokens: 98_304,
      compactionKeepRecentTokens: 49_152,
    },
    false,
  );
  assert.equal(payload.contextWindow, 1_050_000);
  assert.equal(payload.maxTokens, 65_536);
  assert.equal(payload.compactionReserveTokens, 98_304);
  assert.equal(payload.compactionKeepRecentTokens, 49_152);
  assert.throws(
    () =>
      validatePayload(
        {
          ...normalPayload,
          contextWindow: 16_384,
          maxTokens: 15_360,
        },
        false,
      ),
    /leave room/,
  );
});

test("writes the provider API key only to the private runtime models file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-ai-agent-test-"));
  try {
    const payload = validatePayload(
      { ...normalPayload, providerApiKey: "budget-limited-token" },
      false,
    );
    const modelsPath = await writeModelsFile(directory, payload);
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(models.providers["echo-vllm"].apiKey, "budget-limited-token");
    assert.equal(
      models.providers["echo-vllm"].baseUrl,
      "http://127.0.0.1:18000/v1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes only the fixed Echo gateway base and scoped capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-ai-agent-test-"));
  try {
    const payload = validatePayload(
      {
        ...normalPayload,
        modelName: "gpt-test",
        providerTransport: "echo_gateway",
        providerApiKey: "A".repeat(43),
      },
      false,
    );
    const modelsPath = await writeModelsFile(directory, payload);
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(models.providers["echo-vllm"].apiKey, "A".repeat(43));
    assert.equal(
      models.providers["echo-vllm"].baseUrl,
      "https://echo-staging.example.test/api/ai-agent/provider/v1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("#3064 GPT-6 Sol and Luna tool requests explicitly disable reasoning through the Echo gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-ai-agent-test-"));
  try {
    for (const modelName of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]) {
      const payload = validatePayload(
        {
          ...normalPayload,
          modelName,
          providerTransport: "echo_gateway",
          providerApiKey: "A".repeat(43),
        },
        false,
      );
      const modelsPath = await writeModelsFile(directory, payload);
      const models = JSON.parse(await readFile(modelsPath, "utf8"));
      const provider = models.providers["echo-vllm"];
      assert.equal(provider.compat.supportsReasoningEffort, true);
      assert.equal(provider.models[0].reasoning, true);
      assert.equal(provider.models[0].thinkingLevelMap.off, "none");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported gateway transports and missing capabilities", () => {
  assert.throws(
    () =>
      validatePayload(
        { ...normalPayload, providerTransport: "external_url" },
        false,
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      validatePayload(
        { ...normalPayload, providerTransport: "echo_gateway" },
        false,
      ),
    /required/,
  );
});

test("rejects provider API keys containing header control characters", () => {
  assert.throws(
    () =>
      validatePayload(
        { ...normalPayload, providerApiKey: "token\nAuthorization: injected" },
        false,
      ),
    /invalid characters/,
  );
});

test("rejects unknown top-level runner fields", () => {
  for (const field of ["requestId", "conversationId", "vllmBaseUrl"]) {
    assert.throws(
      () => validatePayload({ ...normalPayload, [field]: "unexpected" }, false),
      /unsupported field/,
    );
  }
});

test("accepts the exact connection-test identity contract", () => {
  const payload = validatePayload(
    {
      echoPublicHost: "echo-staging.example.test",
      bootstrapToken: "A".repeat(43),
      correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
      expectedIdentity: {
        id: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
        name: "ziggy-ai-agent",
        roles: ["ApiAgent", "Rer", "Cyber"],
      },
    },
    true,
  );
  assert.equal(payload.prompt, "");
});

test("rejects an identity-free connection-test contract", () => {
  assert.throws(() =>
    validatePayload(
      {
        echoPublicHost: "echo-staging.example.test",
        bootstrapToken: "A".repeat(43),
        correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
      },
      true,
    ),
  );
});

test("connection test emits the identity from the authenticated user request", async () => {
  const payload = validatePayload(
    {
      echoPublicHost: "echo-staging.example.test",
      bootstrapToken: "A".repeat(43),
      correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
      expectedIdentity: {
        id: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
        name: "ziggy-ai-agent",
        roles: ["ApiAgent", "Rer", "Cyber"],
      },
    },
    true,
  );
  let exchangeCount = 0;
  const authentication = {
    cookie: "id=session",
    correlationId: payload.correlationId,
  };
  const authenticatedIdentity = {
    id: "019fc7f7-9770-7f83-9c1a-211af29b02e7",
    name: "authenticated-ai-agent",
    roles: ["ApiAgent", "Rer", "Cyber"],
  };
  const events: Record<string, unknown>[] = [];

  await testConnection(
    payload,
    async () => {
      exchangeCount += 1;
      return authentication;
    },
    (event) => events.push(event),
    async (requestPayload, requestAuthentication, method, path, body) => {
      assert.equal(requestPayload, payload);
      assert.equal(requestAuthentication, authentication);
      assert.equal(method, "GET");
      assert.equal(path, "/api/user");
      assert.equal(body, undefined);
      return {
        body: {
          ...authenticatedIdentity,
          deltaLogin: null,
        },
        status: 200,
      };
    },
  );

  assert.equal(exchangeCount, 1);
  assert.deepEqual(events, [
    {
      type: "identity",
      payload: authenticatedIdentity,
    },
  ]);
});

test("rejects recursive harness and mutating skills", () => {
  assert.throws(() =>
    validateSkill({
      method: "POST",
      path: "/api/ai-agent/requests",
      skill: "recursive",
      label: "Рекурсивний запит",
      requestKind: "json",
    }),
  );
  assert.throws(() =>
    validateSkill({
      method: "DELETE",
      path: "/api/user",
      skill: "delete_user",
      label: "Видалення користувача",
      requestKind: "json",
    }),
  );
  assert.throws(() =>
    validateSkill({
      method: "GET",
      path: "/api/user",
      skill: "report_progress",
      label: "Прогрес",
      requestKind: "none",
    }),
  );
});

test("accepts every skill advertised by Echo", async () => {
  const registry = await readFile(
    process.env.ECHO_AI_AGENT_ROUTE_REGISTRY ??
      new URL(
        "../../wdintel-rs/src/ai_agent/route_registry.rs",
        import.meta.url,
      ),
    "utf8",
  );
  const routes = registry
    .split("pub const ROUTES: &[ReadOnlyRoute] = &[")[1]
    ?.split("\n];")[0];
  assert.ok(routes, "Echo route registry must be present");
  const skills = [...routes.matchAll(/ReadOnlyRoute\s*\{([^}]+)\}/g)];
  assert.ok(skills.length > 0, "Echo must advertise skills");
  for (const [, fields] of skills) {
    const route = Object.fromEntries(
      [...fields.matchAll(/(\w+): "([^"]*)"/g)].map(([, key, value]) => [
        key === "request_kind" ? "requestKind" : key,
        value,
      ]),
    );
    assert.doesNotThrow(() => validateSkill(route), route.skill);
  }
});

test("accepts only the matching typed inbox and message-ID routes", () => {
  assert.equal(
    validateSkill({
      method: "POST",
      path: "/api/rer-importer/get-inbox",
      skill: "inbox_messages",
      label: "Завантаження перехоплень",
      requestKind: "inboxMessages",
    }).requestKind,
    "inboxMessages",
  );
  assert.equal(
    validateSkill({
      method: "POST",
      path: "/api/rer-importer/messages-by-id",
      skill: "messages_by_id",
      label: "Завантаження повідомлень",
      requestKind: "messageIds",
    }).requestKind,
    "messageIds",
  );
  assert.throws(() =>
    validateSkill({
      method: "POST",
      path: "/api/rer-importer/get-inbox",
      skill: "other",
      label: "Інше",
      requestKind: "inboxMessages",
    }),
  );
});

test("accepts only matching typed analysis routes", () => {
  assert.equal(
    validateSkill({
      method: "POST",
      path: "/api/rer/analysis/stats/networks",
      skill: "network_statistics",
      label: "Аналіз радіомереж",
      requestKind: "analysisPeriod",
    }).requestKind,
    "analysisPeriod",
  );
  assert.equal(
    validateSkill({
      method: "POST",
      path: "/api/rer-importer/get-freq-pelengs-summary",
      skill: "direction_findings",
      label: "Аналіз пеленгів",
      requestKind: "directionFindings",
    }).requestKind,
    "directionFindings",
  );
  assert.throws(() =>
    validateSkill({
      method: "POST",
      path: "/api/rer/analysis/stats/networks",
      skill: "network_statistics",
      label: "Аналіз радіомереж",
      requestKind: "directionFindings",
    }),
  );
});

test("emits frontend-compatible source fields", () => {
  assert.deepEqual(
    sourceEvent(
      {
        method: "GET",
        path: "/api/user",
        skill: "current_user",
        label: "Перевірка профілю користувача",
        requestKind: "none",
      },
      200,
    ),
    {
      type: "source",
      sourceTitle: "Перевірка профілю користувача",
      sourceUrl: null,
      skill: "current_user",
      method: "GET",
      path: "/api/user",
      status: 200,
    },
  );
});

test("source events contain only safe successful API activity", () => {
  const event = sourceEvent(
    {
      method: "POST",
      path: "/api/sigint/search",
      skill: "sigint_search",
      label: "Пошук даних",
      requestKind: "json",
    },
    204,
  );
  assert.deepEqual(Object.keys(event).sort(), [
    "method",
    "path",
    "skill",
    "sourceTitle",
    "sourceUrl",
    "status",
    "type",
  ]);
  assert.equal(JSON.stringify(event).includes("body"), false);
  assert.equal(JSON.stringify(event).includes("token"), false);
});

test("does not normalize failed Echo responses as sources", () => {
  const route = {
    method: "GET" as const,
    path: "/api/user",
    skill: "current_user",
    label: "Перевірка профілю користувача",
    requestKind: "none" as const,
  };
  for (const status of [199, 300, 401, 500]) {
    assert.throws(
      () => sourceEvent(route, status),
      /successful Echo HTTP status/,
    );
  }
});

test("caps all tool invocations through one shared guard", () => {
  const countInvocation = createToolInvocationGuard(2);
  countInvocation();
  countInvocation();
  assert.throws(countInvocation, /tool invocation limit reached/);
});

test("aborts a session after repeated schema-level tool errors", () => {
  const errors: Error[] = [];
  const observe = createToolLifecycleGuard(
    (error) => errors.push(error),
    128,
    3,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    observe({ type: "tool_execution_start" });
    observe({ type: "tool_execution_end", isError: true });
  }
  assert.match(errors[0].message, /consecutive tool error limit reached/);
});

test("builds exact three-day Kyiv boundaries on ordinary dates", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  assert.deepEqual(
    dailyActivityRequestBody(
      {
        period: { kind: "relative_days", days: 3 },
        selectedGroups: ["alpha"],
      },
      context,
    ),
    {
      since_date_inclusive_ms: Date.parse("2026-08-01T21:00:00Z"),
      till_date_noninclusive_ms: Date.parse("2026-08-04T21:00:00Z"),
      selected_groups: ["alpha"],
    },
  );
});

test("normalizes the failed production rolling-day tool arguments", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const params = {
    period: { kind: "relative_hours", hours: 24 },
    maxItems: 128,
  };
  const expectedAnalysis = {
    since_date_inclusive_ms: Date.parse("2026-08-03T12:00:00Z"),
    till_date_noninclusive_ms: Date.parse("2026-08-04T12:00:00Z"),
  };
  assert.deepEqual(
    analysisPeriodRequestBody(params, context),
    expectedAnalysis,
  );
  assert.deepEqual(dailyActivityRequestBody(params, context), expectedAnalysis);
  assert.deepEqual(inboxMessagesRequestBody(params, context), {
    since_date_inclusive_ms: Date.parse("2026-08-03T12:00:00Z"),
    till_date_inclusive_ms: Date.parse("2026-08-04T12:00:00Z") - 1,
    newest_first: true,
    skip_group_stats: true,
  });
  assert.deepEqual(directionFindingsRequestBody(params, context), {
    since_date_inclusive_ms: Date.parse("2026-08-03T12:00:00Z"),
    till_date_inclusive_ms: Date.parse("2026-08-04T12:00:00Z") - 1,
  });
});

test("passes an inherited callsign through applicable analysis tools", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const params = {
    period: { kind: "relative_days", days: 31 },
    selectedCallsigns: ["Сивий"],
  };
  assert.deepEqual(analysisPeriodRequestBody(params, context), {
    since_date_inclusive_ms: Date.parse("2026-07-04T21:00:00Z"),
    till_date_noninclusive_ms: Date.parse("2026-08-04T21:00:00Z"),
    selected_callsigns: ["сивий"],
  });
  assert.deepEqual(inboxMessagesRequestBody(params, context), {
    since_date_inclusive_ms: Date.parse("2026-07-04T21:00:00Z"),
    till_date_inclusive_ms: Date.parse("2026-08-04T21:00:00Z") - 1,
    newest_first: true,
    skip_group_stats: true,
    selected_callsigns: ["сивий"],
  });
});

test("builds nested callsign-frequency requests from discovered callsigns", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  assert.deepEqual(
    callsignFrequencyMatchesRequestBody(
      {
        period: { kind: "relative_hours", hours: 24 },
        selectedGroups: ["alpha"],
        callsigns: ["ALPHA", "BRAVO"],
        minMatches: 2,
      },
      context,
    ),
    {
      req: {
        since_date_inclusive_ms: Date.parse("2026-08-03T12:00:00Z"),
        till_date_noninclusive_ms: Date.parse("2026-08-04T12:00:00Z"),
        selected_groups: ["alpha"],
      },
      callsigns: ["ALPHA", "BRAVO"],
      min_matches: 2,
    },
  );
  assert.throws(
    () =>
      callsignFrequencyMatchesRequestBody(
        {
          period: { kind: "relative_hours", hours: 24 },
          callsigns: ["ALPHA"],
          minMatches: 2,
        },
        context,
      ),
    /unique callsign count/,
  );
});

test("builds exact three-day Kyiv boundaries across DST transitions", () => {
  for (const [requestStartedAtUtc, since, till] of [
    ["2026-03-30T12:00:00Z", "2026-03-27T22:00:00Z", "2026-03-30T21:00:00Z"],
    ["2026-10-26T12:00:00Z", "2026-10-23T21:00:00Z", "2026-10-26T22:00:00Z"],
  ]) {
    const context = validatePayload(
      {
        ...normalPayload,
        timeContext: { timeZone: "Europe/Kyiv", requestStartedAtUtc },
      },
      false,
    ).timeContext!;
    assert.deepEqual(
      dailyActivityRequestBody(
        { period: { kind: "relative_days", days: 3 } },
        context,
      ),
      {
        since_date_inclusive_ms: Date.parse(since),
        till_date_noninclusive_ms: Date.parse(till),
      },
    );
  }
});

test("supports explicit inclusive Kyiv date ranges", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  assert.deepEqual(
    dailyActivityRequestBody(
      {
        period: {
          kind: "date_range",
          sinceDate: "2026-03-28",
          tillDateInclusive: "2026-03-30",
        },
      },
      context,
    ),
    {
      since_date_inclusive_ms: Date.parse("2026-03-27T22:00:00Z"),
      till_date_noninclusive_ms: Date.parse("2026-03-30T21:00:00Z"),
    },
  );
});

test("builds bounded paginated inbox requests with an inclusive upper boundary", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  assert.deepEqual(
    inboxMessagesRequestBody(
      {
        period: { kind: "relative_days", days: 3 },
        selectedGroups: ["alpha"],
        cursor: 42,
      },
      context,
    ),
    {
      since_date_inclusive_ms: Date.parse("2026-08-01T21:00:00Z"),
      till_date_inclusive_ms: Date.parse("2026-08-04T21:00:00Z") - 1,
      newest_first: true,
      skip_group_stats: true,
      selected_groups: ["alpha"],
      before_id_noninclusive: 42,
    },
  );
  assert.throws(
    () =>
      inboxMessagesRequestBody(
        { period: { kind: "relative_days", days: 32 } },
        context,
      ),
    /between 1 and 31/,
  );
});

test("normalizes safe period forms emitted by the configured model", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const expected = {
    since_date_inclusive_ms: Date.parse("2026-07-31T21:00:00Z"),
    till_date_inclusive_ms: Date.parse("2026-08-04T21:00:00Z") - 1,
    newest_first: true,
    skip_group_stats: true,
  };
  assert.deepEqual(
    inboxMessagesRequestBody(
      { period: { kind: "sinceDate", sinceDate: "2026-08-01" } },
      context,
    ),
    expected,
  );
  assert.deepEqual(
    inboxMessagesRequestBody(
      {
        period: {
          start: "2026-08-01T00:00:00Z",
          end: "2026-08-05T00:00:00Z",
        },
      },
      context,
    ),
    expected,
  );
});

test("builds inbox boundaries across Kyiv DST transitions", () => {
  for (const [requestStartedAtUtc, since, tillExclusive] of [
    ["2026-03-30T12:00:00Z", "2026-03-27T22:00:00Z", "2026-03-30T21:00:00Z"],
    ["2026-10-26T12:00:00Z", "2026-10-23T21:00:00Z", "2026-10-26T22:00:00Z"],
  ]) {
    const context = validatePayload(
      {
        ...normalPayload,
        timeContext: { timeZone: "Europe/Kyiv", requestStartedAtUtc },
      },
      false,
    ).timeContext!;
    assert.deepEqual(
      inboxMessagesRequestBody(
        { period: { kind: "relative_days", days: 3 } },
        context,
      ),
      {
        since_date_inclusive_ms: Date.parse(since),
        till_date_inclusive_ms: Date.parse(tillExclusive) - 1,
        newest_first: true,
        skip_group_stats: true,
      },
    );
  }
});

test("types message lookup IDs without a generic body", () => {
  assert.deepEqual(messagesByIdRequestBody({ messageIds: [42, 43] }), {
    message_ids: [42, 43],
  });
  assert.throws(
    () => messagesByIdRequestBody({ body: { message_ids: [42] } }),
    /unsupported field/,
  );
});

test("projects inbox pages into compact model context and returns pagination", () => {
  const response = compactInboxResponse({
    inbox_items: Array.from({ length: 20 }, (_, index) => [
      100 - index,
      {
        message_uid: `uid-${index}`,
        timestamp: 1_700_000_000_000 + index,
        group_master_key: "alpha",
        sender: "sender",
        freq: "123.45",
        callsigns: ["ONE"],
        callsigns_alg2: ["ONE", "TWO"],
        unit: "unit",
        location: "location",
        text: index === 0 ? "x".repeat(6_001) : `message-${index}`,
        image_recognized: ["recognized text"],
      },
    ]),
    signal_groups: [{ master_key: "alpha", name: "Alpha" }],
    page_limit: 20,
  });

  assert.equal(response.nextCursor, 81);
  const messages = response.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], {
    id: 100,
    uid: "uid-0",
    timestamp: 1_700_000_000_000,
    groupKey: "alpha",
    groupName: "Alpha",
    sender: "sender",
    frequency: "123.45",
    callsigns: ["ONE", "TWO"],
    unit: "unit",
    location: "location",
    text: "x".repeat(6_000),
    recognizedImageText: "recognized text",
    truncated: true,
  });
});

test("bounds individual and aggregate tool context", () => {
  const route = { skill: "metadata_statistics", requestKind: "analysisPeriod" as const };
  const compact = createToolResponseCompactor(400, 240, 3);
  const outputs = [
    compact(route, { items: Array(100).fill("x".repeat(100)) }, 64),
    compact(route, { items: Array(100).fill("y".repeat(100)) }, 64),
    compact(route, { items: Array(100).fill("z".repeat(100)) }, 64),
  ];
  assert.ok(outputs.every((output) => output.length <= 240));
  assert.ok(outputs.reduce((total, output) => total + output.length, 0) <= 400);
  outputs.forEach((output) => assert.doesNotThrow(() => JSON.parse(output)));
});

test("keeps the strongest callsign relations within the item cap", () => {
  const compacted = JSON.parse(
    compactToolResponse(
      { skill: "callsign_relations", requestKind: "analysisPeriod" },
      {
        relations: [
          { callsign: "weak", weight: 1 },
          { callsign: "strong", weight: 20 },
          { callsign: "medium", weight: 10 },
        ],
      },
      2,
    ),
  );
  assert.deepEqual(
    compacted.relations.map((relation: { callsign: string }) => relation.callsign),
    ["strong", "medium"],
  );
  assert.equal(compacted._echoTruncation.truncated, true);
});

test("compacts restored history before prompting when the provider threshold is reached", async () => {
  const payload = validatePayload(
    {
      ...normalPayload,
      contextWindow: 4_096,
      maxTokens: 512,
      compactionReserveTokens: 1_024,
      compactionKeepRecentTokens: 1_024,
    },
    false,
  );
  let compactCalls = 0;
  const session = {
    messages: [
      { role: "user", content: "x".repeat(8_000), timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(8_000) }],
        timestamp: 2,
      },
    ],
    compact: async () => {
      compactCalls += 1;
      return { estimatedTokensAfter: 1_000 };
    },
  };
  await compactHistoryIfNeeded(session, payload);
  assert.equal(compactCalls, 1);
});

test("guides last-three-days gist follow-ups through inbox pagination and UID context", () => {
  const prompt = systemPrompt(validatePayload(normalPayload, false));
  assert.match(
    prompt,
    /questions about message content, meaning, themes, or gist/,
  );
  assert.match(prompt, /inherit the most recent period, group scope/);
  assert.match(prompt, /named subjects, and callsigns/);
  assert.match(prompt, /BOTH message-text search and extracted-callsign search/);
  assert.match(prompt, /following every returned next cursor/);
  assert.match(prompt, /using a UID returned with an inbox message/);
  assert.match(prompt, /“за останню добу” mean the rolling 24 hours/);
  assert.match(prompt, /never inside body/);
  assert.match(prompt, /Never ask the user/);
  assert.match(prompt, /Copy the citation field from the message unchanged/);
});

test("states the exact 90-day callsign windows for a fixed Kyiv instant", () => {
  const prompt = systemPrompt(
    validatePayload(
      {
        ...normalPayload,
        timeContext: {
          timeZone: "Europe/Kyiv",
          requestStartedAtUtc: "2026-09-28T12:00:00Z",
        },
      },
      false,
    ),
  );
  assert.match(
    prompt,
    /\[\{"kind":"date_range","sinceDate":"2026-08-29","tillDateInclusive":"2026-09-28"\},\{"kind":"date_range","sinceDate":"2026-07-29","tillDateInclusive":"2026-08-28"\},\{"kind":"date_range","sinceDate":"2026-07-01","tillDateInclusive":"2026-07-28"\}\]/,
  );
  assert.match(
    prompt,
    /equipment, an acronym, or otherwise does not identify the person/,
  );
  assert.match(prompt, /Explicit user periods still take precedence/);
});

test("announces the runner protocol and harness release", () => {
  assert.deepEqual(runnerHello(), {
    type: "runner_hello",
    protocolVersion: 1,
    harnessRelease: "2026.09.28.1",
  });
});

test("builds interception context body from an exact message UID", () => {
  assert.deepEqual(
    interceptionContextRequestBody({ messageUid: "message-42" }),
    {
      message_uid: "message-42",
    },
  );
  assert.throws(
    () => interceptionContextRequestBody({ group_master_key: "group-42" }),
    /unsupported field/,
  );
});

test("suppresses progress lifecycle and labels route lifecycle events", () => {
  const labels = new Map([
    ["echo_current_user", "Перевірка профілю користувача"],
  ]);
  assert.equal(
    normalizedToolLifecycleEvent(
      {
        type: "tool_execution_start",
        toolName: "report_progress",
        toolCallId: "p1",
      },
      labels,
    ),
    null,
  );
  assert.deepEqual(
    normalizedToolLifecycleEvent(
      {
        type: "tool_execution_end",
        toolName: "echo_current_user",
        toolCallId: "t1",
        isError: false,
      },
      labels,
    ),
    {
      type: "tool_end",
      tool_call_id: "t1",
      tool: "echo_current_user",
      toolLabel: "Перевірка профілю користувача",
      is_error: false,
    },
  );
  assert.deepEqual(
    normalizedToolLifecycleEvent(
      {
        type: "tool_execution_end",
        toolName: "echo_current_user",
        toolCallId: "t2",
        isError: true,
      },
      labels,
    ),
    {
      type: "tool_end",
      tool_call_id: "t2",
      tool: "echo_current_user",
      toolLabel: "Перевірка профілю користувача",
      is_error: true,
      errorSummary: "Не вдалося завантажити дані за вказаними параметрами.",
    },
  );
});

// Regression: https://github.com/echoua/echo/issues/3064
test("registers only complete message references surviving tool compaction", async () => {
  const { prepareMessageCitations, deliveredCitations, citationHref } =
    await import("./citations.ts");
  const item = [
    77,
    {
      message_uuid: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
      message_uid: "legacy / uid",
      text: "Source body",
      citation: "https://untrusted.invalid",
    },
  ];
  for (const [skill, body, requestKind] of [
    [
      "inbox_messages",
      { inbox_items: [item], page_limit: 20 },
      "inboxMessages",
    ],
    ["interception_context", { message: item }, "interceptionContext"],
    ["messages_by_id", { messages: [item] }, "messageIds"],
    ["messages_by_uuid", { messages: [item] }, "json"],
  ] as const) {
    const prepared = prepareMessageCitations(skill, body);
    const text = compactToolResponse({ skill, requestKind }, prepared.body, 64);
    assert.equal(deliveredCitations(text, prepared.citations).length, 1);
    assert.ok(text.includes(citationHref(prepared.citations[0])));
    assert.ok(!text.includes("untrusted.invalid"));
    assert.deepEqual(deliveredCitations("{}", prepared.citations), []);
  }
  assert.deepEqual(
    prepareMessageCitations("daily_activity", { messages: [item] }).citations,
    [],
  );
  const fallback = prepareMessageCitations("messages_by_id", {
    messages: [
      [78, { text: "Legacy body", message_uid: "legacy / uid" }],
      [79, { text: "No UID" }],
    ],
  });
  assert.match(citationHref(fallback.citations[0]), /m=legacy\+%2F\+uid$/);
  assert.equal(fallback.citations[1].messageIdentifier, "79");
});

test("keeps citation text when a full inbox page exceeds the response budget", async () => {
  const { prepareMessageCitations, deliveredCitations } =
    await import("./citations.ts");
  const items = Array.from({ length: 20 }, (_, index) => [
    index + 1,
    {
      message_uuid: `019fc7f7-9770-7f83-9c1a-211af29b${String(index).padStart(4, "0")}`,
      text: "x".repeat(6_000),
      image_recognized: ["image"],
    },
  ]);
  const prepared = prepareMessageCitations("inbox_messages", {
    inbox_items: items,
    page_limit: 20,
  });
  const text = compactToolResponse(
    { skill: "inbox_messages", requestKind: "inboxMessages" },
    prepared.body,
    8,
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.messages.length, 20);
  assert.ok(text.length <= 96_000);
  for (const message of parsed.messages) {
    assert.equal(typeof message.citation, "string");
    assert.equal(message.citation.includes("untrusted"), false);
    assert.ok(message.text.length > 0);
  }
  assert.equal(deliveredCitations(text, prepared.citations).length, 20);
});

test("projects bulky message lookups without dropping citation or text", async () => {
  const { prepareMessageCitations, deliveredCitations } =
    await import("./citations.ts");
  const bulky: Record<string, unknown> = {
    text: "quoted body",
    message_uuid: "11111111-1111-7111-8111-111111111111",
  };
  for (let index = 0; index < 80; index += 1)
    bulky[`extra_${index}`] = "x".repeat(500);
  const prepared = prepareMessageCitations("messages_by_id", {
    messages: [[5, bulky]],
  });
  const text = compactToolResponse(
    { skill: "messages_by_id", requestKind: "messageIds" },
    prepared.body,
    8,
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.messages.length, 1);
  assert.match(parsed.messages[0].text, /quoted body/);
  assert.match(
    parsed.messages[0].citation,
    /m=11111111-1111-7111-8111-111111111111$/,
  );
  assert.equal(text.includes("extra_0"), false);
  assert.equal(deliveredCitations(text, prepared.citations).length, 1);
  const missing = prepareMessageCitations("interception_context", {
    message: null,
    group_master_keys: [],
  });
  const empty = compactToolResponse(
    { skill: "interception_context", requestKind: "interceptionContext" },
    missing.body,
    64,
  );
  assert.equal(JSON.parse(empty).message, null);
  assert.deepEqual(deliveredCitations(empty, missing.citations), []);
});

test("continues a truncated inbox page from the last kept message", () => {
  const items = [41, 40, 39].map((id) => [
    id,
    {
      text: "y".repeat(4_000),
      message_uuid: `00000000-0000-7000-8000-${String(id).padStart(12, "0")}`,
    },
  ]);
  const text = compactToolResponse(
    { skill: "inbox_messages", requestKind: "inboxMessages" },
    { inbox_items: items, page_limit: 20 },
    64,
    700,
  );
  const parsed = JSON.parse(text);
  assert.ok(parsed.messages.length >= 1);
  assert.ok(parsed.messages.length < 3);
  for (const message of parsed.messages) assert.ok(message.text.length > 0);
  assert.equal(
    parsed.nextCursor,
    parsed.messages[parsed.messages.length - 1].id,
  );
});

test("canonicalizes registered citations and ignores a repair that adds none", async () => {
  const {
    canonicalizeAnswer,
    chooseCitedAnswer,
    citationsForCanonical,
    citationsForRepair,
    preserveRequestedCitation,
    needsCitationRepair,
    citationRepairPrompt,
    assistantSnapshotEvent,
    prepareMessageCitations,
  } = await import("./citations.ts");
  const citation = { messageId: 77, messageIdentifier: "source-77" };
  const href = "/rer-analysis-neo?m=source-77";
  const bare = `Evidence ${href} only.`;
  assert.equal(
    canonicalizeAnswer(bare, [citation]),
    `Evidence [джерело](${href}) only.`,
  );
  assert.equal(needsCitationRepair(bare, [citation]), false);
  assert.equal(
    canonicalizeAnswer(
      `No [джерело](/rer-analysis-neo?m=other) and [note](/rer-analysis-neo?m=other).`,
      [citation],
    ),
    "No  and note.",
  );
  assert.equal(needsCitationRepair("No sources.", [citation]), true);
  assert.equal(needsCitationRepair("No sources.", []), false);
  assert.deepEqual(
    prepareMessageCitations("daily_activity", { messages: [] }).citations,
    [],
  );
  const repaired = chooseCitedAnswer(
    "No sources.",
    `Used [джерело](${href}).`,
    [citation],
  );
  assert.equal(repaired, `Used [джерело](${href}).`);
  assert.equal(
    chooseCitedAnswer("No sources.", "Still none.", [citation]),
    "No sources.",
  );
  assert.equal(
    chooseCitedAnswer(`Used [джерело](${href}).`, "Rewritten without a link.", [
      citation,
    ]),
    `Used [джерело](${href}).`,
  );
  assert.ok(
    citationRepairPrompt("draft", [citation]).includes(`[джерело](${href})`),
  );
  assert.equal(assistantSnapshotEvent("same", "same"), null);
  assert.deepEqual(assistantSnapshotEvent("draft", repaired), {
    type: "assistant_snapshot",
    text: repaired,
  });
  assert.equal(assistantSnapshotEvent("draft", "x".repeat(300_000)), null);
  const citations = [
    { messageId: 7, messageIdentifier: "7" },
    { messageId: 77, messageIdentifier: "77" },
  ];
  const prefixed = canonicalizeAnswer("See /rer-analysis-neo?m=7.", citations);
  assert.equal(prefixed.includes("/rer-analysis-neo?m=77"), false);
  assert.match(prefixed, /\/rer-analysis-neo\?m=7\)/);
  const longer = canonicalizeAnswer("See /rer-analysis-neo?m=77.", citations);
  assert.match(longer, /\/rer-analysis-neo\?m=77\)/);
  assert.equal(longer.includes("/rer-analysis-neo?m=7)"), false);
  const byId = canonicalizeAnswer(
    "Count [джерело](echo_daily_activity). Claim [джерело](77) and [джерело](7, 77).",
    citations,
  );
  assert.equal(byId.includes("echo_daily_activity"), false);
  assert.equal(
    byId,
    `Count . Claim [джерело](/rer-analysis-neo?m=77) and [джерело](/rer-analysis-neo?m=7)[джерело](/rer-analysis-neo?m=77).`,
  );
  assert.equal(needsCitationRepair(byId, citations), false);
  assert.equal(
    canonicalizeAnswer("[джерело](/rer-analysis-neo?m=7).", [
      { messageId: 7, messageIdentifier: "uuid-7" },
    ]),
    "[джерело](/rer-analysis-neo?m=uuid-7).",
  );
  assert.equal(
    canonicalizeAnswer("[note](see 7).", citations),
    "[note](see 7).",
  );
  assert.deepEqual(citationsForRepair([citation], citations, "без джерела"), [
    citation,
  ]);
  assert.deepEqual(citationsForRepair([], citations, "дякую"), []);
  assert.deepEqual(
    citationsForRepair([], citations, "залиш посилання"),
    citations,
  );
  assert.equal(
    preserveRequestedCitation("Уточнення.", citations, 0),
    "Уточнення.\n\n[джерело](/rer-analysis-neo?m=7)",
  );
  assert.equal(
    preserveRequestedCitation(`Used [джерело](${href}).`, [citation], 0),
    `Used [джерело](${href}).`,
  );
  assert.equal(
    preserveRequestedCitation("Уточнення.", citations, 1),
    "Уточнення.",
  );
  const historical = "[джерело](/rer-analysis-neo?m=77).";
  assert.equal(
    chooseCitedAnswer(historical, null, [], citations),
    historical,
  );
  assert.equal(
    chooseCitedAnswer("[джерело](77).", null, [], citations),
    "[джерело](/rer-analysis-neo?m=77).",
  );
  const fresh = { messageId: 8, messageIdentifier: "new" };
  assert.equal(
    chooseCitedAnswer(
      historical,
      "[джерело](/rer-analysis-neo?m=new).",
      [fresh],
      citationsForCanonical([fresh], citations),
    ),
    "[джерело](/rer-analysis-neo?m=new).",
  );
  assert.equal(
    chooseCitedAnswer(historical, historical, [fresh], citations),
    historical,
  );
});

test("discards a truncated or empty citation repair", () => {
  const assistant = (text: string, stopReason = "stop") => ({
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
  });
  assert.equal(completedRepairText([assistant("Done.")]), "Done.");
  assert.equal(completedRepairText([assistant("Cut", "length")]), null);
  assert.equal(completedRepairText([assistant("   ")]), null);
  assert.equal(completedRepairText([]), null);
});
