import type {
  SignalRestapiErrorCountsReq,
  SignalRestapiErrorCountsRsp,
  SignalRestapiErrorDayCount,
  SignalRestapiErrorLatestRsp,
  SignalRestapiErrorListReq,
  SignalRestapiErrorListRsp,
  SignalRestapiErrorRow,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';

export async function listSignalRestapiErrors(
  req: SignalRestapiErrorListReq,
): Promise<SignalRestapiErrorRow[]> {
  const raw = await postJson<unknown>(
    '/api/admin/signal-restapi-error/list',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<SignalRestapiErrorListRsp>(raw).items ?? [];
}

export async function listSignalRestapiErrorCounts(
  req: SignalRestapiErrorCountsReq,
): Promise<SignalRestapiErrorDayCount[]> {
  const raw = await postJson<unknown>(
    '/api/admin/signal-restapi-error/counts',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<SignalRestapiErrorCountsRsp>(raw).items ?? [];
}

export async function loadLatestSignalRestapiErrorCreatedAt(): Promise<string | null> {
  const raw = await postJson<unknown>('/api/admin/signal-restapi-error/latest');
  return transformSnakeToCamel<SignalRestapiErrorLatestRsp>(raw).createdAt ?? null;
}
