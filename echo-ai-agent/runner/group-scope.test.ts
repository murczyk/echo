import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, validatePayload } from "./runner.ts";
import {
  compactGroupCatalog,
  createGroupScope,
  groupCatalog,
  GROUP_LOOKUP_BODY,
  GROUP_LOOKUP_SKILL,
  resolveGroups,
} from "./group-scope.ts";

const GROUPS = [
  { master_key: "group.devops", name: "DEVOPS" },
  { master_key: "group.cobalt", name: "Кобальт" },
  { master_key: "group.twin-1", name: "Двійник" },
  { master_key: "group.twin-2", name: "Двійник" },
  { master_key: "group.case-1", name: "Альфа" },
  { master_key: "group.case-2", name: "АЛЬФА" },
];

const rejected = (values: string[], pattern: RegExp) =>
  assert.throws(() => resolveGroups(values, GROUPS), pattern);

test("#4053 group names and keys resolve to Echo keys", () => {
  assert.deepEqual(resolveGroups(["DEVOPS"], GROUPS), ["group.devops"]);
  assert.deepEqual(resolveGroups(["group.cobalt"], GROUPS), ["group.cobalt"]);
  assert.deepEqual(resolveGroups(["  devops "], GROUPS), ["group.devops"]);
  assert.deepEqual(resolveGroups(["кобальт"], GROUPS), ["group.cobalt"]);
});

test("#4053 a name shared by several groups selects all of them, like the UI", () => {
  assert.deepEqual(resolveGroups(["Двійник"], GROUPS), [
    "group.twin-1",
    "group.twin-2",
  ]);
  assert.deepEqual(resolveGroups(["двійник", "group.twin-1"], GROUPS), [
    "group.twin-1",
    "group.twin-2",
  ]);
});

test("#4053 exact case wins over a name differing only in case", () => {
  assert.deepEqual(resolveGroups(["Альфа"], GROUPS), ["group.case-1"]);
  rejected(["альфа"], /ambiguous between \["АЛЬФА","Альфа"\]|ambiguous between \["Альфа","АЛЬФА"\]/);
});

test("#4053 an unknown name is rejected instead of guessed", () => {
  rejected(["DEVOP"], /Invalid Echo tool arguments: Group "DEVOP" is not among/);
  rejected(["DEVOPS-2"], /Accessible groups include \["DEVOPS"/);
  rejected(["Горобець"], /Never drop the group filter/);
});

test("#4053 one unknown name rejects the whole call and names only that value", () => {
  assert.throws(
    () => resolveGroups(["DEVOPS", "Горобець"], GROUPS),
    (error: Error) =>
      error.message.includes('Group "Горобець"') &&
      !error.message.includes('Group "DEVOPS"'),
  );
});

test("#4053 candidate lists stay short and put close names first", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    master_key: `group.${index}`,
    name: `Група ${String(index).padStart(2, "0")}`,
  }));
  many.push({ master_key: "group.zz", name: "Яблуко DEVOPS" });
  const error = (() => {
    try {
      resolveGroups(["DEVOPS"], many);
    } catch (caught) {
      return (caught as Error).message;
    }
    throw new Error("expected a rejection");
  })();
  const listed = JSON.parse(error.match(/include (\[.*?\])\./)![1]);
  assert.equal(listed.length, 12);
  assert.equal(listed[0], "Яблуко DEVOPS");
});

test("#4053 the catalog dedupes rows and ignores entries without a key or name", () => {
  const catalog = groupCatalog([
    { master_key: "b", name: "Б", kind: "signal", group_stats: {} },
    { master_key: "b", name: "Б", kind: "whatsapp", group_stats: {} },
    { master_key: "a", name: "А" },
    { name: "без ключа" },
    { master_key: "c" },
    null,
  ]);
  assert.deepEqual(catalog, [
    { master_key: "a", name: "А" },
    { master_key: "b", name: "Б" },
  ]);
  assert.throws(() => groupCatalog({ error: "x" }), /unavailable/);
});

