import type { SignalMediaKmzConversionStatusRsp } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { getJson, postJson, type RequestOptions } from './client';

function conversionUrl(mediaId: string, action: string): string {
  return `/api/messenger/media/${encodeURIComponent(mediaId)}/kmz-conversion/${action}`;
}

export async function getKmzAttachmentConversionStatus(
  mediaId: string,
  options?: RequestOptions,
): Promise<SignalMediaKmzConversionStatusRsp> {
  const response = await getJson<unknown>(conversionUrl(mediaId, 'status'), options);
  return transformSnakeToCamel<SignalMediaKmzConversionStatusRsp>(response);
}

export async function retryKmzAttachmentConversion(
  mediaId: string,
  options?: RequestOptions,
): Promise<SignalMediaKmzConversionStatusRsp> {
  const response = await postJson<unknown>(conversionUrl(mediaId, 'retry'), {}, options);
  return transformSnakeToCamel<SignalMediaKmzConversionStatusRsp>(response);
}

export function kmzAttachmentConversionDownloadUrl(mediaId: string): string {
  return conversionUrl(mediaId, 'download');
}

export function kmzAttachmentConversionArchiveUrl(mediaId: string): string {
  return conversionUrl(mediaId, 'archive.zip');
}
