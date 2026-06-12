import type {
  ListUnitsByIdRsp,
  ListUnitsReq,
  ListUnitsRsp,
  Unit,
} from '../../../../Bindings';
import { postJson } from './client';
import { transformCamelToSnake } from '../../../snake-to-camel';

/** Fetch all units (for network display text). Single request, backend limit is 100k. */
export async function getUnitsList(): Promise<Unit[]> {
  const req: ListUnitsReq = {
    sortBy: null,
    afterUnitId: null,
    beforeUnitId: null,
  };
  const data = await postJson<ListUnitsRsp>('/api/sigint/units', transformCamelToSnake(req));
  return data?.units ?? [];
}

/** Fetch units by IDs (legacy batch; prefer getUnitsList for duty page). */
export async function getUnitsByIds(ids: number[]): Promise<Unit[]> {
  if (ids.length === 0) return [];
  const data = await postJson<ListUnitsByIdRsp>('/api/sigint/units-by-id', { ids });
  return data?.units ?? [];
}
