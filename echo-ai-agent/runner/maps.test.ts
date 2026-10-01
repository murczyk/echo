import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { MapRegistry, createMapTools, preserveMapReferences, publishReferencedDrafts, sanitizeEditOperations, stripUnpublishedMapLinks, validateMapEdit, validateMapSummaries, type MapRecord } from "./maps.ts";
import { citationRepairPrompt, canonicalizeAnswer } from "./citations.ts";

const source = { messageId: 77, messageIdentifier: "source-77" };
const record = (index: number): MapRecord => ({
  sidc: "10062000001209020000", name: `Подія ${index}`, observationDatetime: null,
  coordinateSystem: "msk2000", platformType: "CAPDOC", originalX: "5215227", originalY: "6548669",
  x: "5215227", y: "6548669", latitude: 47.068994, longitude: 33.639175,
  comments: [`Коментар ${index}`], sources: [], warnings: [],
});

test("#3064 batches preserve ordered coincident events until explicit immutable publication", async () => {
  const registry = new MapRegistry();
  const events: any[] = [];
  const requests: any[] = [];
  const tools = createMapTools(registry, async (path, body: any) => {
    requests.push({ path, body });
    return { records: body.records.map((input: any) => ({ ...record(0), ...input })) };
  }, (event) => events.push(event), () => {}, () => true);
  const execute = async (name: string, params: any, signal?: AbortSignal) =>
    JSON.parse((await tools.find((tool) => tool.name === name)!.execute("call", params, signal)).content[0].text as string);
  const { id } = await execute("echo_map_create", { title: "Події", isMain: true });
  await assert.rejects(() => execute("echo_map_append", { id, records: Array.from({ length: 129 }, (_, i) => record(i)) }), /limits/);
  assert.equal(requests.length, 0);
  await execute("echo_map_append", { id, records: Array.from({ length: 107 }, (_, i) => record(i + 1)) });
  assert.deepEqual(requests.map((request) => request.body.records.length), [32, 32, 32, 11]);
  assert.equal(events.length, 0);
  assert.equal((await execute("echo_map_list", {})).maps[0].published, false);
  const first = await execute("echo_map_get", { id });
  assert.equal(first.records.length, 32);
  assert.equal(first.nextOffset, 32);
  assert.equal((await execute("echo_map_get", { id, offset: 32 })).records[0].name, "Подія 33");
  const published = await execute("echo_map_publish", { id });
  await execute("echo_map_publish", { id });
  assert.equal(events.length, 1);
  assert.equal(published.reference, `[мапа](echo-map:${id})`);
  assert.equal(events[0].document.totalCount, 107);
  assert.deepEqual(events[0].document.records.map((item: MapRecord) => item.name), Array.from({ length: 107 }, (_, i) => `Подія ${i + 1}`));
  await assert.rejects(() => execute("echo_map_append", { id, records: [record(18)] }), /immutable/);
  const draft = registry.create("Чернетка", false);
  registry.discardDrafts();
  assert.equal(registry.get(draft.id), undefined);
  assert.equal(registry.get(id)?.totalCount, 107);
});

test("#3064 split preparation failures and cancellation leave a bulk append retryable without duplicate records", async () => {
  for (const cancelled of [false, true]) {
    const registry = new MapRegistry();
    const { id } = registry.create("Пакет", true);
    const controller = new AbortController();
    let calls = 0;
    let fail = true;
    const tools = createMapTools(registry, async (_path, body: any) => {
      calls += 1;
      if (calls === 2 && fail) {
        if (cancelled) controller.abort();
        else throw new Error("Preparation failed");
      }
      return { records: body.records };
    }, () => {}, () => {}, () => true);
    const append = tools.find((tool) => tool.name === "echo_map_append")!;
    const records = Array.from({ length: 33 }, (_, i) => record(i + 1));
    await assert.rejects(() => append.execute("call", { id, records }, controller.signal), cancelled ? /abort/i : /Preparation failed/);
    assert.equal(registry.get(id)?.totalCount, 0);
    fail = false;
    await append.execute("retry", { id, records });
    assert.equal(calls, 4);
    assert.deepEqual(registry.get(id)?.records.map((item) => item.name), records.map((item) => item.name));
  }
});

test("#3064 aborted preparation cannot alter canonical records", async () => {
  const registry = new MapRegistry();
  const { id } = registry.create("Скасовано", true);
  const controller = new AbortController();
  let calls = 0;
  const tools = createMapTools(registry, async () => {
    calls += 1;
    controller.abort();
    return { records: [record(1)] };
  }, () => assert.fail("Unpublished draft emitted an event"), () => {}, () => false);
  const append = tools.find((tool) => tool.name === "echo_map_append")!;
  await assert.rejects(() => append.execute("call", { id, records: [record(1)] }, controller.signal), /abort/i);
  assert.equal(calls, 1);
  assert.equal(registry.get(id)?.totalCount, 0);
  registry.discardDrafts();
  assert.deepEqual(registry.list(), []);
});

