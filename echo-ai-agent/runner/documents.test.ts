import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DocumentRegistry,
  createDocumentScriptRunner,
  createDocumentTools,
  stripUnknownDocumentLinks,
  type DocumentRunOutcome,
  type DocumentScriptRunner,
} from "./documents.ts";
import { isolationAvailable } from "./python-sandbox.ts";
import { echoDownloadBytes, echoUploadBytes, systemPrompt, toolErrorSummary, validatePayload, validateSkill } from "./runner.ts";

const PYTHON_ROOT = fileURLToPath(new URL("../template/python", import.meta.url));
const documentId = "019fc7f7-9770-7f83-9c1a-211af29b02e1";
const uploadId = "019fc7f7-9770-7f83-9c1a-211af29b02e2";
const listed = { documentId, title: "Звіт за вересень", fileName: "zvit.docx", headRevision: 3, sizeBytes: 2048, updatedAt: "2026-11-03T10:00:00Z", sourceUploadId: uploadId };
const routes = [
  { method: "POST", path: "/api/ai-agent/documents/ai/list", skill: "document_list", label: "Переглядаю документи розмови", requestKind: "documentList" },
  { method: "GET", path: "/api/ai-agent/documents/ai/source", skill: "document_source", label: "Відкриваю документ", requestKind: "documentSource" },
  { method: "POST", path: "/api/ai-agent/documents/ai/save", skill: "document_save", label: "Зберігаю документ", requestKind: "documentSave" },
];
const payload = {
  prompt: "Заповни звіт за жовтень",
  modelName: "google/gemma-4-26B-A4B-it",
  history: [],
  echoPublicHost: "echo-staging.example.test",
  bootstrapToken: "A".repeat(43),
  correlationId: "019fc7f7-9770-7f83-9c1a-211af29b02e6",
  timeContext: { timeZone: "Europe/Kyiv", requestStartedAtUtc: "2026-11-03T12:00:00Z" },
  skills: routes,
  documents: [listed],
  documentTarget: { documentId, revision: 3 },
};
const authentication = { cookie: "id=session", correlationId: payload.correlationId };
const docx = (size = 8) => new Uint8Array(Buffer.from("PK\x03\x04".padEnd(size, "x")));

function outcome(outputs: any[], files: Record<string, Uint8Array>): DocumentRunOutcome {
  return { status: 0, stdout: "", stderr: "", result: { outputs, outline: null, logs: ["ok"] }, files: new Map(Object.entries(files)) };
}

function documentTools(run: DocumentScriptRunner, upload: (query: Record<string, string>, bytes: Uint8Array) => Promise<unknown>) {
  const registry = new DocumentRegistry([listed], { documentId, revision: 3 });
  const events: any[] = [];
  const downloads: Record<string, string>[] = [];
  const tools = createDocumentTools(registry, {
    list: async () => ({ documents: [listed], templates: [] }),
    download: async (query) => {
      downloads.push(query);
      return { bytes: docx(), revision: query.documentId ? 3 : null };
    },
    upload,
  }, run, { prompt: payload.prompt, messages: () => [], uploadName: () => "шаблон.docx" }, (event) => events.push(event), () => {});
  const execute = async (name: string, params: any) =>
    (await tools.find((tool) => tool.name === name)!.execute("call", params, undefined as any, undefined as any)).content[0].text as string;
  return { registry, events, downloads, execute };
}

test("#3985 document skills accept only their fixed routes and methods", () => {
  for (const route of routes) assert.equal(validateSkill(route).requestKind, route.requestKind);
  assert.throws(() => validateSkill({ ...routes[1], method: "POST" }), /does not match/);
  assert.throws(() => validateSkill({ ...routes[2], method: "GET" }), /does not match/);
  assert.throws(() => validateSkill({ ...routes[0], path: "/api/ai-agent/requests/create" }), /does not match/);
  assert.throws(() => validateSkill({ ...routes[2], skill: "document_list" }), /does not match/);
});

