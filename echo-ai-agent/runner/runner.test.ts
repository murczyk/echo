import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  frequencySummaryRequestBody,
  mapOutcomeNotices,
  mapOutcomeRepairPrompt,
  observeMapOutcome,
  scriptFailure,
  toolErrorReason,
  toolErrorSummary,
  analysisPeriodRequestBody,
  callsignFrequencyMatchesRequestBody,
  compactInboxResponse,
  compactToolResponse,
  createToolLifecycleGuard,
  createToolInvocationGuard,
  createToolResponseCompactor,
  createContextToolResponseCompactor,
  searchHitEvidence,
  toolContextBudget,
  createRouteActivityTracker,
  dailyActivityRequestBody,
  directionFindingsRequestBody,
  inboxMessagesRequestBody,
  mentionedColorCodes,
  mentionedFrequencies,
  normalizeFrequency,
  unitLookupRequestBody,
  interceptionContextRequestBody,
  messagesByIdRequestBody,
  normalizedToolLifecycleEvent,
  runnerHello,
  sourceEvent,
  subscribeToEvents,
  systemPrompt,
  testConnection,
  completedRepairText,
  validateFinalAssistantMessage,
  formatEchoHttpError,
  validatePayload,
  validateSkill,
  validationFields,
  writeModelsFile,
  normalizePeriodArgument,
  prepareRouteArguments,
  schemaArguments,
  uuidArgument,
} from "./runner.ts";
import { createGroupScope, resolveGroups } from "./group-scope.ts";
import { EDIT_GUIDANCE, MAP_GUIDANCE, MapRegistry } from "./maps.ts";

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

test("#4112 keeps a provider content filter recognizable", () => {
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "400 content_filter: ResponsibleAIPolicyViolation",
          content: [],
        },
      ]),
    /provider request failed: content_filter/,
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

