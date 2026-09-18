import type {
  SignalMediaKmzConversionStatusRsp,
  SignalMediaKmzPreviewRsp,
} from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { getJson, type RequestOptions } from './client';

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

export async function getKmzAttachmentPreview(
  mediaId: string,
  options?: RequestOptions,
): Promise<SignalMediaKmzPreviewRsp> {
  const response = await getJson<unknown>(conversionUrl(mediaId, 'preview'), options);
  return transformSnakeToCamel<SignalMediaKmzPreviewRsp>(response);
}

export function kmzAttachmentConversionDownloadUrl(mediaId: string): string {
  return conversionUrl(mediaId, 'download');
}
