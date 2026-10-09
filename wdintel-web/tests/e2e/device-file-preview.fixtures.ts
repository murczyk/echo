import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DeviceFilePreviewCategory =
  'document' | 'image' | 'audio' | 'video' | 'archive' | 'native-map' | 'converted-map';

export type DeviceFilePreviewFixture = {
  id: string;
  scenario: 'format' | 'metadata' | 'negative' | 'revision';
  fileName: string;
  extension: string;
  mimeType: string | null;
  category: DeviceFilePreviewCategory;
  assetPath: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  codec: string | null;
  mediaProbe: {
    streams: { codec_name: string; codec_type: string; width?: number; height?: number }[];
    format: { format_name: string; duration?: string };
  } | null;
  expectedViewer: string;
  expectedActions: string[];
  availability: 'present' | 'absent';
  byteRecipe: { kind: 'repeat'; byte: number; sizeBytes: number } | null;
  revisionPair?: string;
  expectedText?: string;
  expectedScriptExecution?: boolean;
  reference: {
    status: 'not-run';
    hosts: ['duty', 'analysis'];
    sameBytes: true;
    note: string;
  };
};

export const DEVICE_FILE_PREVIEW_FIXTURE_ROOT = fileURLToPath(
  new URL('./fixtures/device-file-preview/', import.meta.url),
);

export const DEVICE_FILE_PREVIEW_FIXTURES: readonly DeviceFilePreviewFixture[] = JSON.parse(
  readFileSync(resolve(DEVICE_FILE_PREVIEW_FIXTURE_ROOT, 'manifest.json'), 'utf8'),
);

export const DEVICE_FILE_PREVIEW_SEED_FIXTURES = DEVICE_FILE_PREVIEW_FIXTURES.filter(
  (fixture) => fixture.availability === 'present' && fixture.scenario !== 'negative',
);

export function deviceFilePreviewFixturePath(fixture: DeviceFilePreviewFixture): string {
  if (!fixture.assetPath || fixture.availability !== 'present')
    throw new Error(`Fixture ${fixture.id} has no stored bytes.`);
  const path = resolve(DEVICE_FILE_PREVIEW_FIXTURE_ROOT, fixture.assetPath);
  const suffix = relative(DEVICE_FILE_PREVIEW_FIXTURE_ROOT, path);
  if (suffix.startsWith('..') || isAbsolute(suffix))
    throw new Error(`Fixture ${fixture.id} escapes its owned directory.`);
  return path;
}

export async function loadDeviceFilePreviewFixture(id: string) {
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Unknown file-preview fixture: ${id}`);
  if (fixture.availability !== 'present')
    throw new Error(`File-preview fixture is explicitly unavailable: ${id}`);
  const recipe = fixture.byteRecipe;
  if (
    recipe &&
    (recipe.kind !== 'repeat' ||
      !Number.isInteger(recipe.byte) ||
      recipe.byte < 0 ||
      recipe.byte > 255 ||
      !Number.isInteger(recipe.sizeBytes) ||
      recipe.sizeBytes < 0 ||
      recipe.sizeBytes > 26 * 1024 * 1024)
  )
    throw new Error(`Invalid bounded byte recipe: ${id}`);
  const bytes = recipe
    ? Buffer.alloc(recipe.sizeBytes, recipe.byte)
    : await readFile(deviceFilePreviewFixturePath(fixture));
  if (
    bytes.length !== fixture.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== fixture.sha256
  )
    throw new Error(`File-preview fixture bytes do not match the manifest: ${id}`);
  return { fixture, bytes };
}

export async function validateDeviceFilePreviewFixtures() {
  const ids = new Set<string>();
  const extensions = new Set<string>();
  for (const fixture of DEVICE_FILE_PREVIEW_FIXTURES) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate file-preview fixture: ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.scenario === 'format') extensions.add(fixture.extension);
    if (fixture.availability === 'present') await loadDeviceFilePreviewFixture(fixture.id);
    else if (
      fixture.assetPath ||
      fixture.byteRecipe ||
      fixture.sizeBytes !== null ||
      fixture.sha256
    )
      throw new Error(`Unavailable fixture claims bytes: ${fixture.id}`);
    if (fixture.reference.status !== 'not-run')
      throw new Error(`Fixture ${fixture.id} claims unrecorded browser reference evidence.`);
  }
  if (extensions.size !== 54)
    throw new Error(`Expected 54 format extensions, found ${extensions.size}`);
  return {
    entries: DEVICE_FILE_PREVIEW_FIXTURES.length,
    explicitExtensions: extensions.size,
    seedEntries: DEVICE_FILE_PREVIEW_SEED_FIXTURES.length,
    unavailable: DEVICE_FILE_PREVIEW_FIXTURES.filter(
      (fixture) => fixture.availability === 'absent',
    ).map((fixture) => fixture.id),
    referenceStatus: 'not-run' as const,
  };
}