test("#4053 the model sees every group, not the first 64 rows", () => {
  const value = Array.from({ length: 200 }, (_, index) => ({
    master_key: `group.${index}`,
    name: `Група ${index}`,
    group_stats: { activity_last_day: 1 },
  }));
  const compacted = JSON.parse(compactGroupCatalog(value, 96_000));
  assert.equal(compacted.length, 200);
  assert.deepEqual(Object.keys(compacted[0]), ["master_key", "name"]);
});

test("#4053 a character limit marks the group list as truncated", () => {
  const value = Array.from({ length: 200 }, (_, index) => ({
    master_key: `group.${index}`,
    name: `Група ${index}`,
  }));
  const compacted = compactGroupCatalog(value, 600);
  assert.ok(compacted.length <= 600);
  const parsed = JSON.parse(compacted);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.items.length > 0);
  assert.equal(compactGroupCatalog(value, 2), "{}");
  assert.equal(compactGroupCatalog(value, 1), "");
});

test("#4053 one lookup serves the whole request and no selection needs none", async () => {
  let lookups = 0;
  let remembered = 0;
  const scope = createGroupScope(
    async () => {
      lookups++;
      return GROUPS;
    },
    () => remembered++,
  );
  assert.deepEqual(await scope.resolve({ search: "x" }, true), { search: "x" });
  assert.deepEqual(await scope.resolve({ selectedGroups: [] }, true), {
    selectedGroups: [],
  });
  assert.equal(lookups, 0);
  for (let call = 0; call < 3; call++)
    assert.deepEqual(await scope.resolve({ selectedGroups: ["DEVOPS"], cursor: 1 }, true), {
      selectedGroups: ["group.devops"],
      cursor: 1,
    });
  assert.equal(lookups, 1);
  assert.equal(remembered, 3);
});

test("#4053 a failed lookup rejects the call, keeps nothing and can recover", async () => {
  let lookups = 0;
  const scope = createGroupScope(async () => {
    if (++lookups === 1) throw new Error("Echo request failed");
    return GROUPS;
  }, () => {});
  await assert.rejects(
    scope.resolve({ selectedGroups: ["DEVOPS"] }, true),
    /Echo request failed/,
  );
  assert.deepEqual(await scope.resolve({ selectedGroups: ["DEVOPS"] }, true), {
    selectedGroups: ["group.devops"],
  });
});

test("#4053 without the lookup route, older evaluation suites pass values through", async () => {
  const scope = createGroupScope(null, () => {});
  assert.deepEqual(await scope.resolve({ selectedGroups: ["visible"] }, true), {
    selectedGroups: ["visible"],
  });
});

test("#4053 a selected scope cannot be dropped by omitting it", async () => {
  const scope = createGroupScope(async () => GROUPS, () => {});
  const dropped = /already selected a group/;
  assert.deepEqual(await scope.resolve({ search: "x" }, true), { search: "x" });
  await scope.resolve({ selectedGroups: ["DEVOPS"] }, true);
  await assert.rejects(scope.resolve({ search: "x" }, true), dropped);
  await assert.rejects(scope.resolve({ selectedGroups: [] }, true), dropped);
  assert.deepEqual(await scope.resolve({ selectedGroups: ["Кобальт"] }, true), {
    selectedGroups: ["group.cobalt"],
  });
  assert.deepEqual(await scope.resolve({ messageIds: [7] }, true), { messageIds: [7] });
  assert.deepEqual(await scope.resolve({ message_uid: "x" }, false), { message_uid: "x" });
});

test("#4053 a rejected group also keeps the request scoped and is reported", async () => {
  const unresolved: string[][] = [];
  const scope = createGroupScope(async () => GROUPS, () => {}, (values) => unresolved.push(values));
  await assert.rejects(scope.resolve({ selectedGroups: ["DEVOPS", "Горобець"] }, true), /Горобець/);
  await assert.rejects(scope.resolve({ search: "x" }, true), /already selected a group/);
  assert.deepEqual(await scope.resolve({ selectedGroups: ["DEVOPS"] }, true), {
    selectedGroups: ["group.devops"],
  });
  assert.deepEqual(unresolved, [["Горобець"], []]);
});

