import type { MessengersAccountUpdateReq, MessengersAccountsListRsp } from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, postVoid } from './client';
import type { RequestOptions } from './client';

// Read-only messengers viewer API for the analysis page, `/api/messengers`. Requires the CyberMessengers role.

export async function listMessengersAccounts(
  options?: RequestOptions,
): Promise<MessengersAccountsListRsp> {
  return transformSnakeToCamel<MessengersAccountsListRsp>(
    await postJson<unknown>('/api/messengers/accounts/list', {}, options),
  );
}

// Full state: every editable field is replaced and a null one is cleared.
export async function updateMessengersAccount(
  req: MessengersAccountUpdateReq,
  options?: RequestOptions,
): Promise<void> {
  await postVoid('/api/messengers/accounts/update', transformCamelToSnake(req), options);
}
