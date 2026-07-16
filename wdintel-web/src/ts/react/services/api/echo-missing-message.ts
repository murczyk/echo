import type {
  EchoMissingMessageCountsReq,
  EchoMissingMessageCountsRsp,
  EchoMissingMessageDayCount,
  EchoMissingMessageListReq,
  EchoMissingMessageListRsp,
  EchoMissingMessageResolveReq,
  EchoMissingMessageRow,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';

export async function listEchoMissingMessages(
  req: EchoMissingMessageListReq,
): Promise<EchoMissingMessageRow[]> {
  const raw = await postJson<unknown>(
    '/api/admin/echo-missing-message/list',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<EchoMissingMessageListRsp>(raw).items ?? [];
}

export async function listEchoMissingMessageCounts(
  req: EchoMissingMessageCountsReq,
): Promise<EchoMissingMessageDayCount[]> {
  const raw = await postJson<unknown>(
    '/api/admin/echo-missing-message/counts',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<EchoMissingMessageCountsRsp>(raw).items ?? [];
}

export async function resolveEchoMissingMessage(id: number): Promise<EchoMissingMessageRow> {
  const req: EchoMissingMessageResolveReq = { id };
  const raw = await postJson<unknown>(
    '/api/admin/echo-missing-message/resolve',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<EchoMissingMessageRow>(raw);
}
