import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPythonSandbox, isolationAvailable, PYTHON_ROOT } from "./python-sandbox.ts";

export const MAP_PYTHON_ROOT = PYTHON_ROOT;
const SCRIPT_TIMEOUT_MS = 30_000;

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
  const sandbox = createPythonSandbox({ root, entry: "echomap/run.py", name: "echo-map-script", timeoutMs: SCRIPT_TIMEOUT_MS, isolate });
  if (!sandbox) return undefined;
  return async (code, inputs, signal) => sandbox(
    async (work) => {
      await writeFile(join(work, "inputs.json"), JSON.stringify(inputs));
      await writeFile(join(work, "script.py"), code);
    },
    async (work, outcome) => {
      const resultPath = join(work, "result.json");
      return outcome.status === 0 && existsSync(resultPath)
        ? validResult(JSON.parse(await readFile(resultPath, "utf8")))
        : null;
    },
    signal,
  );
}
