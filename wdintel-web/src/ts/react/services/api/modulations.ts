import type { ModulationRec } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';

export async function getModulations(): Promise<ModulationRec[]> {
  const data = await postJson<unknown>('/api/sigint/modulations-list', {});
  const normalized = transformSnakeToCamel<ModulationRec[]>(data);
  return Array.isArray(normalized) ? normalized : [];
}