test("#3064 append accepts an empty SIDC, omits unknown citations, and publishes a linked draft", async () => {
  const registry = new MapRegistry();
  const events: any[] = [];
  const requests: any[] = [];
  const tools = createMapTools(registry, async (path, body) => {
    requests.push({ path, body });
    return { records: (body as any).records.map((input: any) => ({ ...record(0), ...input, sources: input.sources ?? [] })) };
  }, (event) => events.push(event), () => {}, (citation) => citation.messageId === source.messageId);
  const execute = async (name: string, params: any) =>
    JSON.parse((await tools.find((tool) => tool.name === name)!.execute("call", params)).content[0].text as string);
  const created = await execute("echo_map_create", { title: "Без SIDC", isMain: true });
  assert.equal(created.reference, undefined);
  const appended = await execute("echo_map_append", {
    id: created.id,
    records: [{
      sidc: "",
      name: "Точка",
      coordinateSystem: "sk42",
      x: "5215227",
      y: "6548669",
      sources: [source, { messageId: 4, messageIdentifier: "invented" }],
    }],
  });
  assert.equal(appended.reference, undefined);
  assert.equal(appended.omittedSourceCount, 1);
  assert.equal(requests[0].body.records[0].sidc, "");
  assert.deepEqual(requests[0].body.records[0].sources, [source]);
  assert.equal(events.length, 0);
  const empty = registry.create("Порожня", false);
  const answer = `[мапа](echo-map:${created.id}) [мапа](echo-map:${empty.id}) [мапа](echo-map:22222222-2222-4222-8222-222222222222)`;
  publishReferencedDrafts(answer, registry, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "map_artifact");
  assert.equal(events[0].document.records[0].sources[0].messageId, source.messageId);
  const stripped = stripUnpublishedMapLinks(answer, registry.list());
  assert.equal(stripped, `[мапа](echo-map:${created.id})  `);
  assert.equal(registry.list().find((item) => item.id === created.id)?.reference, `[мапа](echo-map:${created.id})`);
  assert.equal(registry.list().find((item) => item.id === empty.id)?.reference, undefined);
});

test("#3064 history restores summaries and retrieves bounded records with request ownership", async () => {
  assert.deepEqual(validateMapSummaries(undefined), []);
  const registry = new MapRegistry();
  const { id } = registry.create("Історія", true);
  registry.append(id, [{ ...record(1), sources: [source] }, record(2)]);
  const { document } = registry.publish(id);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const summary = { ...document, requestId };
  const restored = new MapRegistry(validateMapSummaries([summary, summary]));
  assert.equal(restored.list().length, 1);
  let observed: unknown;
  const delivered: any[] = [];
  const tools = createMapTools(restored, async (path, body) => {
    observed = { path, body };
    return document;
  }, () => {}, () => {}, () => false, (citations) => delivered.push(...citations));
  const get = tools.find((tool) => tool.name === "echo_map_get")!;
  const response = JSON.parse((await get.execute("read", { id, limit: 1 })).content[0].text as string);
  assert.deepEqual(observed, { path: "/api/ai-agent/maps/get", body: { requestId, mapId: id } });
  assert.equal(response.nextOffset, 1);
  assert.deepEqual(delivered, [source]);
  await assert.rejects(() => get.execute("read", { id: "22222222-2222-4222-8222-222222222222" }), /Unknown map/);
  assert.throws(() => validateMapSummaries([{ ...summary, validCount: 50 }]), /Invalid map summary/);
});

const editing = {
  requestId: "11111111-1111-4111-8111-111111111111",
  mapId: "22222222-2222-4222-8222-222222222222",
  revision: 3,
  selectedPointIds: ["019fa4a6-5a92-7692-a8d1-4f5e701d568c"],
};

test("#3064 an editing follow-up reads the current revision of every map", async () => {
  const otherId = "33333333-3333-4333-8333-333333333333";
  const registry = new MapRegistry([{
    id: editing.mapId, requestId: editing.requestId, title: "Активна", isMain: true,
    totalCount: 1, validCount: 1, invalidCount: 0, warnings: [],
  }, {
    id: otherId, requestId: editing.requestId, title: "Інша", isMain: false,
    totalCount: 1, validCount: 1, invalidCount: 0, warnings: [],
  }]);
  const requests: any[] = [];
  const tools = createMapTools(registry, async (path, body) => {
    requests.push({ path, body });
    return { records: [record(1)], totalCount: 1, validCount: 1, invalidCount: 0, warnings: [] };
  }, () => {}, () => {}, () => true, () => {}, editing);
  const get = tools.find((tool) => tool.name === "echo_map_get")!;
  await get.execute("active", { id: editing.mapId });
  await get.execute("other", { id: otherId });
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["mapId", "requestId"]);
  assert.equal(requests[0].body.mapId, editing.mapId);
  assert.equal(requests[1].body.mapId, otherId);
});

test("#3064 echo_map_edit is absent until an editing target is supplied", () => {
  const tools = createMapTools(new MapRegistry(), async () => ({}), () => {}, () => {}, () => true);
  assert.equal(tools.some((tool) => tool.name === "echo_map_edit"), false);
});

