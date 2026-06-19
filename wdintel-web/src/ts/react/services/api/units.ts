import type {
  ListUnitsByIdRsp,
  ListUnitsReq,
  ListUnitsRsp,
  Unit,
} from '../../../../Bindings';
import { postJson } from './client';
import type { RequestOptions } from './client';
import { transformCamelToSnake } from '../../../snake-to-camel';

/** Fetch all units (for network display text). Single request, backend limit is 100k. */
export async function getUnitsList(options?: RequestOptions): Promise<Unit[]> {
  const req: ListUnitsReq = {
    sortBy: null,
    afterUnitId: null,
    beforeUnitId: null,
  };
  const data = options == null
    ? await postJson<ListUnitsRsp>('/api/sigint/units', transformCamelToSnake(req))
    : await postJson<ListUnitsRsp>('/api/sigint/units', transformCamelToSnake(req), options);
  return data?.units ?? [];
}

/** Fetch units by IDs (legacy batch; prefer getUnitsList for duty page). */
export async function getUnitsByIds(ids: number[], options?: RequestOptions): Promise<Unit[]> {
  if (ids.length === 0) return [];
  const data = options == null
    ? await postJson<ListUnitsByIdRsp>('/api/sigint/units-by-id', { ids })
    : await postJson<ListUnitsByIdRsp>('/api/sigint/units-by-id', { ids }, options);
  return data?.units ?? [];
}
