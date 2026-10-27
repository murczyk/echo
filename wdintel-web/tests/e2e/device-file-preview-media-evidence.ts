import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export type MediaReferenceOutcome = {
  fixture: string;
  host: string;
  sha256: string;
  playable: boolean;
  nativeError: number | null;
  duration?: number;
  frameSha256?: string;
  videoWidth?: number;
  videoHeight?: number;
};
type Evidence = {
  run: string;
  origin: string;
  capturedAt: string;
  outcomes: MediaReferenceOutcome[];
};

const producer = 'npx playwright test tests/e2e/device-file-preview-media-reference.spec.ts';
const artifact = (root: string) => resolve(root, 'acceptance-media/reference-outcomes.json');

async function privatePath(path: string, directory: boolean) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('Media evidence paths must be private, owned, regular paths without links.');
  return true;
}

async function readEvidence(root: string): Promise<Evidence | null> {
  if (!(await privatePath(resolve(root, 'acceptance-media'), true))) return null;
  if (!(await privatePath(artifact(root), false))) return null;
  return JSON.parse(await readFile(artifact(root), 'utf8'));
}

function validate(evidence: Evidence, run: string, origin: string) {
  if (evidence.run !== run || evidence.origin !== origin || !Array.isArray(evidence.outcomes))
    throw new Error('Media reference evidence belongs to another harness run or origin.');
}

export async function readMediaReferenceEvidence(root: string, run: string, origin: string) {
  const evidence = await readEvidence(root);
  if (!evidence)
    throw new Error(
      `Run the same-byte reference producer in this sourced harness first: ${producer}`,
    );
  validate(evidence, run, origin);
  return evidence.outcomes;
}

export async function writeMediaReferenceEvidence(outcomes: MediaReferenceOutcome[]) {
  const root = process.env.DEVICE_FILE_PREVIEW_ROOT;
  const run = process.env.DEVICE_FILE_PREVIEW_RUN;
  const origin = process.env.PLAYWRIGHT_BASE_URL;
  if (!root || !run || !origin)
    throw new Error('Source the owned file-preview harness environment first.');
  const environment = JSON.parse(
    await readFile(resolve(root, 'resolved-environment.json'), 'utf8'),
  );
  if (
    (await realpath(root)) !== resolve(root) ||
    (await stat(root)).mode & 0o077 ||
    environment.run !== run ||
    environment.root !== root ||
    origin !== `http://127.0.0.1:${environment.proxy_port}`
  )
    throw new Error(
      'Media reference producer requires its private harness run and loopback origin.',
    );
  const directory = resolve(root, 'acceptance-media');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await privatePath(directory, true);
  const previous = await readEvidence(root);
  if (previous) validate(previous, run, origin);
  const fixtures = new Set(outcomes.map((outcome) => outcome.fixture));
  const evidence: Evidence = {
    run,
    origin,
    capturedAt: new Date().toISOString(),
    outcomes: [
      ...(previous?.outcomes ?? []).filter((outcome) => !fixtures.has(outcome.fixture)),
      ...outcomes,
    ],
  };
  const temporary = resolve(directory, `.reference-outcomes-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(evidence, null, 2) + '\n');
    } finally {
      await file.close();
    }
    await privatePath(temporary, false);
    await rename(temporary, artifact(root));
    created = false;
  } finally {
    if (created && (await privatePath(temporary, false))) await unlink(temporary);
  }
}