test("#3064 echo_map_edit saves a compact revision and keeps the cursor on failure", async () => {
  const requests: any[] = [];
  let fail = true;
  const tools = createMapTools(new MapRegistry(), async (path, body) => {
    requests.push({ path, body });
    if (path === "/api/ai-agent/maps/get") return { records: [] };
    if (fail) throw new Error("Echo returned HTTP 409: Мапа змінилася. Оновіть перегляд і повторіть дію.");
    return {
      revision: 4,
      removedCount: 1,
      addedCount: 0,
      document: { records: [{ name: "secret" }] },
      records: [{ name: "secret" }],
      changes: [{ id: editing.selectedPointIds[0], kind: "remove" }],
    };
  }, () => {}, () => {}, (citation) => citation.messageId === source.messageId, () => {}, editing);
  const edit = tools.find((tool) => tool.name === "echo_map_edit")!;
  const operations = [{
    op: "update",
    selector: { selected: true, ignored: true },
    fields: { observationDatetime: null, unexpected: 1 },
    sidc: null,
    record: {
      name: "Нова",
      coordinateSystem: "sk42",
      x: "1",
      y: "2",
      sources: [source, { messageId: 4, messageIdentifier: "invented" }],
    },
  }];
  await assert.rejects(() => edit.execute("edit", { operations }), /Мапа змінилася/);
  fail = false;
  const response = JSON.parse((await edit.execute("edit", { operations })).content[0].text as string);
  assert.equal(requests[0].path, "/api/ai-agent/maps/edit");
  assert.equal(requests[0].body.mapId, editing.mapId);
  assert.equal(requests[0].body.expectedRevision, 3);
  assert.equal(requests[1].body.expectedRevision, 3);
  assert.equal(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
  const sanitized = sanitizeEditOperations(operations, editing.selectedPointIds, (citation) => citation.messageId === source.messageId);
  assert.notEqual(requests[0].body.idempotencyKey, createHash("sha256").update(`3\n${JSON.stringify(sanitized)}`).digest("hex"));
  assert.deepEqual(sanitized[0].selector, { ids: editing.selectedPointIds, expect: "many" });
  assert.equal(sanitized[0].fields.clearObservationDatetime, true);
  assert.equal(sanitized[0].record.sidc, "");
  assert.deepEqual(sanitized[0].record.sources, [source]);
  assert.equal("document" in response, false);
  assert.equal("records" in response, false);
  assert.equal(response.revision, 4);
  await assert.rejects(() => edit.execute("edit", { operations }), /Немає вибраних точок/);
  assert.equal(requests[2].path, "/api/ai-agent/maps/get");
  const renamed = JSON.parse((await edit.execute("edit", { operations: [{ op: "setTitle", title: "Нова назва" }], summary: " Перейменовано " })).content[0].text as string);
  const rename = requests.filter((request) => request.path === "/api/ai-agent/maps/edit").at(-1);
  assert.equal(rename.body.expectedRevision, 4);
  assert.equal(rename.body.summary, "Перейменовано");
  assert.deepEqual(rename.body.operations, [{ op: "setTitle", title: "Нова назва" }]);
  assert.notEqual(rename.body.idempotencyKey, requests[0].body.idempotencyKey);
  const nextRequest = createMapTools(new MapRegistry(), async (path, body) => {
    requests.push({ path, body });
    return { revision: 4 };
  }, () => {}, () => {}, () => true, () => {}, editing).find((tool) => tool.name === "echo_map_edit")!;
  await nextRequest.execute("edit", { operations });
  assert.notEqual(requests.at(-1).body.idempotencyKey, requests[0].body.idempotencyKey);
  assert.equal(renamed.revision, 4);
});

test("#3064 map edit sanitizer rejects an empty selection and duplicate targets", () => {
  assert.throws(() => sanitizeEditOperations([{ op: "remove", selector: { selected: true } }], [], () => false), /Немає вибраних точок/);
  assert.throws(() => validateMapEdit({ ...editing, selectedPointIds: [editing.selectedPointIds[0], editing.selectedPointIds[0]] }), /unique/);
  assert.throws(() => validateMapEdit({ ...editing, extra: true }), /unsupported field/);
  assert.throws(() => validateMapEdit({ ...editing, requestId: "not-a-uuid" }), /UUID/);
  assert.throws(() => validateMapEdit({ ...editing, revision: 0 }), /positive/);
});

test("#3064 citation repair preserves registered map references alongside source chips", () => {
  const reference = "[мапа](echo-map:11111111-1111-4111-8111-111111111111)";
  const draft = `Події ${reference}. [джерело](/rer-analysis-neo?m=source-77)`;
  assert.ok(citationRepairPrompt(draft, [source], [reference]).includes("Preserve the draft's registered map links"));
  assert.equal(canonicalizeAnswer(draft, [source]), draft);
  const published = { id: "11111111-1111-4111-8111-111111111111", reference, published: true };
  assert.equal(preserveMapReferences(draft, "Відповідь із джерелом", [published]), `Відповідь із джерелом\n\n${reference}`);
  assert.equal(preserveMapReferences("Питання", "Відповідь", [{ ...published, requestId: "prior-request" }]), "Відповідь");
});
