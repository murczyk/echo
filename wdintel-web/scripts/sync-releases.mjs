#!/usr/bin/env node
/**
 * Thin sync wrapper: mirror docs/releases to wdintel-web/static/releases.
 *
 * Source of truth stays in docs/releases (same as docs site content),
 * frontend reads from /releases/* served by Elm Land static directory.
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

async function main() {
  if (!(await exists(SOURCE_DIR))) {
    console.warn(`[sync-releases] source dir not found: ${SOURCE_DIR}`);
    return;
  }

  const sourceIndex = path.join(SOURCE_DIR, 'index.json');
  if (!(await exists(sourceIndex))) {
    throw new Error(
      `[sync-releases] source index is missing: ${path.relative(REPO_ROOT, sourceIndex)}`,
    );
  }

  await rmrf(TARGET_DIR);
  await fs.cp(SOURCE_DIR, TARGET_DIR, { recursive: true });

  console.log(
    `[sync-releases] mirrored ${path.relative(REPO_ROOT, SOURCE_DIR)} -> ${path.relative(REPO_ROOT, TARGET_DIR)}`,
  );
}

main().catch((err) => {
  console.error('[sync-releases] failed:', err);
  process.exit(1);
});