test("registers the refusal rewrite engine only for gateway models", async () => {
  const gatewayRewrite = {
    ...normalPayload,
    modelName: "gpt-6.1-sol",
    providerTransport: "echo_gateway",
    providerApiKey: "A".repeat(43),
    rewriteModelName: "gpt-6-luna",
    rewriteMaxTokens: 2_048,
  };
  const payload = validatePayload(gatewayRewrite, false);
  assert.equal(payload.rewriteModelName, "gpt-6-luna");
  assert.equal(payload.rewriteMaxTokens, 2_048);
  assert.ok(systemPrompt(payload).includes("Role and authorization context"));
  assert.doesNotMatch(systemPrompt(validatePayload(normalPayload, false)), /Role and authorization context/);
  const directory = await mkdtemp(join(tmpdir(), "echo-ai-agent-test-"));
  try {
    const modelsPath = await writeModelsFile(directory, payload);
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    const rewrite = models.providers["echo-vllm"].models.find(
      (model: { id: string }) => model.id === "gpt-6-luna",
    );
    assert.equal(rewrite.reasoning, false);
    assert.equal(rewrite.maxTokens, 2_048);
    assert.deepEqual(rewrite.input, ["text"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      validatePayload(
        { ...normalPayload, rewriteModelName: "gpt-6-luna" },
        false,
      ),
    /refusal rewrite provider requires a gateway model/,
  );
  assert.throws(
    () =>
      validatePayload(
        { ...normalPayload, rewriteMaxTokens: 2_048 },
        false,
      ),
    /rewriteMaxTokens requires rewriteModelName/,
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

test("#4070 frequency summary accepts the filters its route supports", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const params = {
    period: { kind: "relative_days", days: 31 },
    selectedFrequencies: ["163,935", "3330"],
    selectedUnitIds: [7, 7],
    selectedUnits: ["8 дшр"],
  };
  assert.deepEqual(frequencySummaryRequestBody(params, context), {
    since_date_inclusive_ms: Date.parse("2026-07-04T21:00:00Z"),
    till_date_noninclusive_ms: Date.parse("2026-08-04T21:00:00Z"),
    selected_freqs: ["163.9350", "3330"],
    selected_unit_ids: [7],
    selected_units: ["8 дшр"],
  });
  assert.throws(
    () => frequencySummaryRequestBody({ ...params, search: "x" }, context),
    /unsupported field/,
  );
  assert.throws(
    () => analysisPeriodRequestBody(params, context),
    /unsupported field/,
  );
});

test("#4070 frequency summary compaction keeps ranked rows and shows they are partial", () => {
  const route = { skill: "frequency_summary", requestKind: "analysisPeriod" as const };
  const value = {
    rows: Array.from({ length: 128 }, (_, index) => ({
      freq: `${index}`,
      count: 1000 - index,
      callsigns: Array.from({ length: 32 }, (_, item) => `позивний ${item}`),
      units: ["підрозділ"],
      locations: [],
    })),
    total_rows: 11636,
    row_values_truncated: false,
  };

  const tiny = JSON.parse(compactToolResponse(route, value, 1));
  assert.equal(tiny.rows.length, 1);
  assert.equal(tiny.rows[0].count, 1000);
  assert.equal(tiny.total_rows, 11636);
  assert.equal(tiny.row_values_truncated, false);

  const bounded = JSON.parse(compactToolResponse(route, value, 128, 3000));
  assert.ok(bounded.rows.length >= 1 && bounded.rows.length < 128);
  assert.deepEqual(bounded.rows[0].units, ["підрозділ"]);
  assert.equal(bounded.rows[0].callsigns.length, 4);
  assert.equal(bounded.rows[0].count, 1000);
  assert.equal(bounded.total_rows, 11636);
  assert.equal(bounded.row_values_truncated, true);
  assert.ok(JSON.stringify(bounded).length <= 3000);
});

test("passes unit filters to inbox requests and validates them", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const params = {
    period: { kind: "relative_days", days: 1 },
    selectedUnitIds: [79989, 79989, 5],
    selectedUnits: [" 8 дшр 3 дшб 104 дшп 76 дшд пдв "],
  };
  const body = inboxMessagesRequestBody(params, context);
  assert.deepEqual(body.selected_unit_ids, [79989, 5]);
  assert.deepEqual(body.selected_units, ["8 дшр 3 дшб 104 дшп 76 дшд пдв"]);
  assert.equal(body.search, undefined);
  assert.throws(() => inboxMessagesRequestBody({ ...params, selectedUnitIds: [] }, context));
  assert.throws(() => inboxMessagesRequestBody({ ...params, selectedUnitIds: [0] }, context));
  assert.throws(() => inboxMessagesRequestBody({ ...params, selectedUnits: [" "] }, context));
});

test("incident 01a1a1d8: normalizes user-written frequencies to the stored four-decimal form", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const params = {
    period: { kind: "relative_days", days: 1 },
    selectedFrequencies: ["163.935", "163,9350", " 163.93 ", "27.135", "3330"],
  };
  const body = inboxMessagesRequestBody(params, context);
  // Integer-only values stay unchanged, as Echo stores «Частота: 3330».
  assert.deepEqual(body.selected_freqs, ["163.9350", "163.9300", "27.1350", "3330"]);
  assert.equal(body.search, undefined);
  assert.equal(normalizeFrequency("163.9350"), "163.9350");
  for (const invalid of ["16", "163.93501", "abc", "163.935 МГц"])
    assert.throws(() => inboxMessagesRequestBody({ ...params, selectedFrequencies: [invalid] }, context));
  assert.throws(() => inboxMessagesRequestBody({ ...params, selectedFrequencies: [] }, context));
});

test("incident 01a1a1d8: tells the agent that mentioned frequencies equal their stored form", () => {
  assert.deepEqual(
    mentionedFrequencies([
      "02.11.2026, 13:49:43\n150.4750\n47.392477 36.056984 449.500.000",
      "Проаналізуй з іншими частотами 163.935 та 163,935, хвиля 169.3500МГц",
    ]),
    [
      { written: "150.4750", stored: "150.4750" },
      { written: "163.935", stored: "163.9350" },
      { written: "163,935", stored: "163.9350" },
      { written: "169.3500", stored: "169.3500" },
    ],
  );
  const prompt = systemPrompt(
    validatePayload(
      {
        ...normalPayload,
        history: [{ role: "user", content: "Що на 165.55?" }],
        prompt: "Проаналізуй з іншими частотами 163.935 та дай прив'язку де найбільше схожих позивних",
      },
      false,
    ),
  );
  assert.match(prompt, /stored ECHO form: 165\.55 = 165\.5500, 163\.935 = 163\.9350\. Each pair is the same frequency/);
  assert.match(prompt, /only the frequencies the current request is about/);
  assert.doesNotMatch(systemPrompt(validatePayload(normalPayload, false)), /Frequencies named in this conversation/);
});

test("#3998 reads СС3 in a user query as the DMR color code", () => {
  assert.deepEqual(
    mentionedColorCodes([
      "144.8450 Мишаня Якудза, СС3",
      "CC: 7 і код кольору 12, 🎨5, cc03, СС-300, сс16, ссылка 3",
    ]),
    [
      { written: "СС3", colorCode: "3" },
      { written: "CC: 7", colorCode: "7" },
      { written: "код кольору 12", colorCode: "12" },
      { written: "🎨5", colorCode: "5" },
      { written: "cc03", colorCode: "3" },
    ],
  );
  const prompt = systemPrompt(
    validatePayload({ ...normalPayload, history: [], prompt: "144.8450 Мишаня Якудза, СС3" }, false),
  );
  assert.match(prompt, /stored ECHO form: 144\.8450\./);
  assert.match(prompt, /DMR color codes named in this conversation: СС3 = color code 3\. They are radio network metadata, not callsigns/);
  assert.match(prompt, /is the DMR color code \(0–15\) of a radio network/);
  assert.doesNotMatch(systemPrompt(validatePayload(normalPayload, false)), /DMR color codes named/);
});

test("#3998 exposes parsed DMR metadata on retrieved messages", async () => {
  const item = (id: number, metadata: unknown) => [id, { message_uid: `uid-${id}`, freq: "144.8450", text: "СС: 3 👥: 24538🔐", metadata }];
  const response = compactInboxResponse({
    inbox_items: [
      item(2, [
        { color_code: "3", color_code_start_index: 0, call_group_id: "24538", sender_id: null, hash_id: "2324D327" },
        { color_code: "3", call_group_id: "24538" },
        { color_code: " ", call_group_id: null },
      ]),
      item(1, []),
      item(4, [{ color_code: "03" }, { color_code: "3" }]),
    ],
    page_limit: 20,
  });
  const messages = response.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0].dmr, { colorCodes: ["3"], callGroups: [{ id: "24538" }] });
  assert.equal("dmr" in messages[1], false);
  // Retained evidence for final synthesis keeps the same projection.
  const { prepareMessageCitations } = await import("./citations.ts");
  const prepared = prepareMessageCitations("inbox_messages", { inbox_items: [item(2, [{ color_code: "03", sender_id: "7" }]), item(1, [])] });
  assert.deepEqual(prepared.messages.map((message) => message.dmr), [{ colorCodes: ["3"], senders: [{ id: "7" }] }, undefined]);
  // A zero-padded source code equals the user's «СС3».
  assert.deepEqual(messages[2].dmr, { colorCodes: ["3"] });
  // Every color code of a nine-code list survives; long id lists are marked truncated.
  const wide = compactInboxResponse({
    inbox_items: [item(3, [
      ...Array.from({ length: 9 }, (_, code) => ({ color_code: String(code), sender_id: "7" })),
      ...Array.from({ length: 40 }, (_, index) => ({ call_group_id: String(1000 + index) })),
    ])],
    page_limit: 20,
  });
  const dmr = (wide.messages as Array<Record<string, any>>)[0].dmr;
  assert.deepEqual(dmr.colorCodes, ["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(dmr.senders, [{ id: "7" }]);
  assert.equal(dmr.callGroups.length, 32);
  assert.equal(dmr.truncated, true);
});

test("builds bounded read-only unit lookup requests", () => {
  assert.deepEqual(unitLookupRequestBody({ query: " 3 дшб 104 дшп " }), {
    filter_text: "3 дшб 104 дшп",
    search_mode: "Relaxed",
    include_inactive: false,
    limit: 20,
  });
  assert.equal(unitLookupRequestBody({ query: "x", afterUnitId: 20 }).after_unit_id, 20);
  assert.throws(() => unitLookupRequestBody({ query: "x", afterUnitId: 0 }));
  assert.throws(() => unitLookupRequestBody({ query: " " }));
  assert.throws(() => unitLookupRequestBody({ query: "x", limit: 500 }));
});

test("unit lookup responses respect the character budget and expose a cursor", () => {
  const units = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: "x".repeat(150), comment: "y".repeat(5000), active: true }));
  const text = compactToolResponse({ skill: "unit_lookup", requestKind: "unitLookup" }, { units, total_count: 40, show_load_more: true }, 20, 3000);
  assert.ok(text.length <= 3000);
  const result = JSON.parse(text);
  assert.equal(result.nextCursor, result.units.at(-1).id);
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

test("#4179 an over-long inbox period names the date_range windows to call instead", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const message = (period: unknown) => {
    try {
      inboxMessagesRequestBody({ period }, context);
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail(`accepted ${JSON.stringify(period)}`);
  };
  const windowsOf = (text: string) =>
    [...text.matchAll(/\{"kind":"date_range"[^}]*\}/g)].map(([json]) => JSON.parse(json));
  // Today is 2026-08-04 in Kyiv: 90 days are 31 + 31 + 28, as SEARCH.md prescribes.
  const ninety = message({ kind: "relative_days", days: 90 });
  assert.match(ninety, /^recent Kyiv days must be between 1 and 31\. One call reads at most 31 Kyiv days and this period covers 90\./);
  assert.deepEqual(windowsOf(ninety), [
    { kind: "date_range", sinceDate: "2026-07-05", tillDateInclusive: "2026-08-04" },
    { kind: "date_range", sinceDate: "2026-06-04", tillDateInclusive: "2026-07-04" },
    { kind: "date_range", sinceDate: "2026-05-07", tillDateInclusive: "2026-06-03" },
  ]);
  assert.doesNotMatch(ninety, /continue/);
  // Every window is accepted as is, and together they are the requested period.
  const bodies = windowsOf(ninety).map((period) => inboxMessagesRequestBody({ period }, context));
  const whole = { since: Date.parse("2026-05-06T21:00:00Z"), till: Date.parse("2026-08-04T21:00:00Z") - 1 };
  assert.equal(bodies[0].till_date_inclusive_ms, whole.till);
  assert.equal(bodies.at(-1)!.since_date_inclusive_ms, whole.since);
  for (let index = 1; index < bodies.length; index++)
    assert.equal((bodies[index].till_date_inclusive_ms as number) + 1, bodies[index - 1].since_date_inclusive_ms);

  const range = message({ kind: "date_range", sinceDate: "2026-06-01", tillDateInclusive: "2026-07-31" });
  assert.match(range, /^inbox messages date range cannot exceed 31 days\. One call reads at most 31 Kyiv days and this period covers 61\./);
  assert.deepEqual(windowsOf(range), [
    { kind: "date_range", sinceDate: "2026-07-01", tillDateInclusive: "2026-07-31" },
    { kind: "date_range", sinceDate: "2026-06-01", tillDateInclusive: "2026-06-30" },
  ]);
  assert.deepEqual(windowsOf(message({ start: "2026-06-01", end: "2026-08-01" })), windowsOf(range));
  assert.equal(windowsOf(message({ kind: "sinceDate", sinceDate: "2026-06-01" })).length, 3);
  // Calendar windows would widen a rolling period, so hours keep the plain limit.
  assert.equal(message({ kind: "relative_hours", hours: 1000 }), "recent hours must be between 1 and 744");

  const year = message({ kind: "relative_days", days: 400 });
  assert.equal(windowsOf(year).length, 4);
  assert.match(year, /, then continue the same way back to 2025-07-01\.$/);
  // Values no one means, and values below the range, keep the plain limit.
  for (const period of [{ kind: "relative_days", days: 100_000 }, { kind: "relative_days", days: 0 }, { kind: "relative_hours", hours: 0 }])
    assert.equal(windowsOf(message(period)).length, 0, JSON.stringify(period));
  assert.equal(message({ kind: "relative_days", days: 0 }), "recent Kyiv days must be between 1 and 31");
});

