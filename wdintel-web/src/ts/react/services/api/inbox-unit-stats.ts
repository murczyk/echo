import type { InboxMessagesReq, UnitStatsRsp } from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function fetchInboxUnitStats(
  req: InboxMessagesReq,
  options?: RequestOptions,
): Promise<UnitStatsRsp> {
  const raw = await postJson<unknown>(
    '/api/rer-importer/get-inbox-unit-stats',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<UnitStatsRsp>(raw);
}
