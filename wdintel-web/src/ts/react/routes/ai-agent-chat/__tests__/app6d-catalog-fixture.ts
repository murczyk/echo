import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App6dCatalog } from '../app6d-catalog';

/** The generated catalog served from static/data in the app (vitest runs in wdintel-web). */
export const APP6D_CATALOG = JSON.parse(
  readFileSync(resolve(process.cwd(), 'static/data/app6d-catalog.json'), 'utf8'),
) as App6dCatalog;