test("#4083 a blank inbox search means no text filter", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const period = { kind: "relative_days", days: 3 };
  const unfiltered = inboxMessagesRequestBody({ period }, context);
  assert.equal("search" in unfiltered, false);
  for (const search of ["", "   "])
    assert.deepEqual(inboxMessagesRequestBody({ period, search }, context), unfiltered);
  assert.equal(inboxMessagesRequestBody({ period, search: "  удар  " }, context).search, "удар");
  assert.throws(() => inboxMessagesRequestBody({ period, search: "x".repeat(2001) }, context), /at most 2000/);
});

test("#4083 Echo's own argument checks name the parameter and never the values", async () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const parameterNames = new Map([
    ["echo_inbox_messages", new Set(["period", "search", "selectedGroups", "selectedCallsigns", "selectedFrequencies", "selectedUnitIds", "selectedUnits", "cursor", "maxItems"])],
  ]);
  const fieldsOf = (message: string) =>
    validationFields(
      { content: [{ type: "text", text: message.startsWith("Invalid Echo tool arguments: ") ? message : `Invalid Echo tool arguments: ${message}` }] },
      "echo_inbox_messages",
      parameterNames,
    );
  const rejection = (params: Record<string, unknown>) => {
    try {
      inboxMessagesRequestBody({ period: { kind: "relative_days", days: 3 }, ...params }, context);
    } catch (error) {
      return fieldsOf((error as Error).message);
    }
    assert.fail(`accepted ${JSON.stringify(params)}`);
  };
  assert.equal(rejection({ period: { kind: "relative_days", days: 32 } }), "period:size");
  assert.equal(rejection({ period: { kind: "relative_hours", hours: 0 } }), "period:size");
  assert.equal(rejection({ period: { kind: "relative_days", days: 3, extra: 1 } }), "period:additional");
  assert.equal(rejection({ period: { kind: "date_range", sinceDate: "2026-08-04", tillDateInclusive: "2026-08-01" } }), "period:order");
  assert.equal(rejection({ period: { kind: "date_range", sinceDate: "SENSITIVE", tillDateInclusive: "2026-08-01" } }), "period.sinceDate:invalid");
  assert.equal(rejection({ period: { kind: "weeks" } }), "period:invalid");
  assert.equal(rejection({ cursor: 0 }), "cursor:invalid");
  assert.equal(rejection({ maxItems: 500 }), "maxItems:size");
  assert.equal(rejection({ search: 7 }), "search:size");
  assert.equal(rejection({ selectedCallsigns: ["  "] }), "selectedCallsigns:blank");
  assert.equal(rejection({ selectedFrequencies: ["SENSITIVE"] }), "selectedFrequencies:invalid");
  assert.equal(rejection({ selectedUnitIds: [] }), "selectedUnitIds:size");
  assert.equal(rejection({ SENSITIVE: 1 }), "root:additional");

  const groups = [{ master_key: "group.devops", name: "DEVOPS" }];
  assert.throws(() => resolveGroups(["SENSITIVE"], groups), (error: Error) => {
    assert.equal(fieldsOf(error.message), "selectedGroups:unknown");
    return true;
  });
  const scope = createGroupScope(async () => groups, () => {});
  await scope.resolve({ selectedGroups: ["DEVOPS"] }, true);
  await assert.rejects(scope.resolve({}, true), (error: Error) => {
    assert.equal(fieldsOf(error.message), "selectedGroups:required");
    return true;
  });
  assert.equal(fieldsOf("SENSITIVE text from an unknown check"), undefined);
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

test("#3724 bounds tool context and reports exhaustion instead of empty data", () => {
  const route = { skill: "metadata_statistics", requestKind: "analysisPeriod" as const };
  const compact = createToolResponseCompactor(400, 240, 3);
  const outputs = [
    compact(route, { items: Array(100).fill("x".repeat(100)) }, 64),
    compact(route, { items: Array(100).fill("y".repeat(100)) }, 64),
  ];
  assert.ok(outputs.every((output) => output.length <= 240));
  assert.ok(outputs.reduce((total, output) => total + output.length, 0) <= 400);
  outputs.forEach((output) => assert.doesNotThrow(() => JSON.parse(output)));
  assert.throws(() => compact(route, { items: Array(100).fill("z".repeat(100)) }, 64), /tool context budget exhausted/);
});

// Regression: https://github.com/echoua/echo/issues/4224
test("#4224 tool context budget leaves room for the window's fixed context and clears after compaction", () => {
  for (const contextWindow of [32_768, 65_536, 131_072, 262_144, 1_050_000])
    for (const keep of [1_024, 8_192, 49_152])
      for (const fixedTokens of [0, 20_000]) {
        const maxTokens = Math.min(65_536, Math.floor(contextWindow / 8));
        const reserve = Math.min(131_072, Math.floor(contextWindow / 4));
        const budget = toolContextBudget({ contextWindow, maxTokens, compactionReserveTokens: reserve, compactionKeepRecentTokens: keep, fixedTokens });
        assert.ok(budget.totalCharacters >= 2 * budget.batchCharacters);
        assert.ok(budget.thresholdCharacters <= budget.batchCharacters);
        assert.ok(budget.keepRecentTokens * 4 <= budget.totalCharacters - budget.thresholdCharacters);
        assert.ok(budget.keepRecentTokens <= keep);
      }
  // GPT-6.1 Sol on the government gateway: a batch fits well inside the 45k-token trigger.
  const sol = toolContextBudget({ contextWindow: 65_536, maxTokens: 8_192, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 8_192, fixedTokens: 20_000 });
  assert.ok(sol.batchCharacters / 3 < 65_536 - 4_096 - 16_384 - 20_000);
  assert.equal(sol.keepRecentTokens, 8_192);
  // GLM keeps its per-call ceiling.
  const glm = toolContextBudget({ contextWindow: 262_144, maxTokens: 16_384, compactionReserveTokens: 32_768, compactionKeepRecentTokens: 16_384, fixedTokens: 20_000 });
  assert.equal(glm.thresholdCharacters, 96_000);
});

test("#4224 parallel tool calls share one batch so the last call still delivers data", () => {
  const route = { skill: "device_file_search", requestKind: "deviceFileSearch" as const };
  const compact = createContextToolResponseCompactor(65_536, { maxTokens: 8_192, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 8_192, fixedTokens: 20_000 });
  const hits = (query: number) => ({
    documents: Array.from({ length: 50 }, (_, index) => ({
      deviceId: "01999999-1111-7111-8111-111111111111",
      fileId: `01999999-2222-7222-8222-${String(query * 100 + index).padStart(12, "0")}`,
      revision: 1, fileName: `file-${query}-${index}.exe`, path: `C:\\Activators\\file-${query}-${index}.exe`,
      state: "completed", current: true, hasContent: true, complete: true, summaryState: "completed",
      summary: "Опис файлу. ".repeat(150), citation: `/devices/d?file=${query}-${index}&revision=1`,
    })),
    nextCursor: null,
  });
  const budget = toolContextBudget({ contextWindow: 65_536, maxTokens: 8_192, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 8_192, fixedTokens: 20_000 });
  compact.beginBatch(6);
  const outputs = Array.from({ length: 6 }, (_, query) => compact(route, hits(query), 64));
  assert.ok(outputs.every((output) => JSON.parse(output).documents.length > 0));
  assert.ok(outputs.reduce((total, output) => total + output.length, 0) <= budget.batchCharacters);
  assert.equal(compact.needsCompaction(), false);
  compact.beginBatch(1);
  assert.ok(compact(route, hits(7), 64).length > outputs[0].length, "a single call may use the whole batch");
});

test("#4224 a batch wider than its minimum shares defers the excess calls instead of overrunning", () => {
  const route = { skill: "device_file_search", requestKind: "deviceFileSearch" as const };
  const profile = { maxTokens: 8_192, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 8_192, fixedTokens: 20_000 };
  const budget = toolContextBudget({ contextWindow: 65_536, ...profile });
  const compact = createContextToolResponseCompactor(65_536, profile);
  const page = (query: number) => ({
    documents: Array.from({ length: 50 }, (_, index) => ({
      deviceId: "01999999-1111-7111-8111-111111111111", fileId: `01999999-2222-7222-8222-${String(query * 100 + index).padStart(12, "0")}`,
      revision: 1, fileName: `file-${query}-${index}.exe`, state: "completed", summary: "Опис. ".repeat(40), citation: `/devices/d?file=${query}-${index}&revision=1`,
    })),
    nextCursor: null,
  });
  compact.beginBatch(64);
  let delivered = 0;
  let deferred = 0;
  for (let call = 0; call < 64; call++) {
    if (!compact.admit()) {
      deferred += 1;
      continue;
    }
    delivered += compact(route, page(call), 64).length;
  }
  assert.ok(delivered <= budget.batchCharacters, `${delivered} > ${budget.batchCharacters}`);
  assert.equal(deferred, 64 - Math.floor(budget.batchCharacters / 2_000));
  assert.equal(compact.needsCompaction(), false);
  compact.beginBatch(2);
  assert.ok(compact.admit(), "the next turn runs again");
});

test("#4224 search hit evidence keeps each attachment and its matched snippet", () => {
  const citation = "/rer-analysis-neo?m=source-7";
  const hits = searchHitEvidence("attachmentSearch", JSON.stringify({ documents: [
    { mediaId: "media-1", fileName: "orders.pdf", text: "orders.pdf", snippet: "page 2: KMSAuto activation key", citation },
    { mediaId: "media-2", fileName: "notes.docx", text: "Нотатки про активатори", snippet: "AAct portable", citation },
  ] }));
  assert.equal(new Set(hits.map((hit) => hit.id)).size, 2);
  assert.equal(hits[0].text, "orders.pdf: page 2: KMSAuto activation key");
  assert.equal(hits[1].text, "notes.docx: Нотатки про активатори — AAct portable");
  const [file] = searchHitEvidence("deviceFileSearch", JSON.stringify({ documents: [
    { fileName: "KMSAuto.exe", folder: "C:\\Activators", summary: "KMS activator", snippet: "page 1: activation", citation: "/devices/d?file=f&revision=1" },
  ] }));
  assert.equal(file.text, "KMSAuto.exe (C:\\Activators): KMS activator — page 1: activation");
  // A long summary cannot push the matched snippet out.
  const [long] = searchHitEvidence("deviceFileSearch", JSON.stringify({ documents: [
    { fileName: "KMSAuto.exe", folder: "C:\\Activators", summary: "Опис файлу. ".repeat(100), snippet: "page 3: HWID activation key", citation: "/devices/d?file=f&revision=1" },
  ] }));
  assert.ok(long.text.endsWith(" — page 3: HWID activation key"), long.text);
  assert.ok(long.text.length < 700);
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

test("accepts a map edit target and keeps ordinary prompts unchanged", () => {
  const plain = systemPrompt(validatePayload(normalPayload, false));
  assert.match(plain, /Never attempt mutation/);
  assert.equal(plain.includes(EDIT_GUIDANCE), false);
  assert.match(plain, /When asked for a map or CSV\/KMZ from points/);
  const mapEdit = {
    requestId: "11111111-1111-4111-8111-111111111111",
    mapId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    selectedPointIds: ["33333333-3333-5333-8333-333333333333"],
  };
  const editing = systemPrompt(validatePayload({ ...normalPayload, mapEdit }, false));
  assert.ok(editing.includes(MAP_GUIDANCE));
  assert.ok(editing.includes(EDIT_GUIDANCE));
  assert.equal(
    validateSkill({
      method: "POST",
      path: "/api/ai-agent/maps/edit",
      skill: "map_edit",
      label: "Оновлюю перегляд мапи",
      requestKind: "mapEdit",
    }).requestKind,
    "mapEdit",
  );
  assert.throws(() =>
    validateSkill({
      method: "POST",
      path: "/api/ai-agent/maps/get",
      skill: "map_edit",
      label: "Оновлюю перегляд мапи",
      requestKind: "mapEdit",
    }),
  );
  assert.equal(
    formatEchoHttpError(409, "plain", { message: "  Мапа змінилася.\nОновіть перегляд  " }),
    "Echo returned HTTP 409: Мапа змінилася. Оновіть перегляд",
  );
  assert.equal(formatEchoHttpError(500, "   ", null), "Echo returned HTTP 500");
});

test("announces the runner protocol and harness release", () => {
  assert.deepEqual(runnerHello(), {
    type: "runner_hello",
    protocolVersion: 1,
    harnessRelease: "2026.11.16.1",
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
      errorReason: "tool_error",
    },
  );
});

// Regression: https://github.com/echoua/echo/issues/3064
test("streams individual tool steps before the whole batch finishes", () => {
  const events: Record<string, unknown>[] = [];
  let consume: (event: any) => void = () => {};
  let emitAssistant = true;
  subscribeToEvents(
    {
      subscribe: (listener: (event: any) => void) => {
        consume = listener;
        return () => {};
      },
    },
    new Map([["echo_inbox_messages", "Шукаю перехоплення"]]),
    () => {},
    () => {},
    () => emitAssistant,
    (event) => events.push(event),
  );
  consume({ type: "turn_start" });
  consume({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: "Private reasoning",
    },
  });
  consume({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        content: [
          {
            type: "toolCall",
            id: "first-page",
            name: "echo_inbox_messages",
            arguments: { private: "Internal arguments" },
          },
        ],
      },
    },
  });
  assert.deepEqual(events, []);
  consume({
    type: "tool_execution_start",
    toolCallId: "first-page",
    toolName: "echo_inbox_messages",
    args: { period: { kind: "relative_days", days: 7 } },
  });
  consume({
    type: "tool_execution_end",
    toolCallId: "first-page",
    toolName: "echo_inbox_messages",
    isError: false,
  });
  assert.equal(events.at(-1)?.type, "tool_end");
  assert.equal(events.at(-1)?.tool_call_id, "first-page");
  consume({
    type: "tool_execution_start",
    toolCallId: "second-page",
    toolName: "echo_inbox_messages",
    args: { period: { kind: "relative_days", days: 7 } },
  });
  assert.equal(events.at(-1)?.type, "tool_start");
  assert.equal(events.at(-1)?.tool_call_id, "second-page");
  consume({
    type: "tool_execution_end",
    toolCallId: "second-page",
    toolName: "echo_inbox_messages",
    isError: false,
  });
  consume({ type: "turn_start" });
  consume({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Підсумок" },
  });
  assert.equal(events.at(-2)?.type, "tool_end");
  assert.deepEqual(events.at(-1), { type: "assistant_delta", delta: "Підсумок" });
  const beforeRepair = events.length;
  emitAssistant = false;
  consume({ type: "turn_start" });
  consume({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Private repair" },
  });
  assert.equal(events.length, beforeRepair);
  assert.equal(JSON.stringify(events).includes("Private"), false);
  assert.equal(JSON.stringify(events).includes("Internal arguments"), false);
});

