import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compactInboxResponse,
  createToolLifecycleGuard,
  createToolInvocationGuard,
  dailyActivityRequestBody,
  inboxMessagesRequestBody,
  interceptionContextRequestBody,
  messagesByIdRequestBody,
  normalizedToolLifecycleEvent,
  runnerHello,
  sourceEvent,
  systemPrompt,
  testConnection,
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

test("guides last-three-days gist follow-ups through inbox pagination and UID context", () => {
  const prompt = systemPrompt(validatePayload(normalPayload, false));
  assert.match(
    prompt,
    /questions about message content, meaning, themes, or gist/,
  );
  assert.match(prompt, /inherit the most recent period and group scope/);
  assert.match(prompt, /following every returned next cursor/);
  assert.match(prompt, /using a UID returned with an inbox message/);
  assert.match(prompt, /Never ask the user/);
});

test("announces the runner protocol and harness release", () => {
  assert.deepEqual(runnerHello(), {
    type: "runner_hello",
    protocolVersion: 1,
    harnessRelease: "2026.08.05.2",
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
