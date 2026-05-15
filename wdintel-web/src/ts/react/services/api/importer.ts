import type { DownloadKmzReq, RowInfo, UploadPdfRes, UploadScreenshotRes } from '../../../../Bindings';
import { emitUnauthorizedEvent } from '../../auth-redirect';
import { HttpRequestError, postBytes } from './client';

type RowInfoBody = {
  content: string;
  image_urls: string[];
  lat: string;
  lng: string;
  title: string;
  icon: string;
};

type DownloadKmzReqBody = {
  rows: RowInfoBody[];
  folder_name: string;
};

type UploadScreenshotResRaw = {
  image_url?: string;
  imageUrl?: string;
};

type UploadPdfResRaw = {
  rows?: RowInfoBody[];
};

function toRowInfoBody(row: RowInfo): RowInfoBody {
  return {
    content: row.content,
    image_urls: row.imageUrls,
    lat: row.lat,
    lng: row.lng,
    title: row.title,
    icon: row.icon,
  };
}

function toDownloadKmzReqBody(req: DownloadKmzReq): DownloadKmzReqBody {
  return {
    rows: req.rows.map(toRowInfoBody),
    folder_name: req.folderName,
  };
}

function normalizeRowInfo(row: RowInfoBody): RowInfo {
  return {
    content: row.content,
    imageUrls: row.image_urls ?? [],
    lat: row.lat,
    lng: row.lng,
    title: row.title,
    icon: row.icon,
  };
}

function normalizeUploadScreenshotRes(raw: UploadScreenshotResRaw | undefined): UploadScreenshotRes {
  return {
    imageUrl: raw?.imageUrl ?? raw?.image_url ?? '',
  };
}

function normalizeUploadPdfRes(raw: UploadPdfResRaw | undefined): UploadPdfRes {
  return {
    rows: (raw?.rows ?? []).map(normalizeRowInfo),
  };
}

function formatErrorMessage(status: number, text: string): string {
  if (text.trim().length > 0) return text;
  return `HTTP ${status}`;
}

async function requestMultipart<T>(
  method: 'PUT' | 'POST',
  url: string,
  formData: FormData,
  normalize: (raw: any) => T,
): Promise<T> {
  const response = await fetch(url, {
    method,
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    throw new HttpRequestError(response.status, formatErrorMessage(response.status, await response.text()));
  }

  if (response.status === 204) return normalize(undefined);

  const text = await response.text();
  if (!text.trim()) return normalize(undefined);

  return normalize(JSON.parse(text));
}

export async function downloadImporterKmz(req: DownloadKmzReq): Promise<Blob> {
  return postBytes('/api/importer/download/operatyvka.kmz', toDownloadKmzReqBody(req) as any);
}

export async function downloadImporterGeojson(req: DownloadKmzReq): Promise<Blob> {
  return postBytes('/api/delta/download/operatyvka.geojson', toDownloadKmzReqBody(req) as any);
}

export async function uploadImporterScreenshot(image: File | Blob): Promise<UploadScreenshotRes> {
  const formData = new FormData();
  if (image instanceof File) {
    formData.append('image', image);
  } else {
    formData.append('image', image, 'image.png');
  }
  return requestMultipart('PUT', '/api/terminal/upload-screenshot', formData, normalizeUploadScreenshotRes);
}

export async function uploadImporterPdf(file: File): Promise<UploadPdfRes> {
  const formData = new FormData();
  formData.append('image', file);
  return requestMultipart('PUT', '/api/terminal/upload-pdf', formData, normalizeUploadPdfRes);
}