test("#3985 the payload carries bounded document summaries and the open document", () => {
  const validated = validatePayload(payload as any, false);
  assert.deepEqual(validated.documents, [listed]);
  assert.deepEqual(validated.documentTarget, { documentId, revision: 3 });
  assert.throws(() => validatePayload({ ...payload, documents: [{ ...listed, documentId: "../x" }] } as any, false), /UUID/);
  assert.throws(() => validatePayload({ ...payload, documentTarget: { documentId, revision: 0 } } as any, false), /revision/);
  assert.throws(() => validatePayload({ ...payload, documents: Array.from({ length: 21 }, () => listed) } as any, false), /at most 20/);
  const registry = new DocumentRegistry(validated.documents, validated.documentTarget);
  const prompt = systemPrompt(validated, { documents: registry });
  assert.match(prompt, /echo_document_script/);
  assert.match(prompt, /"Звіт за вересень" \(documentId 019fc7f7-9770-7f83-9c1a-211af29b02e1, revision 3\) open/);
  assert.doesNotMatch(systemPrompt(validated), /echo_document_script/);
});

test("#3985 document tools are absent without the library or isolation", () => {
  assert.equal(createDocumentScriptRunner(join(tmpdir(), "no-echodoc-here")), undefined);
  assert.equal(createDocumentScriptRunner(PYTHON_ROOT, () => false), undefined);
});

test("#3985 sources download through the byte route with a size cap", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(docx(64), { status: 200, headers: { "X-Echo-Document-Revision": "4" } });
  }) as typeof fetch;
  try {
    const loaded = await echoDownloadBytes(payload, authentication, "/api/ai-agent/documents/ai/source", { documentId });
    assert.equal(loaded.bytes.byteLength, 64);
    assert.equal(loaded.revision, 4);
    assert.equal(requests[0].url, `https://echo-staging.example.test/api/ai-agent/documents/ai/source?documentId=${documentId}`);
    assert.equal((requests[0].init.headers as Record<string, string>)["X-Echo-Agent-Session"], authentication.correlationId);
    assert.equal(requests[0].init.redirect, "manual");
    await assert.rejects(echoDownloadBytes(payload, authentication, "/api/ai-agent/documents/ai/source", { uploadId }, undefined, 16), /too large/);
    await assert.rejects(echoDownloadBytes(payload, authentication, "/api/ai-agent/maps/get", {}), /limited to the document source route/);
    await assert.rejects(echoUploadBytes(payload, authentication, "/api/ai-agent/documents/ai/save", {}, docx(64), undefined, 16), /too large/);
    await assert.rejects(echoUploadBytes(payload, authentication, "/api/ai-agent/uploads/create", {}, docx()), /limited to the document save route/);
  } finally {
    globalThis.fetch = original;
  }
});

