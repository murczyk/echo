import type { MessageRepliesReq, MessageRepliesRsp } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function fetchMessageReplies(
  request: MessageRepliesReq,
  options?: RequestOptions,
): Promise<MessageRepliesRsp> {
  const response = await postJson<unknown>(
    '/api/rer-importer/message-replies',
    { signal_message_ids: request.signalMessageIds, screen: request.screen },
    options,
  );
  return transformSnakeToCamel<MessageRepliesRsp>(response);
}
