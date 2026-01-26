import { readdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const packagesToPatch = [
  '@mui/material',
  '@mui/system',
  '@mui/utils',
  '@mui/icons-material',
  '@mui/x-date-pickers',
  '@mui/private-theming',
  '@mui/styled-engine',
  '@mui/styled-engine-sc',
  'material-react-table',
];

const directiveVariants = new Set(["'use client';", '"use client";']);

async function main() {
  let totalPatched = 0;

  for (const pkg of packagesToPatch) {
    const pkgPath = path.join(projectRoot, 'node_modules', ...pkg.split('/'));
    const exists = await pathExists(pkgPath);
    if (!exists) continue;

    const patched = await stripDirectiveInFolder(pkgPath);
    totalPatched += patched;
  }

  if (totalPatched > 0) {
    console.info(`[strip-use-client] removed directive from ${totalPatched} file(s)`);
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function stripDirectiveInFolder(folderPath) {
  const entries = await readdir(folderPath, { withFileTypes: true });
  let patchedCount = 0;

  for (const entry of entries) {
    const entryPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      patchedCount += await stripDirectiveInFolder(entryPath);
      continue;
    }

    if (!isJavaScriptFile(entry.name)) continue;

    const patched = await stripDirectiveInFile(entryPath);
    if (patched) patchedCount += 1;
  }

  return patchedCount;
}

function isJavaScriptFile(filename) {
  return filename.endsWith('.js') || filename.endsWith('.mjs');
}

async function stripDirectiveInFile(filePath) {
  const contents = await readFile(filePath, 'utf8');
  const lines = contents.split('\n');
  let changed = false;

  const updated = lines.filter((line, index) => {
    if (index > 8) return true;
    const trimmed = line.trim();
    if (directiveVariants.has(trimmed)) {
      changed = true;
      return false;
    }
    return true;
  });

  if (!changed) return false;

  await writeFile(filePath, updated.join('\n'));
  return true;
}

main().catch((error) => {
  console.error('[strip-use-client] failed:', error);
  process.exitCode = 1;
});