// Regression: https://github.com/echoua/echo/issues/3064
// Regression: https://github.com/echoua/echo/issues/4224
test("#4224 device file, device and attachment searches report their query and results", () => {
  const tracker = createRouteActivityTracker();
  const fileRoute = validateSkill({ method: "POST", path: "/api/device/files/ai/search", skill: "device_file_search", label: "Шукаю файли пристроїв", requestKind: "deviceFileSearch" });
  const deviceRoute = validateSkill({ method: "POST", path: "/api/device/ai/search", skill: "device_search", label: "Шукаю пристрої", requestKind: "deviceSearch" });
  const attachmentRoute = validateSkill({ method: "POST", path: "/api/attachments/search", skill: "attachment_search", label: "Шукаю документи", requestKind: "attachmentSearch" });
  const deviceIds = ["01a01968-4b8e-7aa3-95b9-c1d954217f04", "01a01968-6046-7760-bbe7-883ad24817e3", "01a15873-1eb7-7373-91c5-cdd7eca30ac8"];
  const devices = tracker.start(deviceRoute, { query: "ноутбук", unitIds: [3, 4], limit: 50 });
  assert.equal(devices.label, "Шукаю пристрої · пошук «ноутбук» · підрозділів: 2");
  const deviceResponse = { devices: deviceIds.map((id, index) => ({ id, name: `Ноутбук-${index + 1}` })), nextCursor: null };
  assert.equal(tracker.finish(deviceRoute, devices, deviceResponse, JSON.stringify(deviceResponse)), "Шукаю пристрої · пошук «ноутбук» · знайдено пристроїв: 3 · підрозділів: 2");

  const body = { query: "KMS", scope: "name", deviceIds, pathPrefix: "C:\\Activators", format: "exe", from: Date.UTC(2026, 10, 1) - 2 * 3_600_000, to: Date.UTC(2026, 10, 16) - 2 * 3_600_000 - 1, history: true, limit: 50 };
  const first = tracker.start(fileRoute, body);
  assert.equal(first.label, "Шукаю файли пристроїв · пошук «KMS» · у назвах · пристрої «Ноутбук-1», «Ноутбук-2» та ще 1 · у теці «C:\\Activators» · формат «exe» · змінено 1–15 лист. 2026 р. · з попередніми версіями");
  const hit = (index: number) => ({ fileName: `KMSAuto-${index}.exe`, citation: `/devices/${deviceIds[0]}?file=f${index}&revision=1` });
  const response = { documents: [hit(1), hit(2), hit(3)], nextCursor: "WyIwMWExYTc4OS1hMDI5LTcxOTAtYjdhMS1hMzFkM2Y3M2Q5N2EiLDFd" };
  const finished = tracker.finish(fileRoute, first, response, JSON.stringify({ documents: [hit(1), hit(2)], nextCursor: response.nextCursor }));
  assert.match(finished, /^Шукаю файли пристроїв · пошук «KMS» · знайдено файлів: 2 · отримано: 3; для перегляду: 2 · є наступна добірка · у назвах · пристрої «Ноутбук-1»/);
  const second = tracker.start(fileRoute, { ...body, cursor: response.nextCursor });
  assert.match(second.label, / · добірка 2$/);
  const last = tracker.finish(fileRoute, second, { documents: [hit(4)], nextCursor: null }, JSON.stringify({ documents: [hit(4)], nextCursor: null }));
  assert.match(last, /^Шукаю файли пристроїв · пошук «KMS» · добірка 2 · знайдено файлів: 1 · зібрано файлів для запиту: 3 · у назвах/);
  const unknown = tracker.start(fileRoute, { query: "crack", cursor: "WyJ1bmtub3duIiwxXQ" });
  assert.equal(unknown.label, "Шукаю файли пристроїв · пошук «crack» · наступна добірка");
  assert.equal(tracker.finish(fileRoute, unknown, { documents: [], nextCursor: null }, JSON.stringify({ documents: [], nextCursor: null })), "Шукаю файли пристроїв · пошук «crack» · наступна добірка · файлів не знайдено · зібрано файлів для запиту: 3");
  const anonymous = createRouteActivityTracker().start(fileRoute, { deviceIds, includeArchived: true });
  assert.equal(anonymous.label, "Шукаю файли пристроїв · пристроїв: 3 · з архівними пристроями");

  tracker.rememberGroups([{ master_key: "private-group-key", name: "Радіомережа А" }]);
  const attachments = tracker.start(attachmentRoute, { query: "activator", selectedGroups: ["private-group-key"], from: Date.UTC(2026, 10, 1) - 2 * 3_600_000, limit: 50 });
  assert.equal(attachments.label, "Шукаю документи · пошук «activator» · від 1 лист. 2026 р. · джерела «Радіомережа А»");
  assert.equal(tracker.finish(attachmentRoute, attachments, { documents: [] }, JSON.stringify({ documents: [] })), "Шукаю документи · пошук «activator» · документів не знайдено · від 1 лист. 2026 р. · джерела «Радіомережа А»");

  for (const label of [first.label, finished, second.label, last, unknown.label, attachments.label]) {
    assert.doesNotMatch(label, /[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.doesNotMatch(label, /WyI|\/devices\/|https?:/);
  }
});

test("reports validated query scope and actual delivered message counts", () => {
  const tracker = createRouteActivityTracker();
  const route = validateSkill({
    method: "POST",
    path: "/api/rer-importer/get-inbox",
    skill: "inbox_messages",
    label: "Шукаю перехоплення",
    requestKind: "inboxMessages",
  });
  const context = validatePayload(normalPayload, false).timeContext!;
  const body = inboxMessagesRequestBody(
    {
      period: { kind: "relative_days", days: 7 },
      selectedGroups: ["private-group-key"],
      search: "техніка",
    },
    context,
  );
  const first = tracker.start(route, body);
  assert.match(first.label, /груп джерел: 1/);
  assert.match(first.label, /пошук «техніка»/);
  assert.match(first.label, /добірка 1/);
  assert.match(first.label, /29 лип.*4 серп/);
  const response = {
    signal_groups: [{ master_key: "private-group-key", name: "Радіомережа А" }],
    inbox_items: [
      [100, { text: "Not forwarded" }],
      [101, { text: "Not forwarded" }],
    ],
  };
  const result = tracker.finish(
    route,
    first,
    response,
    JSON.stringify({
      messages: [{ id: 100 }],
      nextCursor: 100,
    }),
  );
  assert.match(
    result,
    /Переглядаю повідомлення з добірки: 1 · зібрано для запиту: 1/,
  );
  assert.match(result, /джерела «Радіомережа А»/);
  assert.match(result, /отримано: 2; для перегляду: 1/);
  const withheld = tracker.finish(route, first, response, "{}");
  assert.equal(withheld.includes("немає повідомлень"), false);
  assert.match(withheld, /отримано: 2; для перегляду: 0/);
  const second = tracker.start(route, { ...body, before_id_noninclusive: 100 });
  assert.match(second.label, /добірка 2/);
  const secondResult = tracker.finish(
    route,
    second,
    response,
    JSON.stringify({
      messages: [{ id: 100 }, { id: 99 }],
      nextCursor: null,
    }),
  );
  assert.match(
    secondResult,
    /Переглядаю повідомлення з добірки: 2 · зібрано для запиту: 2/,
  );
  const otherScope = tracker.start(route, { ...body, search: "зв’язок" });
  const otherResult = tracker.finish(
    route,
    otherScope,
    { inbox_items: [[98, {}]] },
    JSON.stringify({ messages: [{ id: 98 }] }),
  );
  assert.match(
    otherResult,
    /Переглядаю повідомлення з добірки: 1 · зібрано для запиту: 3/,
  );
  assert.match(otherResult, /пошук «зв’язок»/);
  const empty = tracker.start(route, { ...body, before_id_noninclusive: 99 });
  const emptyResult = tracker.finish(
    route,
    empty,
    {},
    JSON.stringify({ messages: [], nextCursor: null }),
  );
  assert.match(
    emptyResult,
    /У цій добірці немає повідомлень · зібрано для запиту: 3/,
  );
  for (const label of [
    first.label,
    result,
    second.label,
    secondResult,
    emptyResult,
  ]) {
    assert.equal(label.includes("private-group-key"), false);
    assert.equal(label.includes("100"), false);
    assert.equal(label.includes("Not forwarded"), false);
  }
  const privateSearch = tracker.start(route, {
    ...body,
    search:
      "техніка https://private.invalid 019fc7f7-9770-7f83-9c1a-211af29b02e6 aaaa-bbbb-cccc",
  });
  assert.equal(privateSearch.label.includes("private.invalid"), false);
  assert.equal(privateSearch.label.includes("019fc7f7"), false);
  assert.equal(privateSearch.label.includes("aaaa-bbbb-cccc"), false);
  const multipleCallsigns = tracker.start(route, {
    ...body,
    selected_callsigns: ["Сивий", "Білий", "Третій"],
  });
  assert.match(multipleCallsigns.label, /позивні «Сивий», «Білий» та ще 1/);
  const groupRoute = validateSkill({
    method: "POST",
    path: "/api/user/sigint-groups-detailed",
    skill: "accessible_group_details",
    label: "Перевіряю доступні джерела",
    requestKind: "json",
  });
  const groupResponse = [
    { master_key: "group.a", name: "Радіомережа А" },
    { master_key: "group.b", name: "Радіомережа Б" },
  ];
  const groupResult = tracker.finish(
    groupRoute,
    tracker.start(groupRoute, undefined),
    groupResponse,
    compactToolResponse(groupRoute, groupResponse, 1),
  );
  assert.equal(groupResult, "Отримано груп джерел для перегляду: 2");
});

// Regression: https://github.com/echoua/echo/issues/3064
test("keeps enriched tool labels through later updates and failure", () => {
  const events: Record<string, unknown>[] = [];
  let consume: (event: any) => void = () => {};
  subscribeToEvents(
    {
      subscribe: (listener: typeof consume) => {
        consume = listener;
        return () => {};
      },
    },
    new Map([["echo_inbox_messages", "Шукаю перехоплення"]]),
    () => {},
    () => {},
    () => true,
    (event) => events.push(event),
  );
  const call = { toolName: "echo_inbox_messages", toolCallId: "page-2" };
  const label = "Шукаю перехоплення за тиждень · добірка 2";
  consume({
    ...call,
    type: "tool_execution_update",
    partialResult: { details: { activityLabel: label } },
  });
  consume({ ...call, type: "tool_execution_update" });
  consume({ type: "turn_start" });
  consume({
    ...call,
    type: "tool_execution_end",
    isError: true,
    result: { details: {} },
  });
  const publicEvents = events.filter((event) => event.type !== "tool_diagnostic");
  assert.equal(publicEvents.length, 3);
  assert.deepEqual(
    publicEvents.map((event) => event.toolLabel),
    [label, label, label],
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

test("#3064 map tool errors get specific labels while route errors stay generic", () => {
  const result = (text: string) => ({ content: [{ type: "text", text }] });
  assert.equal(toolErrorReason(result("Echo response is too large")), "response_too_large");
  assert.equal(toolErrorReason(result("The operation was aborted due to timeout")), "timeout");
  assert.equal(toolErrorReason(result("Echo redirects are not allowed")), "echo_redirect");
  assert.equal(toolErrorReason(result("Unexpected end of JSON input")), "invalid_response");
  assert.equal(toolErrorReason(result("terminated")), "network_error");
  assert.equal(toolErrorReason(result("anything")), "tool_error");
  assert.equal(toolErrorSummary("echo_inbox_messages", result("anything")), "Не вдалося завантажити дані за вказаними параметрами.");
  assert.equal(toolErrorSummary("echo_map_edit", result('Невідома операція «retype». Допустимі op: add, setSidc. Приклад: {"sidc":"10031000001211000000"}')), "Некоректні параметри зміни мапи");
  assert.equal(toolErrorSummary("echo_map_edit", result("Echo returned HTTP 409: Мапа змінилася.")), "Мапа змінилася; потрібно перечитати її");
  assert.equal(toolErrorSummary("echo_map_script", result("Script failed (exit 1). Traceback ...")), "Скрипт обробки завершився помилкою");
  assert.equal(toolErrorSummary("echo_map_set_symbol", result("SIDC має містити рівно 20 цифр")), "Некоректна позначка");
  assert.equal(toolErrorSummary("echo_map_edit", result("secret payload")), "Не вдалося змінити мапу");
});

test("#4038 script failures report their exception and only script tools report text", () => {
  const result = (text: string) => ({ content: [{ type: "text", text }] });
  const traceback = "Script failed (exit 1). Fix it and retry.\nTraceback (most recent call last):\n  File \"script.py\", line 14, in <module>\nKeyError: 'latitude'\n";
  assert.deepEqual(scriptFailure("echo_map_script", result(traceback)), { detail: "KeyError: 'latitude'", exception: "KeyError" });
  assert.deepEqual(scriptFailure("echo_document_script", result(traceback)), { detail: "KeyError: 'latitude'", exception: "KeyError" });
  assert.deepEqual(scriptFailure("echo_map_from_reports", result("Не вдалося застосувати рецепт. ValueError: bad")), { detail: "Не вдалося застосувати рецепт. ValueError: bad", exception: "ValueError" });
  assert.deepEqual(scriptFailure("echo_map_script", result("Script failed (exit null). Fix it and retry.\n")), { detail: "Script failed (exit null). Fix it and retry." });
  assert.equal((scriptFailure("echo_map_script", result(`ValueError: ${"x".repeat(2_000)}`)).detail as string).length, 1_000);
  assert.deepEqual(scriptFailure("echo_map_append", result("ValueError: secret payload")), {});
  assert.deepEqual(scriptFailure("echo_inbox_messages", result("secret")), {});
  assert.deepEqual(scriptFailure("echo_map_script", result("")), {});
});

test("#4038 an undelivered map adds one notice", () => {
  const registry = new MapRegistry();
  assert.deepEqual(mapOutcomeNotices(registry, false).notices, []);
  const { notices } = mapOutcomeNotices(registry, false, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Мапу не створено/);
});

test("#3064 failed map edits and count mismatches are stated in the answer", () => {
  const registry = new MapRegistry();
  assert.deepEqual(mapOutcomeNotices(registry, true), { failedEdit: null, notices: [] });
  observeMapOutcome(registry, () => {})({
    type: "tool_execution_end",
    toolName: "echo_map_set_symbol",
    isError: true,
    result: { content: [{ type: "text", text: "Validation failed: target is required" }] },
  });
  assert.equal(registry.outcome.editFailures, 1);
  const observe = observeMapOutcome(registry, () => {});
  const draft = registry.create("Чернетка", true);
  observe({ type: "tool_execution_start", toolCallId: "draft", toolName: "echo_map_script", args: { id: draft.id, code: "" } });
  observe({ type: "tool_execution_end", toolCallId: "draft", toolName: "echo_map_script", isError: true, result: { content: [] } });
  assert.equal(registry.outcome.editFailures, 1);
  observe({ type: "tool_execution_start", toolCallId: "open", toolName: "echo_map_script", args: { id: "22222222-2222-4222-8222-222222222222", code: "" } });
  observe({ type: "tool_execution_end", toolCallId: "open", toolName: "echo_map_script", isError: true, result: { content: [] } });
  assert.equal(registry.outcome.editFailures, 2);
  registry.outcome.editFailures = 3;
  registry.outcome.lastEditError = "Невідома операція «retype»";
  const failed = mapOutcomeNotices(registry, true);
  assert.equal(failed.failedEdit, "Невідома операція «retype»");
  assert.deepEqual(failed.notices, ["⚠️ Зміни до мапи не збережено."]);
  assert.match(mapOutcomeRepairPrompt(failed.failedEdit!), /не стверджуй, що мапу змінено/);
  assert.equal(mapOutcomeNotices(registry, false).failedEdit, null);
  registry.outcome.editSuccesses = 1;
  assert.equal(mapOutcomeNotices(registry, true).failedEdit, null);
});


test('#3064 attachment evidence survives compaction with revision and continuation', async () => {
  const { prepareMessageCitations, deliveredCitations } = await import('./citations.ts');
  const mediaId = '01999999-1111-7111-8111-111111111111';
  const revision = '01999999-2222-7222-8222-222222222222';
  const body = {
    document: { mediaId, revision, messageId: 42, messageUuid: mediaId, fileName: 'orders.zip', summary: 'Summary' },
    sections: [0, 1, 2].map((ordinal) => ({ id: `${ordinal}`, ordinal, member: 'orders.zip!/sheet.xlsx', locator: `row ${ordinal}`, text: 'x'.repeat(2000), markdown: `Evidence ${ordinal} ` + 'x'.repeat(2000), html: '<p>redundant</p>' })),
    nextAfter: null,
  };
  const prepared = prepareMessageCitations('attachment_read', body);
  const text = compactToolResponse({ skill: 'attachment_read', requestKind: 'attachmentRead' }, prepared.body, 64, 3200);
  const result = JSON.parse(text);
  assert.equal(result.document.revision, revision);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].markdown, body.sections[0].markdown);
  assert.equal(result.nextAfter, 0);
  assert.equal(deliveredCitations(text, prepared.citations).length, 1);
  const inspected = prepareMessageCitations('attachment_inspection_status', { result: body });
  assert.equal(inspected.citations.length, 1);
  assert.match(inspected.messages[0].text, /Evidence|row 0/);
});

test('#3064 attachment tools reject arbitrary routes and malformed selectors', async () => {
  const { attachmentRequest } = await import('./attachments.ts');
  assert.throws(() => attachmentRequest('attachmentRead', { mediaId: '../secrets' }));
  assert.throws(() => attachmentRequest('attachmentSearch', { query: 'positions', limit: 10000 }));
  assert.throws(() => attachmentRequest('attachmentSearch', { url: 'http://localhost' }));
  assert.throws(() => validateSkill({ method: 'POST', path: '/api/admin/attachments/settings', skill: 'attachment_search', label: 'Search', requestKind: 'attachmentSearch' }));
  assert.deepEqual(attachmentRequest('attachmentSearch', { query: 'позиції', limit: 5 }), { query: 'позиції', limit: 5 });
});

// Regression: https://github.com/echoua/echo/issues/4224
test("#4224 attachment search hits drop the duplicate summary and keep delivered citations", async () => {
  const { prepareMessageCitations, deliveredCitations } = await import("./citations.ts");
  const body = {
    documents: Array.from({ length: 30 }, (_, index) => ({
      mediaId: `01999999-4444-7444-8444-${String(index).padStart(12, "0")}`,
      messageId: index + 1,
      messageUuid: `01999999-5555-7555-8555-${String(index).padStart(12, "0")}`,
      fileName: `report-${index}.pdf`,
      contentType: "application/pdf",
      state: "completed",
      quality: null,
      complete: true,
      revision: null,
      summary: "Звіт про активатори. ".repeat(80),
      summaryState: "completed",
      positionState: "completed",
      chunkCount: 12,
      lastError: null,
      snippet: "page 2: " + "activator ".repeat(70),
      citation: "",
    })),
    nextCursor: null,
  };
  const prepared = prepareMessageCitations("attachment_search", body);
  const original = JSON.stringify(prepared.body).length;
  const text = compactToolResponse({ skill: "attachment_search", requestKind: "attachmentSearch" }, prepared.body, 64, 96_000);
  assert.ok(text.length * 2 <= original, `${text.length} vs ${original}`);
  const [hit] = JSON.parse(text).documents;
  for (const omitted of ["summary", "messageUuid", "contentType", "chunkCount", "positionState", "state", "complete", "summaryState"])
    assert.ok(!(omitted in hit), omitted);
  assert.ok(hit.text.startsWith("Звіт про активатори."));
  assert.equal(deliveredCitations(text, prepared.citations).length, 30);
  const trimmed = JSON.parse(compactToolResponse({ skill: "attachment_search", requestKind: "attachmentSearch" }, prepared.body, 64, 3_000));
  assert.ok(trimmed.documents.length < 30);
  assert.equal(trimmed.nextCursor, trimmed.documents.at(-1).mediaId);
  assert.match(trimmed.warnings[0], /follow nextCursor/);
});

test("#3913 retains allowlisted provider failures after HTTP 200 SSE", async () => {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const engine = {
    id: "fixture",
    name: "fixture",
    api: "openai-responses" as const,
    provider: "fixture",
    baseUrl: "https://fixture.invalid/v1",
    reasoning: true,
    input: ["text" as const],
    contextWindow: 65536,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const terminal of ["response.failed", "error", "truncated"]) {
    const event =
      terminal === "response.failed"
        ? {
            type: terminal,
            response: {
              status: "failed",
              error: {
                code: "rate_limit_exceeded",
                message: "No deployments available; token=secret-value",
              },
            },
          }
        : {
            type: terminal,
            code: "server_error",
            message: "upstream unavailable; Bearer secret-value",
          };
    const response = await completeSimple(
      engine,
      {
        messages: [
          { role: "user", content: "private prompt", timestamp: Date.now() },
        ],
      },
      {
        apiKey: "fixture",
        fetch: async () =>
          new Response(
            terminal === "truncated"
              ? ""
              : `event: ${terminal}\ndata: ${JSON.stringify(event)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    );
    assert.equal(response.stopReason, "error");
    assert.throws(
      () => validateFinalAssistantMessage([response]),
      (error: Error) => {
        assert.match(error.message, /provider request failed:/);
        assert.match(
          error.message,
          terminal === "truncated"
            ? /terminal response event/
            : /rate_limit_exceeded|server_error/,
        );
        assert.doesNotMatch(error.message, /secret-value|private prompt/);
        return true;
      },
    );
  }
});

test("#3913 persists only allowlisted diagnostics even for unlabelled provider payload excerpts", () => {
  for (const secret of [
    "Bearer confidential",
    "messages[0].content=confidential",
    "Unlabelled confidential excerpt from user input",
    "api_key=confidential",
    "cookie=confidential",
    "sk-confidential",
    "B".repeat(43),
    'prompt="confidential"',
  ]) {
    assert.throws(
      () =>
        validateFinalAssistantMessage([
          {
            role: "assistant",
            stopReason: "error",
            content: [],
            errorMessage: `server_error: ${secret}\nprivate response body`,
          },
        ]),
      (error: Error) => {
        assert.doesNotMatch(
          error.message,
          /confidential|private response body|B{43}/,
        );
        return true;
      },
    );
  }
  assert.throws(
    () =>
      validateFinalAssistantMessage([
        {
          role: "assistant",
          stopReason: "error",
          content: [],
          errorMessage: "x".repeat(10000),
        },
      ]),
    (error: Error) => error.message.length < 1100,
  );
});

test("#4125 period repair drops only keys that cannot move the window", () => {
  const original = { kind: "relative_days", days: 3, timezone: "Europe/Kyiv", sinceDate: null, label: "доба", SENSITIVE: 1 };
  const snapshot = structuredClone(original);
  // Only keys known to describe a period are dropped; an unknown one may anchor it.
  assert.deepEqual(normalizePeriodArgument(original), {
    period: { kind: "relative_days", days: 3, SENSITIVE: 1 },
    ignored: ["sinceDate", "timezone", "label"],
  });
  // Explicit dates fix a range, so a stray duration beside them is dropped...
  assert.deepEqual(
    normalizePeriodArgument({ kind: "date_range", sinceDate: "2026-11-01", tillDateInclusive: "2026-11-07", days: 2 }),
    { period: { kind: "date_range", sinceDate: "2026-11-01", tillDateInclusive: "2026-11-07" }, ignored: ["days"] },
  );
  // ...but a bound beside a relative period, or a second bound, would move the window.
  for (const period of [
    { kind: "relative_days", days: 7, sinceDate: "2026-10-01" },
    { kind: "relative_days", days: 7, hours: 5 },
    { kind: "sinceDate", sinceDate: "2026-11-01", days: 2 },
    { kind: "date_range", sinceDate: "2026-07-01", tillDateInclusive: "2026-07-07", timezone: "EET" },
    { kind: "date_range", sinceDate: "2026-11-01", tillDateInclusive: "2026-11-07", timezone: "EEST" },
    { kind: "date_range", sinceDate: "2026-11-01", tillDateInclusive: "2026-11-07", start: "2026-10-01" },
  ]) {
    assert.deepEqual(normalizePeriodArgument(period), { period, ignored: [] }, JSON.stringify(period));
  }
  const mixed = { days: 7, tillDateInclusive: "2026-10-01" };
  assert.equal(normalizePeriodArgument(mixed).period, mixed);
  assert.deepEqual(original, snapshot);
  for (const [input, kind] of [
    [{ hours: 24 }, "relative_hours"],
    [{ days: 7 }, "relative_days"],
    [{ sinceDate: "2026-11-01", tillDateInclusive: "2026-11-07" }, "date_range"],
  ] as const) {
    assert.equal((normalizePeriodArgument(input).period as any).kind, kind);
  }
  // A midnight keeps its date only when its offset is Kyiv's on that day.
  for (const [sinceDate, kept] of [
    ["2026-11-07T00:00:00+02:00", "2026-11-07"],
    ["2026-07-01T00:00+03:00", "2026-07-01"],
    ["2026-11-07T00:00:00Z", "2026-11-07"],
    ["2026-11-07T00:00:00+03:00", "2026-11-07T00:00:00+03:00"],
    ["2026-07-01T00:00:00+02:00", "2026-07-01T00:00:00+02:00"],
  ]) {
    assert.equal((normalizePeriodArgument({ kind: "date_range", sinceDate, tillDateInclusive: "2026-11-08" }).period as any).sinceDate, kept, sinceDate);
  }
  const startEnd = { start: "2026-11-01", end: "2026-11-02" };
  assert.equal(normalizePeriodArgument(startEnd).period, startEnd);
  // A bound or another time zone would change what is read, so they stay for a precise rejection.
  for (const key of ["until", "endDate", "fromTime", "includeToday", "asOf"]) {
    const period = { kind: "relative_days", days: 3, [key]: "x" };
    assert.deepEqual(normalizePeriodArgument(period), { period: { kind: "relative_days", days: 3, [key]: "x" }, ignored: [] });
  }
  assert.deepEqual((normalizePeriodArgument({ kind: "relative_days", days: 3, timezone: "UTC" }).period as any).timezone, "UTC");
  const weeks = { kind: "weeks", days: 3, label: "x" };
  assert.equal(normalizePeriodArgument(weeks).period, weeks);
});

test("#4125 a rejected period names the field, the allowed fields and an example", () => {
  const context = validatePayload(normalPayload, false).timeContext!;
  const parameterNames = new Map([["echo_inbox_messages", new Set(["period"])]]);
  const reject = (period: unknown) => {
    try {
      inboxMessagesRequestBody({ period }, context);
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail("accepted");
  };
  const fieldsOf = (message: string) =>
    validationFields({ content: [{ type: "text", text: `Invalid Echo tool arguments: ${message}` }] }, "echo_inbox_messages", parameterNames);
  const until = reject({ kind: "relative_days", days: 3, until: "2026-11-08" });
  assert.match(until, /unsupported field "until" for kind relative_days; allowed fields: kind, days\. Example: /);
  assert.deepEqual(JSON.parse(until.split("Example: ")[1]), { kind: "relative_days", days: 7 });
  assert.equal(fieldsOf(until), "period.until:additional");
  assert.equal(fieldsOf(reject({ kind: "relative_days", days: 3, timezone: "UTC" })), "period.timezone:additional");
  assert.equal(fieldsOf(reject({ kind: "relative_days", days: 3, SENSITIVE_until: 1 })), "period:additional");
  const weeks = reject({ kind: "weeks" });
  assert.match(weeks, /use kind relative_hours, relative_days or date_range/);
  assert.equal(fieldsOf(weeks), "period:invalid");
});

test("#4125 route arguments repair the period and report what they dropped", () => {
  const inbox = validateSkill({ method: "POST", path: "/api/rer-importer/get-inbox", skill: "inbox_messages", label: "Inbox", requestKind: "inboxMessages" });
  const reports: string[] = [];
  const args = { period: { kind: "relative_days", days: 2, timezone: "Europe/Kyiv", description: "x" }, search: "Сокіл" };
  assert.deepEqual(prepareRouteArguments(inbox, args, (fields) => reports.push(fields)), {
    period: { kind: "relative_days", days: 2 },
    search: "Сокіл",
  });
  assert.deepEqual(reports, ["period.timezone:ignored, period.description:ignored"]);
  assert.deepEqual(prepareRouteArguments(inbox, { period: { kind: "relative_days", days: 2 } }, () => assert.fail("reported")), {
    period: { kind: "relative_days", days: 2 },
  });
});

const MESSAGE_UUIDS_SCHEMA = {
  type: "object",
  description: "Read accessible intercepted messages by their UUIDs.",
  properties: { message_uuids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1, maxItems: 100 } },
  required: ["message_uuids"],
  additionalProperties: false,
};

test("#4125 passthrough routes take Echo's schema and only json routes may carry one", () => {
  const route = { method: "POST", path: "/api/rer-importer/messages-by-uuid", skill: "messages_by_uuid", label: "Read selected", requestKind: "json" };
  assert.deepEqual(validateSkill({ ...route, requestSchema: MESSAGE_UUIDS_SCHEMA }).requestSchema, MESSAGE_UUIDS_SCHEMA);
  assert.equal(validateSkill(route).requestSchema, undefined);
  for (const invalid of [
    { ...route, requestKind: "messageIds", path: "/api/rer-importer/messages-by-id", skill: "messages_by_id", requestSchema: MESSAGE_UUIDS_SCHEMA },
    { ...route, requestSchema: { type: "string" } },
    { ...route, requestSchema: { type: "object", properties: [] } },
    { ...route, requestSchema: { ...MESSAGE_UUIDS_SCHEMA, description: "x".repeat(40_000) } },
  ]) {
    assert.throws(() => validateSkill(invalid), /requestSchema is invalid/);
  }
});

test("#4125 schema arguments lift the shapes models send without guessing", () => {
  const uuid = "01a1ba32-c862-7bcc-b685-d71d1d326f77";
  for (const args of [
    { message_uuids: [uuid] },
    { body: { message_uuids: [uuid] } },
    { body: JSON.stringify({ messageUuids: [uuid] }) },
    { messageUuids: uuid.toUpperCase() },
    { message_uuids: [`[джерело](/rer-analysis-neo?m=${uuid})`] },
    { message_uuids: [`{${uuid}}`] },
    { message_uuids: [`urn:uuid:${uuid}`] },
  ]) {
    assert.deepEqual(schemaArguments(MESSAGE_UUIDS_SCHEMA, args), { message_uuids: [uuid] }, JSON.stringify(args));
  }
  // Not a UUID: left for validation, which names the field and the format.
  assert.deepEqual(schemaArguments(MESSAGE_UUIDS_SCHEMA, { message_uuids: ["legacy / uid", 42] }), { message_uuids: ["legacy / uid", 42] });
  assert.equal(uuidArgument("legacy / uid"), "legacy / uid");
  // A second spelling of the same field is kept as sent, so validation rejects it.
  assert.deepEqual(
    schemaArguments(MESSAGE_UUIDS_SCHEMA, { message_uuids: [uuid], messageUuids: ["other"] }),
    { message_uuids: [uuid], messageUuids: ["other"] },
  );
  assert.deepEqual(
    schemaArguments(MESSAGE_UUIDS_SCHEMA, { messageUuids: [uuid], messageUUIDs: ["other"] }),
    { message_uuids: [uuid], messageUUIDs: ["other"] },
  );
  const comments = {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "object", properties: { message_id: { type: "integer" } }, required: ["message_id"], additionalProperties: false },
      },
    },
    required: ["messages"],
    additionalProperties: false,
  };
  assert.deepEqual(schemaArguments(comments, { body: { messages: [42, { messageId: 43 }] } }), {
    messages: [{ message_id: 42 }, { message_id: 43 }],
  });
});