test("#3985 a saved script output becomes a new version and a document_artifact event", async () => {
  const uploads: Array<{ query: Record<string, string>; size: number }> = [];
  let inputs: any;
  const run: DocumentScriptRunner = async (given, code, sources) => {
    inputs = { given, code, sources };
    return outcome([
      { path: "out/1.docx", source: 1, documentId, title: null, fileName: null, summary: "Дані за жовтень", outline: "[0] ¶ Title: Звіт за жовтень" },
      { path: "out/2.docx", source: 2, documentId: null, title: "Довідка", fileName: "dovidka.docx", summary: null, outline: "" },
    ], { "out/1.docx": docx(10), "out/2.docx": docx(12) });
  };
  const { events, downloads, execute, registry } = documentTools(run, async (query, bytes) => {
    uploads.push({ query, size: bytes.byteLength });
    return query.documentId
      ? { documentId, revision: 4, title: "Звіт за вересень", fileName: "zvit.docx", sizeBytes: bytes.byteLength, created: false }
      : { documentId: "019fc7f7-9770-7f83-9c1a-211af29b02e3", revision: 1, title: "Довідка", fileName: "dovidka.docx", sizeBytes: bytes.byteLength, created: true };
  });
  const text = await execute("echo_document_script", { code: "import echodoc", sources: [{ documentId }, { uploadId }] });
  assert.deepEqual(downloads, [{ documentId }, { uploadId }]);
  assert.deepEqual(inputs.given.sources.map((source: any) => [source.index, source.path, source.kind, source.revision]),
    [[1, "sources/1.docx", "document", 3], [2, "sources/2.docx", "upload", null]]);
  assert.equal(inputs.given.mode, "script");
  assert.equal(inputs.sources.length, 2);
  assert.equal(uploads[0].query.documentId, documentId);
  assert.equal(uploads[0].query.expectedRevision, "3");
  assert.equal(uploads[0].query.summary, "Дані за жовтень");
  assert.equal(uploads[1].query.title, "Довідка");
  assert.equal(uploads[1].query.sourceUploadId, uploadId);
  assert.ok(uploads[0].query.idempotencyKey !== uploads[1].query.idempotencyKey);
  assert.deepEqual(events, [
    { type: "document_artifact", documentId, revision: 4 },
    { type: "document_artifact", documentId: "019fc7f7-9770-7f83-9c1a-211af29b02e3", revision: 1 },
  ]);
  assert.match(text, /\[Звіт за вересень\]\(echo-document:019fc7f7-9770-7f83-9c1a-211af29b02e1\)/);
  assert.match(text, /\[0\] ¶ Title: Звіт за жовтень/);
  assert.equal(registry.get(documentId)?.headRevision, 4);
  assert.ok(registry.knows("019fc7f7-9770-7f83-9c1a-211af29b02e3"));
});

test("#3985 a lost save response is retried once with the same idempotency key", async () => {
  const keys: string[] = [];
  const run: DocumentScriptRunner = async () => outcome([{ path: "out/1.docx", source: null, documentId: null, title: "Новий", fileName: null, summary: null, outline: "" }], { "out/1.docx": docx() });
  const { events, execute } = documentTools(run, async (query) => {
    keys.push(query.idempotencyKey);
    if (keys.length === 1) throw new TypeError("fetch failed");
    return { documentId: "019fc7f7-9770-7f83-9c1a-211af29b02e4", revision: 1, title: "Новий", fileName: "noviy.docx", sizeBytes: 8, created: true };
  });
  await execute("echo_document_script", { code: "import echodoc" });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(events.length, 1);
});

