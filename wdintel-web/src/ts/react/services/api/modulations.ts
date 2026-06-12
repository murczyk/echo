import type { EncryptionRec } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';

export async function getEncryptions(): Promise<EncryptionRec[]> {
  const data = await postJson<unknown>('/api/sigint/encryptions-list', {});
  const normalized = transformSnakeToCamel<EncryptionRec[]>(data);
  return Array.isArray(normalized) ? normalized : [];
}
