import { readFile, writeFile } from 'node:fs/promises';

const effectsPath = new URL('../node_modules/elm-land/src/effects.js', import.meta.url);
const original = 'server = await createServer({\n      configFile: false,';
const configured =
  "server = await createServer({\n      configFile: join(process.cwd(), 'vite.config.ts'),";

// Elm Land's virtual HTML prevents Vite's default dependency scan. Enable the
// project's explicit scan entries before lazy imports can reload a dirty form.
const source = await readFile(effectsPath, 'utf8');
if (!source.includes(configured)) {
  if (source.split(original).length !== 2) {
    throw new Error('Elm Land dev-server changed: review the vite.config.ts integration.');
  }
  await writeFile(effectsPath, source.replace(original, configured));
}
