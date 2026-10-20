import type {
  AcknowledgeGroupFeedReq,
  GroupFeedState,
  GroupFeedStatesRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { getJson, postJson } from './client';

export async function fetchGroupFeedStates(signal?: AbortSignal): Promise<GroupFeedState[]> {
  const response = await getJson<unknown>('/api/rer-importer/group-feed-state', { signal });
  return transformSnakeToCamel<GroupFeedStatesRsp>(response).groups;
}

export async function acknowledgeGroupFeedTail(
  request: AcknowledgeGroupFeedReq,
  signal?: AbortSignal,
): Promise<GroupFeedState> {
  const response = await postJson<unknown>(
    '/api/rer-importer/group-feed-state/acknowledge',
    transformCamelToSnake(request),
    { signal },
  );
  return transformSnakeToCamel<GroupFeedState>(response);
}
