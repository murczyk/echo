import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PYTHON_ROOT = "/opt/echo-ai-agent/python";
const STREAM_LIMIT = 64 * 1024;
const ENTRY_RE = /^[a-z]+\/run\.py$/;
// Separate user, network, mount and PID namespaces: no route to Echo or the
// model gateway, and empty /tmp, /run and /proc so the runner's credential
// files and processes are out of reach. The work directory becomes /dev/shm and
// the library root is bound read-only inside it. Killing unshare kills the whole
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
  'exec python3 -I -B -X utf8 "/dev/shm/lib/$3" /dev/shm',
].join("; ");

export interface SandboxOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxOptions {
  /** Library root bound read-only at /dev/shm/lib. */
  root: string;
  /** Entry point relative to root, e.g. "echomap/run.py". */
  entry: string;
  /** Prefix of the temporary work directory and the shell's $0. */
  name: string;
  timeoutMs: number;
  isolate?: () => boolean;
}

/** Runs the entry once in a fresh work directory: `prepare` writes its inputs,
 * `collect` reads the outputs before the directory is deleted. */
export type PythonSandbox = <T>(
  prepare: (work: string) => Promise<void>,
  collect: (work: string, outcome: SandboxOutcome) => Promise<T>,
  signal?: AbortSignal,
) => Promise<SandboxOutcome & { result: T }>;

let isolationProbe: boolean | undefined;

/** Whether unprivileged namespaces with tmpfs mounts work here; probed once. */
export function isolationAvailable(): boolean {
  if (isolationProbe === undefined) {
    const probe = spawnSync(ISOLATION[0], [...ISOLATION.slice(1), "/bin/sh", "-c", "mount -t tmpfs tmpfs /tmp"], { stdio: "ignore", timeout: 5_000 });
    isolationProbe = probe.status === 0;
  }
  return isolationProbe;
}

function capped(chunks: Buffer[], chunk: Buffer, size: { bytes: number }) {
  if (size.bytes >= STREAM_LIMIT) return;
  const kept = chunk.subarray(0, STREAM_LIMIT - size.bytes);
  chunks.push(kept);
  size.bytes += kept.length;
}

function execute(command: string[], work: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxOutcome> {
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
      stderr.push(Buffer.from(`\nScript exceeded ${timeoutMs / 1000} s`));
      kill();
    }, timeoutMs);
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

/** Returns undefined unless the entry exists and namespace isolation works;
 * scripts never run unisolated. */
export function createPythonSandbox(options: SandboxOptions): PythonSandbox | undefined {
  const { root, entry, name, timeoutMs, isolate = isolationAvailable } = options;
  if (!ENTRY_RE.test(entry) || !/^[a-z-]+$/.test(name)) throw new Error("Invalid sandbox entry");
  if (!existsSync(join(root, entry)) || !isolate()) return undefined;
  return async (prepare, collect, signal) => {
    signal?.throwIfAborted();
    const work = await mkdtemp(join(tmpdir(), `${name}-`));
    try {
      await prepare(work);
      const command = [...ISOLATION, "/bin/sh", "-c", SANDBOX_SETUP, name, work, root, entry];
      const outcome = await execute(command, work, timeoutMs, signal);
      signal?.throwIfAborted();
      return { ...outcome, result: await collect(work, outcome) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
