import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const assetsDirectory = resolve('dist/assets');
export async function verifyLegacyOfficeWorkerAssets() {
  const assets = (await readdir(assetsDirectory)).filter((name) =>
    /^(?:doc|xls)-preview\.worker-[a-z0-9_-]+\.js$/i.test(name),
  );
  const docWorker = assets.find((name) => name.startsWith('doc-preview.worker-'));
  const xlsWorker = assets.find((name) => name.startsWith('xls-preview.worker-'));
  if (assets.length !== 2 || docWorker == null || xlsWorker == null)
    throw new Error(
      `Expected exactly one DOC and one XLS qualification worker, found: ${assets.join(', ')}`,
    );
  for (const asset of assets) {
    const source = await readFile(resolve(assetsDirectory, asset), 'utf8');
    if (
      /\b(?:import|importScripts|fetch|XMLHttpRequest|WebSocket|EventSource)\b|new\s+Worker\s*\(/.test(
        source,
      )
    )
      throw new Error(`${asset} is not a self-contained, network-free worker asset`);
  }
  return { assets, docWorker, xlsWorker };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { assets } = await verifyLegacyOfficeWorkerAssets();
  console.log(`Verified self-contained legacy Office worker assets: ${assets.join(', ')}`);
}