test("#3985 a stale revision is reported to the model without an event", async () => {
  const run: DocumentScriptRunner = async () => outcome([{ path: "out/1.docx", source: 1, documentId, title: null, fileName: null, summary: null, outline: "" }], { "out/1.docx": docx() });
  let calls = 0;
  const { events, execute } = documentTools(run, async () => {
    calls += 1;
    throw new Error("Echo returned HTTP 409: Document revision changed");
  });
  await assert.rejects(execute("echo_document_script", { code: "import echodoc", sources: [{ documentId }] }), (error: Error) => {
    assert.match(error.message, /HTTP 409/);
    assert.match(error.message, /open it again/);
    assert.equal(toolErrorSummary("echo_document_script", { content: [{ text: error.message }] }), "Документ змінився; потрібно відкрити його знову");
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

test("#3985 a failed script returns its traceback for a fix", async () => {
  const run: DocumentScriptRunner = async () => ({ status: 1, stdout: "", stderr: "Traceback (most recent call last):\nNameError: name 'tabel' is not defined", result: null, files: new Map() });
  const { execute } = documentTools(run, async () => ({}));
  await assert.rejects(execute("echo_document_script", { code: "tabel" }), /Script failed \(exit 1\)[\s\S]*NameError/);
});

test("#3985 links to documents that are neither listed nor saved keep only their label", () => {
  const registry = new DocumentRegistry([listed]);
  registry.recordSave({ documentId: "019fc7f7-9770-7f83-9c1a-211af29b02e5", revision: 1, title: "Новий", fileName: "noviy.docx" });
  const answer = `Готово: [Звіт](echo-document:${documentId}), [Довідка](echo-document:019fc7f7-9770-7f83-9c1a-211af29b02e5) і [Вигаданий](echo-document:019fc7f7-9770-7f83-9c1a-211af29b02e9), [зламаний](echo-document:abc).`;
  assert.equal(stripUnknownDocumentLinks(answer, registry),
    `Готово: [Звіт](echo-document:${documentId}), [Довідка](echo-document:019fc7f7-9770-7f83-9c1a-211af29b02e5) і Вигаданий, зламаний.`);
});

const sandboxed = isolationAvailable();

async function fakeLibrary(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "echodoc-fake-"));
  await mkdir(join(root, "echodoc"));
  await writeFile(join(root, "echodoc", "run.py"), script);
  return root;
}

test("#3985 the sandbox passes source bytes in and reads saved files back", { skip: !sandboxed && "namespace isolation unavailable" }, async () => {
  const root = await fakeLibrary([
    "import json, shutil, sys",
    "work = sys.argv[1]",
    "inputs = json.load(open(work + '/inputs.json'))",
    "assert inputs['sources'][0]['path'] == 'sources/1.docx'",
    "shutil.copy(work + '/sources/1.docx', work + '/out/1.docx')",
    "json.dump({'outputs': [{'path': 'out/1.docx', 'source': 1, 'documentId': None, 'title': 'Копія', 'outline': ''}], 'logs': [open(work + '/script.py').read()]}, open(work + '/result.json', 'w'))",
  ].join("\n"));
  try {
    const run = createDocumentScriptRunner(root)!;
    const source = docx(100);
    const result = await run({ mode: "script", prompt: "", messages: [], files: [], maxOutputs: 4,
      sources: [{ index: 1, path: "sources/1.docx", kind: "upload", uploadId, documentId: null, revision: null, title: "Шаблон", fileName: "t.docx" }] }, "print(1)", [source]);
    assert.deepEqual(result.result?.logs, ["print(1)"]);
    assert.deepEqual(result.files.get("out/1.docx"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#3985 the sandbox refuses outputs over the document size cap", { skip: !sandboxed && "namespace isolation unavailable" }, async () => {
  const root = await fakeLibrary([
    "import json, sys",
    "work = sys.argv[1]",
    "open(work + '/out/big.docx', 'wb').truncate(33 * 1024 * 1024)",
    "json.dump({'outputs': [{'path': 'out/big.docx', 'title': 'Великий', 'outline': ''}], 'logs': []}, open(work + '/result.json', 'w'))",
  ].join("\n"));
  try {
    const run = createDocumentScriptRunner(root)!;
    await assert.rejects(run({ mode: "script", prompt: "", messages: [], files: [], sources: [], maxOutputs: 4 }, "", []), /too large/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const echodocInstalled = sandboxed && existsSync(join(PYTHON_ROOT, "echodoc", "run.py"))
  && spawnSync("python3", ["-I", "-c", "import docx"], { stdio: "ignore" }).status === 0;

test("#3985 echodoc creates a document from scratch in the real sandbox", { skip: !echodocInstalled && "python-docx or echodoc unavailable" }, async () => {
  const run = createDocumentScriptRunner(PYTHON_ROOT)!;
  const result = await run({ mode: "script", prompt: "", messages: [], files: [], sources: [], maxOutputs: 4 },
    "import echodoc\ndoc = echodoc.blank()\ndoc.add_paragraph('Привіт')\nechodoc.save(doc, title='Тест')\n", []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result?.outputs.length, 1);
  assert.equal(result.result?.outputs[0].title, "Тест");
  assert.ok(result.files.get(result.result!.outputs[0].path)!.byteLength > 1000);
});
