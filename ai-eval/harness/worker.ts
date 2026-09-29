import { readFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const nativeFetch = globalThis.fetch;
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fixtureHost = "echo-eval.invalid";
let runtimeDirectory: string | undefined;
const observations: Promise<void>[] = [];
const mapDocuments = new Map<string, { requestId: string; document: any }>();

// The worker is an isolated process. Inject transport at the fetch boundary so
// historical runners and the current runner execute their unchanged agent loop.
globalThis.fetch = async (resource, init) => {
  const url = new URL(typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url);
  if (url.hostname !== fixtureHost) throw new Error("Unexpected evaluation network destination");
  if (url.pathname.startsWith("/api/ai-agent/provider/v1/")) {
    const endpoint = input.engine.url.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
    const headers = new Headers(init?.headers);
    headers.delete("cookie");
    headers.delete("x-echo-agent-session");
    headers.delete("authorization");
    if (input.engine.token) headers.set("authorization", `Bearer ${input.engine.token}`);
    const response = await nativeFetch(`${endpoint}/chat/completions`, { ...init, headers, redirect: "error" });
    if (!response.ok) emit({ type: "eval_provider_error", status: response.status });
    observations.push(response.clone().text().then((text) => {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const chunk = JSON.parse(line.slice(5));
          if (chunk.usage) emit({ type: "eval_usage", ...chunk.usage });
        } catch { /* SSE terminal markers contain no usage. */ }
      }
    }).catch(() => {}));
    return response;
  }
  if (url.pathname === "/api/ai-agent/bootstrap/exchange") {
    return new Response(JSON.stringify({ correlationId: input.payload.correlationId }), {
      headers: { "content-type": "application/json", "set-cookie": "evaluation=fixture" },
    });
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const started = Date.now();
  if (url.pathname === "/api/ai-agent/maps/get") {
    const stored = mapDocuments.get(body.mapId);
    const authorized = stored?.requestId === body.requestId;
    emit({ type: "eval_retrieval", path: url.pathname, body, response: authorized ? stored!.document : null, status: authorized ? 200 : 404, latencyMs: Date.now() - started });
    return new Response(JSON.stringify(authorized ? stored!.document : { error: "Map not found" }), { status: authorized ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  const result = spawnSync("python3", [join(input.root, "ai-eval/harness/fixtures.py")], {
    input: JSON.stringify({ case: input.case, path: url.pathname, body, settings: input.settings }),
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Fixture transport failed");
  const response = JSON.parse(result.stdout);
  emit({ type: "eval_retrieval", path: url.pathname, body, response: response.body,
    status: response.status, latencyMs: Date.now() - started });
  return new Response(JSON.stringify(response.body ?? { error: response.error }), {
    status: response.status, headers: { "content-type": "application/json" },
  });
};

try {
  let runner = join(input.root, "echo-ai-agent/runner/runner.ts");
  if (input.runnerRef || input.runnerDirectory) {
    runtimeDirectory = await mkdtemp(join(tmpdir(), "echo-eval-runner-"));
    await symlink(join(input.root, "echo-ai-agent/node_modules"), join(runtimeDirectory, "node_modules"));
    await writeFile(join(runtimeDirectory, "package.json"), '{"type":"module"}');
    const files = input.runnerDirectory
      ? input.runnerFiles
      : execFileSync("git", ["ls-tree", "-r", "--name-only", input.runnerRef, "echo-ai-agent/runner"], { cwd: input.root, encoding: "utf8" }).trim().split("\n");
    for (const file of files.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = input.runnerDirectory
        ? await readFile(join(input.runnerDirectory, file))
        : execFileSync("git", ["show", `${input.runnerRef}:${file}`], { cwd: input.root });
      await writeFile(join(runtimeDirectory, file.split("/").at(-1)!), source);
    }
    runner = join(runtimeDirectory, "runner.ts");
  }
  const { runAgent, validatePayload, systemPrompt, runnerHello } = await import(pathToFileURL(resolve(runner)).href);
  const history = input.payload.history ?? [];
  emit({ ...runnerHello(), type: "eval_harness", prompt: systemPrompt(validatePayload(input.payload, false)) });
  for (const prompt of input.case.turns) {
    const payload = validatePayload({ ...input.payload, prompt, history }, false);
    let answer = "";
    const citations: unknown[] = [];
    const requestId = randomUUID();
    const maps: any[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...args: any[]) => {
      for (const line of String(chunk).trim().split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant_delta") answer += event.delta;
          if (event.type === "assistant_snapshot") answer = event.text;
          if (event.type === "message_citations") citations.push(...event.citations);
          if (event.type === "map_artifact" && !mapDocuments.has(event.document.id)) {
            mapDocuments.set(event.document.id, { requestId, document: event.document });
            const { records: _records, ...summary } = event.document;
            maps.push({ ...summary, requestId });
          }
        } catch { /* Only complete JSON events contribute to conversation state. */ }
      }
      return write(chunk, ...args);
    }) as typeof process.stdout.write;
    try { await runAgent(payload); } finally { process.stdout.write = write; }
    for (const summary of maps) {
      const exported = execFileSync(input.settings.binary, ["--mode", "debug", "ai-eval-maps"], {
        input: JSON.stringify({ operation: "export", document: mapDocuments.get(summary.id)!.document }),
        cwd: input.root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, RUST_LOG: "off" },
      });
      emit({ type: "eval_map_export", id: summary.id, ...JSON.parse(exported) });
    }
    emit({ type: "eval_answer", text: answer });
    history.push({ role: "user", content: prompt }, { role: "assistant", content: answer, citations, maps });
  }
} catch (error) {
  emit({ type: "eval_error", message: error instanceof Error ? error.message : "Evaluation failed" });
  process.exitCode = 1;
} finally {
  await Promise.allSettled(observations);
  globalThis.fetch = nativeFetch;
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
}
