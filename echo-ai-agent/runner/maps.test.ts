import assert from "node:assert/strict";
import test from "node:test";
import { MapRegistry, createMapTools, preserveMapReferences, validateMapSummaries, type MapRecord } from "./maps.ts";
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
  await assert.rejects(() => execute("echo_map_append", { id, records: Array.from({ length: 17 }, (_, i) => record(i)) }), /limits/);
  assert.equal(requests.length, 0);
  await execute("echo_map_append", { id, records: Array.from({ length: 16 }, (_, i) => record(i + 1)) });
  await execute("echo_map_append", { id, records: [record(17)] });
  assert.equal(events.length, 0);
  assert.equal((await execute("echo_map_list", {})).maps[0].published, false);
  const first = await execute("echo_map_get", { id });
  assert.equal(first.records.length, 16);
  assert.equal(first.nextOffset, 16);
  assert.equal((await execute("echo_map_get", { id, offset: 16 })).records[0].name, "Подія 17");
  const published = await execute("echo_map_publish", { id });
  await execute("echo_map_publish", { id });
  assert.equal(events.length, 1);
  assert.equal(published.reference, `[мапа](echo-map:${id})`);
  assert.equal(events[0].document.totalCount, 17);
  assert.deepEqual(events[0].document.records.map((item: MapRecord) => item.name), Array.from({ length: 17 }, (_, i) => `Подія ${i + 1}`));
  await assert.rejects(() => execute("echo_map_append", { id, records: [record(18)] }), /immutable/);
  const draft = registry.create("Чернетка", false);
  registry.discardDrafts();
  assert.equal(registry.get(draft.id), undefined);
  assert.equal(registry.get(id)?.totalCount, 17);
});

test("#3064 aborted preparation and unregistered sources cannot alter canonical records", async () => {
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
  await assert.rejects(() => append.execute("call", { id, records: [{ ...record(1), sources: [source] }] }), /retrieved message citations/);
  assert.equal(calls, 0);
  await assert.rejects(() => append.execute("call", { id, records: [record(1)] }, controller.signal), /abort/i);
  assert.equal(registry.get(id)?.totalCount, 0);
  registry.discardDrafts();
  assert.deepEqual(registry.list(), []);
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

test("#3064 citation repair preserves registered map references alongside source chips", () => {
  const reference = "[мапа](echo-map:11111111-1111-4111-8111-111111111111)";
  const draft = `Події ${reference}. [джерело](/rer-analysis-neo?m=source-77)`;
  assert.ok(citationRepairPrompt(draft, [source], [reference]).includes("Preserve the draft's registered map links"));
  assert.equal(canonicalizeAnswer(draft, [source]), draft);
  const published = { id: "11111111-1111-4111-8111-111111111111", reference, published: true };
  assert.equal(preserveMapReferences(draft, "Відповідь із джерелом", [published]), `Відповідь із джерелом\n\n${reference}`);
  assert.equal(preserveMapReferences("Питання", "Відповідь", [{ ...published, requestId: "prior-request" }]), "Відповідь");
});
