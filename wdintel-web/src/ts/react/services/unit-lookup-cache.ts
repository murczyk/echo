import type { Unit } from '../../../Bindings';
import type { RequestOptions } from './api/client';
import { getUnitsByIds } from './api/units';
import { unitCatalogRevision } from './unit-catalog-events';

const UNIT_LOOKUP_REQUEST_TIMEOUT_MS = 30_000;

async function loadUnitBatch(ids: number[], headers?: RequestOptions['headers']) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNIT_LOOKUP_REQUEST_TIMEOUT_MS);
  try {
    return await getUnitsByIds(ids, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Перевищено час очікування завантаження підрозділів.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForUnits(request: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return request.then(() => undefined);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    request.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function createUnitLookupCache() {
  const units = new Map<number, Unit | null>();
  const pending = new Map<number, Promise<void>>();
  let revision = unitCatalogRevision();

  return async (ids: number[], options?: RequestOptions): Promise<Unit[]> => {
    options?.signal?.throwIfAborted();
    if (revision !== unitCatalogRevision()) {
      revision = unitCatalogRevision();
      units.clear();
      pending.clear();
    }
    const requestedRevision = revision;
    const missing = [...new Set(ids)].filter((id) => !units.has(id) && !pending.has(id));
    if (missing.length > 0) {
      const request = loadUnitBatch(missing, options?.headers)
        .then((loaded) => {
          if (unitCatalogRevision() !== requestedRevision) return;
          missing.forEach((id) => units.set(id, null));
          loaded.forEach((unit) => units.set(unit.id, unit));
        })
        .finally(() => {
          missing.forEach((id) => {
            if (pending.get(id) === request) pending.delete(id);
          });
        });
      missing.forEach((id) => pending.set(id, request));
    }
    await waitForUnits(Promise.all(ids.map((id) => pending.get(id))), options?.signal);
    options?.signal?.throwIfAborted();
    if (unitCatalogRevision() !== requestedRevision) {
      throw new DOMException('Unit catalog changed', 'AbortError');
    }
    return [...new Set(ids)].flatMap((id) => units.get(id) ?? []);
  };
}
