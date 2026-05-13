#!/usr/bin/env node
/**
 * Sync release content from the docs source directory into the web app's
 * static/ folder, generating /releases/index.json from folder names.
 *
 * Elm Land's build hardcodes `configFile: false` and uses ./static as
 * the Vite publicDir, so this script is the single place that decides
 * where the release content lives on disk. When moving to remote
 * storage, replace the sync target with a fetch from that storage and
 * adjust VITE_RELEASES_BASE_URL on the React side; nothing else needs
 * to change.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');

const SOURCE_DIR = path.resolve(REPO_ROOT, 'docs/releases');
const TARGET_DIR = path.resolve(WEB_ROOT, 'static/releases');

const RELEASE_ID_RE = /^\d{4}-\d{2}-\d{2}$/;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function extractTitle(mdPath) {
  try {
    const content = await fs.readFile(mdPath, 'utf-8');
    const match = /^#\s+(.+)/m.exec(content);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function listReleases(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!RELEASE_ID_RE.test(entry.name)) continue;
    const releasePath = path.join(rootDir, entry.name);
    const mdPath = path.join(releasePath, 'release.md');
    if (!(await exists(mdPath))) continue;
    const title = (await extractTitle(mdPath)) ?? entry.name;
    releases.push({ release_id: entry.name, title });
  }

  releases.sort((a, b) =>
    a.release_id < b.release_id ? 1 : a.release_id > b.release_id ? -1 : 0,
  );
  return releases;
}

async function main() {
  if (!(await exists(SOURCE_DIR))) {
    console.warn(`[sync-releases] source dir not found: ${SOURCE_DIR}`);
    return;
  }

  await rmrf(TARGET_DIR);
  await fs.mkdir(TARGET_DIR, { recursive: true });

  const entries = await fs.readdir(SOURCE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !RELEASE_ID_RE.test(entry.name)) continue;
    await copyDir(path.join(SOURCE_DIR, entry.name), path.join(TARGET_DIR, entry.name));
  }

  const releases = await listReleases(SOURCE_DIR);
  await fs.writeFile(
    path.join(TARGET_DIR, 'index.json'),
    JSON.stringify(releases, null, 2) + '\n',
    'utf-8',
  );

  console.log(
    `[sync-releases] synced ${releases.length} release(s) from ${path.relative(REPO_ROOT, SOURCE_DIR)} -> ${path.relative(REPO_ROOT, TARGET_DIR)}`,
  );
}

main().catch((err) => {
  console.error('[sync-releases] failed:', err);
  process.exit(1);
});