test("#4053 malformed values are left for request validation", async () => {
  const scope = createGroupScope(async () => GROUPS, () => {});
  assert.deepEqual(await scope.resolve({ selectedGroups: [1] }, true), {
    selectedGroups: [1],
  });
});

function modelTurn(toolCall?: { name: string; args: unknown }): Response {
  const chunk = (delta: unknown, finish: string | null) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
  const delta = toolCall
    ? {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.args),
            },
          },
        ],
      }
    : { role: "assistant", content: "Готово." };
  return new Response(
    `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, toolCall ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function runWithGroupArgument(t: any, selectedGroups: string[]) {
  const inbox: any[] = [];
  const lookups: any[] = [];
  const events: any[] = [];
  const toolResults: string[] = [];
  let modelTurns = 0;
  const oldSignals = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: string, ...args: any[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"type":')) {
      events.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  t.mock.method(globalThis, "fetch", async (url: unknown, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/ai-agent/bootstrap/exchange")
      return Response.json(
        { correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6" },
        { headers: { "set-cookie": "session=fixture; HttpOnly" } },
      );
    if (path === "/api/user/sigint-groups-detailed") {
      lookups.push(JSON.parse(init.body));
      return Response.json(GROUPS);
    }
    if (path === "/api/rer-importer/get-inbox") {
      inbox.push(JSON.parse(init.body));
      return Response.json({ inbox_items: [], signal_groups: [], page_limit: 20 });
    }
    assert.ok(path.endsWith("/chat/completions"), path);
    const body = JSON.parse(init.body);
    for (const message of body.messages)
      if (message.role === "tool") toolResults.push(String(message.content));
    return modelTurn(
      modelTurns++ === 0
        ? {
            name: "echo_inbox_messages",
            args: { period: { kind: "relative_hours", hours: 24 }, selectedGroups },
          }
        : undefined,
    );
  });
  await runAgent(
    validatePayload(
      {
        prompt: "Перехоплення в групі DEVOPS",
        modelName: "group-scope-fixture",
        providerTransport: "echo_gateway",
        providerApiKey: "fixture-capability",
        echoPublicHost: "echo.example.test",
        bootstrapToken: "A".repeat(43),
        correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
        contextWindow: 65_536,
        maxTokens: 8192,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 1024,
        timeContext: {
          timeZone: "Europe/Kyiv",
          requestStartedAtUtc: "2026-11-06T18:13:36Z",
        },
        skills: [
          {
            method: "POST",
            path: "/api/user/sigint-groups-detailed",
            skill: GROUP_LOOKUP_SKILL,
            label: "Переглядаю доступні групи",
            requestKind: "json",
          },
          {
            method: "POST",
            path: "/api/rer-importer/get-inbox",
            skill: "inbox_messages",
            label: "Шукаю перехоплення",
            requestKind: "inboxMessages",
          },
        ],
      },
      false,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    for (const listener of process.listeners(signal))
      if (!oldSignals[signal].includes(listener))
        process.removeListener(signal, listener);
  return { events, inbox, lookups, toolResults };
}

test("#4053 incident: a group name reaches Echo as its key and the label names it", async (t) => {
  const { events, inbox, lookups } = await runWithGroupArgument(t, ["DEVOPS"]);
  assert.deepEqual(inbox.map((body) => body.selected_groups), [["group.devops"]]);
  assert.deepEqual(lookups, [GROUP_LOOKUP_BODY]);
  const labels = JSON.stringify(events.filter((event) => event.type === "tool_update"));
  assert.match(labels, /джерела «DEVOPS»/);
  assert.doesNotMatch(labels, /груп джерел: 1/);
});

test("#4053 incident: an unknown group never reaches the search and the model is told why", async (t) => {
  const { inbox, toolResults } = await runWithGroupArgument(t, ["Горобець"]);
  assert.deepEqual(inbox, []);
  assert.ok(
    toolResults.some((text) => text.includes('Group "Горобець" is not among')),
    JSON.stringify(toolResults),
  );
});
