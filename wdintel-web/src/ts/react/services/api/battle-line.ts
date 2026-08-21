import type {
  BattleLineAdminPageReq,
  BattleLineState,
  BattleLineTestRsp,
  BattleLineUnlinkedInboxRsp,
  BattleLineUnresolvedLocationsRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { getJson, postFormData, postJson, type RequestOptions } from './client';

export async function fetchBattleLineState(options?: RequestOptions): Promise<BattleLineState> {
  const raw = await getJson<unknown>('/api/battle-line', options);
  return transformSnakeToCamel<BattleLineState>(raw);
}

export async function uploadBattleLine(
  file: File,
  options?: RequestOptions,
): Promise<BattleLineState> {
  const body = new FormData();
  body.append('file', file);
  const raw = await postFormData<unknown>('/api/battle-line/upload', body, options);
  return transformSnakeToCamel<BattleLineState>(raw);
}

export async function testBattleLine(
  inboxItemId: string,
  options?: RequestOptions,
): Promise<BattleLineTestRsp> {
  const raw = await postJson<unknown>(
    '/api/battle-line/test',
    transformCamelToSnake({ inboxItemId }),
    options,
  );
  return transformSnakeToCamel<BattleLineTestRsp>(raw);
}

export async function fetchBattleLineUnlinkedInbox(
  req: BattleLineAdminPageReq,
  options?: RequestOptions,
): Promise<BattleLineUnlinkedInboxRsp> {
  const raw = await postJson<unknown>(
    '/api/battle-line/unlinked-inbox',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<BattleLineUnlinkedInboxRsp>(raw);
}

export async function fetchBattleLineUnresolvedLocations(
  req: BattleLineAdminPageReq,
  options?: RequestOptions,
): Promise<BattleLineUnresolvedLocationsRsp> {
  const raw = await postJson<unknown>(
    '/api/battle-line/unresolved-locations',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<BattleLineUnresolvedLocationsRsp>(raw);
}
