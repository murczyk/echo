import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MapRegistry, createMapTools, type MapRecord } from "./maps.ts";
import { createMapScriptRunner, type MapScriptRunner } from "./map-script.ts";

const PYTHON_ROOT = fileURLToPath(new URL("../template/python", import.meta.url));
const REPORT = `[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:03
Координаты цели: 5272881, 6679505
Комментарий:
328/24
[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:15
Координаты цели: 5272881, 6679505
`;
const editing = {
  requestId: "11111111-1111-4111-8111-111111111111",
  mapId: "22222222-2222-4222-8222-222222222222",
  revision: 2,
  selectedPointIds: [],
};
const prepared = (input: any): MapRecord => ({
  ...input, platformType: "CAPDOC", originalX: input.x, originalY: input.y,
  latitude: 47.5, longitude: 35.3, warnings: [],
});

function tools(run: MapScriptRunner, requests: any[], options: { editing?: typeof editing } = {}) {
  const registry = new MapRegistry([{
    id: editing.mapId, requestId: editing.requestId, title: "Відкрита", isMain: true,
    totalCount: 1, validCount: 1, invalidCount: 0, warnings: [],
  }]);
  const list = createMapTools(registry, async (path, body: any) => {
    requests.push({ path, body });
    if (path === "/api/ai-agent/maps/prepare") return { records: body.records.map(prepared) };
    if (path === "/api/ai-agent/maps/get") return { id: editing.mapId, title: "Відкрита", isMain: true, records: [], warnings: [], totalCount: 0, validCount: 0, invalidCount: 0 };
    return { revision: 3, changes: [], updatedCount: body.operations.length };
  }, () => {}, () => {}, () => true, () => {}, options.editing,
  { run, prompt: REPORT, messages: () => [] });
  return async (name: string, params: any) =>
    JSON.parse((await list.find((tool) => tool.name === name)!.execute("call", params)).content[0].text as string);
}

const realRunner = createMapScriptRunner(PYTHON_ROOT);

test("#3064 a sandboxed script parses pasted reports into one atomic append", { skip: !realRunner && "namespace isolation unavailable" }, async () => {
  const requests: any[] = [];
  const execute = tools(realRunner!, requests);
  const { id } = await execute("echo_map_create", { title: "Польоти", isMain: true });
  const result = await execute("echo_map_script", {
    id,
    code: [
      "from echomap import inputs, parse, sidc, Record, emit_records",
      "for block in parse.split(inputs.prompt(), r'Детали полета'):",
      "    f = parse.kv(block)",
      "    x, y = parse.pair(f.first('Координаты цели'))",
      "    emit_records([Record(name='3 дшб 328 дшп', x=x, y=y, when=parse.dt(f.first('Дата'), f.first('Время')),",
      "        comments=[block], sidc=sidc.find('доставка провізії', identity='friend'))])",
      "print('records', 2)",
    ].join("\n"),
  });
  assert.equal(result.appended.addedCount, 2);
  assert.equal(result.stdout.trim(), "records 2");
  const records = requests.find((request) => request.path === "/api/ai-agent/maps/prepare").body.records;
  assert.deepEqual(records.map((item: any) => item.observationDatetime), ["2026-09-24T18:03:00", "2026-09-24T18:15:00"]);
  assert.match(records[0].comments[0], /Комментарий:\n328\/24/);
  assert.equal(records[0].sidc.slice(3, 4), "3");
});

test("#3064 sandboxed scripts have no network and report their errors", { skip: !realRunner && "namespace isolation unavailable" }, async () => {
  const execute = tools(realRunner!, []);
  const { id } = await execute("echo_map_create", { title: "Мережа", isMain: true });
  await assert.rejects(() => execute("echo_map_script", {
    id,
    code: "import socket\nsocket.create_connection(('127.0.0.1', 443), timeout=2)\n",
  }), /Script failed[\s\S]*(unreachable|refused|OSError)/i);
});

test("#3064 script edits become one revision even beyond the manual operation limit", async () => {
  const requests: any[] = [];
  const operations = Array.from({ length: 40 }, (_, index) => ({
    op: "update", selector: { ids: [`id-${index}`], expect: "one" }, fields: { name: `Точка ${index}` },
  }));
  const run: MapScriptRunner = async (_code, inputs) => {
    assert.equal((inputs.map as any).id, editing.mapId);
    return { status: 0, stdout: "", stderr: "", result: { records: [], operations, summary: "Перейменовано 40", logs: ["ok"] } };
  };
  const execute = tools(run, requests, { editing });
  const result = await execute("echo_map_script", { code: "pass" });
  const edit = requests.find((request) => request.path === "/api/ai-agent/maps/edit");
  assert.equal(edit.body.operations.length, 40);
  assert.equal(edit.body.summary, "Перейменовано 40");
  assert.equal(edit.body.expectedRevision, 2);
  assert.equal(result.edit.revision, 3);
  assert.deepEqual(result.logs, ["ok"]);
});

test("#3064 failed scripts surface stderr and change nothing", async () => {
  const requests: any[] = [];
  const run: MapScriptRunner = async () => ({ status: 1, stdout: "", stderr: "Traceback\nKeyError: 'Дата'", result: null });
  const execute = tools(run, requests, { editing });
  await assert.rejects(() => execute("echo_map_script", { code: "x" }), /KeyError: 'Дата'/);
  assert.equal(requests.filter((request) => request.path !== "/api/ai-agent/maps/get").length, 0);
});

test("#3064 scripts cannot read the runner's temporary files or processes", { skip: !realRunner && "namespace isolation unavailable" }, async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const secretDir = await mkdtemp(join(tmpdir(), "echo-ai-agent-runner-"));
  await writeFile(join(secretDir, "models.json"), "secret-key", { mode: 0o600 });
  try {
    const outcome = await realRunner!(
      [
        "import os, subprocess",
        "print(sorted(os.listdir('/tmp')), sorted(os.listdir('/proc')))",
        "r = subprocess.run(['umount', '/tmp'], capture_output=True)",
        "print('umount', r.returncode != 0)",
      ].join("\n"),
      { prompt: "", messages: [], map: null, selectedPointIds: [] },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), "[] []\numount True");
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("#3064 aborting a script also stops subprocesses it started", { skip: !realRunner && "namespace isolation unavailable" }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = realRunner!(
    "import subprocess\nsubprocess.Popen(['sleep', '20'])\nimport time\ntime.sleep(20)\n",
    { prompt: "", messages: [], map: null, selectedPointIds: [] },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(running);
  assert.ok(Date.now() - started < 5_000, "abort waited for the subprocess");
});
