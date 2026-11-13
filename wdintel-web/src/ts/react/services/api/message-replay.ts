import type {
  MessageReplayActivityBucket,
  MessageReplayActivityRsp,
  MessageReplayExtentRsp,
  MessageReplayPlanReq,
  MessageReplayPreviewRsp,
  MessageReplaySpeed,
  MessageReplayStatusRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type JsonBody, type RequestOptions } from './client';

const BASE_URL = '/api/admin/message-replay';

async function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await postJson<unknown>(
    `${BASE_URL}/${path}`,
    body === undefined ? undefined : transformCamelToSnake<JsonBody>(body),
    options,
  );
  return transformSnakeToCamel<T>(response);
}

export function getMessageReplayExtent(options?: RequestOptions) {
  return post<MessageReplayExtentRsp>('extent', undefined, options);
}

export function getMessageReplayActivity(
  fromMs: number,
  toMs: number,
  bucket: MessageReplayActivityBucket,
  options?: RequestOptions,
) {
  return post<MessageReplayActivityRsp>('activity', { fromMs, toMs, bucket }, options);
}

export function previewMessageReplay(plan: MessageReplayPlanReq, options?: RequestOptions) {
  return post<MessageReplayPreviewRsp>('preview', plan, options);
}

export function startMessageReplay(plan: MessageReplayPlanReq) {
  return post<MessageReplayStatusRsp>('start', plan);
}

export function getMessageReplayStatus(options?: RequestOptions) {
  return post<MessageReplayStatusRsp>('status', undefined, options);
}

export function pauseMessageReplay() {
  return post<MessageReplayStatusRsp>('pause');
}

export function resumeMessageReplay() {
  return post<MessageReplayStatusRsp>('resume');
}

export function setMessageReplaySpeed(speed: MessageReplaySpeed) {
  return post<MessageReplayStatusRsp>('speed', { speed });
}

export function stopMessageReplay() {
  return post<MessageReplayStatusRsp>('stop');
}
