import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAP_PYTHON_ROOT = "/opt/echo-ai-agent/python";
const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_STREAM_LIMIT = 64 * 1024;
// Separate user, network, mount and PID namespaces: no route to Echo or the
// model gateway, and empty /tmp, /run and /proc so the runner's credential
// files and processes are out of reach. The work directory becomes /dev/shm and
// the library is bound read-only inside it. Killing unshare kills the whole
// PID namespace (--kill-child), including any subprocess the script started.
const ISOLATION = ["unshare", "--user", "--map-root-user", "--net", "--mount", "--pid", "--fork", "--kill-child", "--"];
const SANDBOX_SETUP = [
  "set -e",
  'mkdir -p "$1/lib"',
  'mount --bind "$2" "$1/lib"',
  'mount -o remount,bind,ro "$1/lib"',
  'mount --rbind "$1" /dev/shm',
  "for d in /tmp /var/tmp /run /proc; do mount -t tmpfs -o size=4m,mode=0755 tmpfs \"$d\"; done",
  "cd /dev/shm",
  "exec python3 -I -B -X utf8 /dev/shm/lib/echomap/run.py /dev/shm",
].join("; ");

function sandboxCommand(work: string, root: string): string[] {
  return [...ISOLATION, "/bin/sh", "-c", SANDBOX_SETUP, "echo-map-script", work, root];
}

export interface ScriptMessage {
  messageId: number;
  messageIdentifier: string;
  text: string;
  datetime: string;
  author: string;
  group: string;
}

export interface MapScriptInputs {
  files?: import("./devices.ts").FileSection[];
  prompt: string;
  messages: ScriptMessage[];
  map: unknown;
  selectedPointIds: string[];
}

export interface RecipeStats {
  recipe: string;
  label: string;
  sourceCount: number;
  emittedCount: number;
  skipped: Array<{ index: number; reason: string }>;
}

export interface MapScriptResult {
  records: any[];
  operations: unknown[];
  summary: string | null;
  logs: string[];
  stats: RecipeStats | null;
  detected: Record<string, number>;
}

export interface MapScriptOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  result: MapScriptResult | null;
}

export type MapScriptRunner = (code: string, inputs: MapScriptInputs, signal?: AbortSignal) => Promise<MapScriptOutcome>;

function isolationAvailable(): boolean {
  const probe = spawnSync(ISOLATION[0], [...ISOLATION.slice(1), "/bin/sh", "-c", "mount -t tmpfs tmpfs /tmp"], { stdio: "ignore", timeout: 5_000 });
  return probe.status === 0;
}

function capped(chunks: Buffer[], chunk: Buffer, size: { bytes: number }) {
  if (size.bytes >= SCRIPT_STREAM_LIMIT) return;
  const kept = chunk.subarray(0, SCRIPT_STREAM_LIMIT - size.bytes);
  chunks.push(kept);
  size.bytes += kept.length;
}

function execute(command: string[], work: string, signal?: AbortSignal): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: work,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: work },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outSize = { bytes: 0 };
    const errSize = { bytes: 0 };
    child.stdout.on("data", (chunk: Buffer) => capped(stdout, chunk, outSize));
    child.stderr.on("data", (chunk: Buffer) => capped(stderr, chunk, errSize));
    const kill = () => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      stderr.push(Buffer.from(`\nScript exceeded ${SCRIPT_TIMEOUT_MS / 1000} s`));
      kill();
    }, SCRIPT_TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function validResult(value: unknown): MapScriptResult {
  const result = value as MapScriptResult;
  if (!result || !Array.isArray(result.records) || !Array.isArray(result.operations) || !Array.isArray(result.logs)) {
    throw new Error("Script produced an invalid result");
  }
  return {
    records: result.records,
    operations: result.operations,
    summary: typeof result.summary === "string" ? result.summary : null,
    logs: result.logs.filter((line): line is string => typeof line === "string").slice(0, 200),
    stats: result.stats && typeof result.stats === "object" ? result.stats : null,
    detected: Object.fromEntries(Object.entries(result.detected ?? {})
      .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0)),
  };
}

/** Returns undefined (no script tool) unless the library is installed and
 * namespace isolation works; scripts never run unisolated. */
export function createMapScriptRunner(root = MAP_PYTHON_ROOT, isolate = isolationAvailable): MapScriptRunner | undefined {
  const entry = join(root, "echomap", "run.py");
  if (!existsSync(entry) || !isolate()) return undefined;
  return async (code, inputs, signal) => {
    signal?.throwIfAborted();
    const work = await mkdtemp(join(tmpdir(), "echo-map-script-"));
    try {
      await writeFile(join(work, "inputs.json"), JSON.stringify(inputs));
      await writeFile(join(work, "script.py"), code);
      const outcome = await execute(sandboxCommand(work, root), work, signal);
      signal?.throwIfAborted();
      const resultPath = join(work, "result.json");
      const result = outcome.status === 0 && existsSync(resultPath)
        ? validResult(JSON.parse(await readFile(resultPath, "utf8")))
        : null;
      return { ...outcome, result };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
