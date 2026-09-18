import { HttpRequestError, postJson } from './client';
import type { RequestOptions } from './client';
import type {
  DeviceNameResolveReq,
  DeviceNameResolveRsp,
  DeviceNameSearchResult,
  InboxMessage,
} from '../../../../Bindings';
import { normalizeInboxMessageFromWire } from './inbox-messages';

export type DeviceNameSearchRequest = {
  search: string;
};

export type DeviceNameResponse = DeviceNameSearchResult;

export type DeviceNameSearchResponse = {
  devices: DeviceNameResponse[];
};

export type CreateDeviceNameResponse = {
  device: DeviceNameResponse;
};

export async function searchDeviceNames(
  search: string,
  options?: RequestOptions,
): Promise<DeviceNameResponse[]> {
  const result = await postJson<DeviceNameSearchResponse>(
    '/api/sigint/device-name/search',
    { search },
    options,
  );
  return result?.devices || [];
}

export async function searchDeviceName(
  search: string,
  options?: RequestOptions,
): Promise<DeviceNameResponse | null> {
  const result = await postJson<DeviceNameSearchResponse>(
    '/api/sigint/device-name/search',
    { search },
    options,
  );
  return result?.devices && result.devices.length > 0 ? result.devices[0] : null;
}

export async function resolveDeviceNames(
  names: readonly string[],
  options?: RequestOptions,
): Promise<DeviceNameResponse[]> {
  const result = await postJson<DeviceNameResolveRsp>(
    '/api/sigint/device-name/resolve',
    { names: [...names] } satisfies DeviceNameResolveReq,
    options,
  );
  return result?.devices || [];
}

export async function createDeviceName(
  name: string,
  options?: RequestOptions,
): Promise<DeviceNameResponse> {
  const result = await postJson<CreateDeviceNameResponse>(
    '/api/sigint/device-name/create',
    { name },
    options,
  );
  return result.device;
}

export type PostResponse = {
  id: number;
  name: string;
};

export type PostSearchResponse = {
  posts: PostResponse[];
};

export async function searchPostNames(
  search: string,
  options?: RequestOptions,
): Promise<PostResponse[]> {
  const result = await postJson<{ posts: PostResponse[] }>(
    '/api/sigint/post-name/search',
    { search },
    options,
  );
  return result?.posts || [];
}

export type UnitResponse = {
  id: number;
  name: string;
};

export async function searchUnitNames(
  search: string,
  options?: RequestOptions,
): Promise<UnitResponse[]> {
  const result = await postJson<{ units: UnitResponse[] }>(
    '/api/sigint/unit/search',
    { search },
    options,
  );
  return result?.units || [];
}

import type { NetworkFreq } from '../../../../Bindings';

export type NetworkSearchResult = {
  id: number;
  name: string;
  unit_ids: number[] | null;
  freqs: NetworkFreq[];
};

export async function searchNetworkNames(
  search: string,
  options?: RequestOptions,
): Promise<NetworkSearchResult[]> {
  const result = await postJson<{ networks: NetworkSearchResult[] }>(
    '/api/sigint/network/search',
    { search },
    options,
  );
  return result?.networks || [];
}

export type SignalResponse = {
  id: number;
  name: string;
};

export async function searchSignalNames(
  search: string,
  options?: RequestOptions,
): Promise<SignalResponse[]> {
  const result = await postJson<{ signals: SignalResponse[] }>(
    '/api/sigint/signal-name/search',
    { search },
    options,
  );
  return result?.signals || [];
}

export type CallsignResponse = {
  id: number;
  name: string;
};

export async function searchCallsignNames(
  search: string,
  options?: RequestOptions,
): Promise<CallsignResponse[]> {
  const result = await postJson<{ callsigns: CallsignResponse[] }>(
    '/api/sigint/callsign-name/search',
    { search },
    options,
  );
  return result?.callsigns || [];
}

export type FreqResponse = {
  id: number;
  name: string;
};

export async function searchFreqs(
  search: string,
  options?: RequestOptions,
): Promise<FreqResponse[]> {
  const result = await postJson<{ freqs: FreqResponse[] }>(
    '/api/sigint/freq/search',
    { search },
    options,
  );
  return result?.freqs || [];
}

export type SubmitNetwork = {
  signal_name?: string;
  cc?: number;
  name?: string;
};

export type SubmitCoordinates = {
  lat: number;
  lon: number;
};

export type SubmitDmrMetadata = {
  timestamp: string;
  cc?: number;
  freq: string;
  signal_name: string;
  sender_id?: number;
  sender_name?: string;
  call_group_id?: number;
  call_group_name?: string;
  hash_id?: string;
};

export type DirectSubmitRequest = {
  full_body?: string;
  text?: string;
  comment?: string;
  freq?: string;
  coords?: SubmitCoordinates[];
  from?: string;
  to?: string[];
  tags?: string[];
  timestamp?: string;
  is_time_null?: InboxMessage['isTimeNull'];
  post?: string;
  unit?: string;
  locations?: string[];
  network?: SubmitNetwork;
  dmr?: SubmitDmrMetadata[];
  signal_group_master_key: string | null;
  device_name_id?: number | null;
  upload_urls?: string[] | null;
  deleted_media_ids?: string[];
  retained_media_ids?: string[];
  parent_signal_message_ids?: number[];
  copy_source_signal_message_ids?: number[];
};

export type DirectSubmitCopyResponse = {
  payloads: DirectSubmitRequest[];
};

export type DirectSubmitResponse = {
  signal_message_id: number;
  message?: InboxMessage;
};

export type DirectSubmitResponseRaw = {
  signal_message_id: number;
  message?: unknown | null;
};

function normalizeDirectSubmitResponse(raw: DirectSubmitResponseRaw): DirectSubmitResponse {
  return {
    signal_message_id: raw.signal_message_id,
    ...(raw.message == null ? {} : { message: normalizeInboxMessageFromWire(raw.message) }),
  };
}

export type DirectSubmitParseRequest = {
  full_body: string;
  signal_group_master_key?: string;
};

export type DirectSubmitParseResponse = {
  text: string;
  freq?: string;
  coords: SubmitCoordinates[];
  to: string[];
  timestamp?: string;
  comment?: string;
  post?: string;
  unit?: string;
  unit_v2?: string;
  locations: string[];
};

export function formatDirectSubmitError(
  error: unknown,
  action: 'copy' | 'delete' | 'parse' | 'save',
): string {
  const fallback =
    action === 'parse'
      ? 'Не вдалося розпізнати повідомлення. Спробуйте ще раз.'
      : action === 'copy'
        ? 'Не вдалося підготувати розвіддонесення. Спробуйте ще раз.'
        : action === 'delete'
          ? 'Не вдалося видалити розвіддонесення. Спробуйте ще раз.'
          : 'Не вдалося зберегти повідомлення. Спробуйте ще раз.';

  if (!(error instanceof HttpRequestError)) {
    return error instanceof Error && error.message.trim() ? error.message : fallback;
  }

  if (error.status === 0) return error.message;
  if (error.message.trim() && error.message !== 'Internal server error') return error.message;
  return `${fallback} Якщо помилка повторюється, зверніться до адміністратора.`;
}

export async function copyDirectSubmit(
  ids: number[],
  options?: RequestOptions,
): Promise<DirectSubmitCopyResponse> {
  return await postJson<DirectSubmitCopyResponse>(
    '/api/1.1/messages/copy',
    { message_ids: ids },
    options,
  );
}

export async function submitDirect(
  req: DirectSubmitRequest,
  options?: RequestOptions,
): Promise<DirectSubmitResponse> {
  const raw = await postJson<DirectSubmitResponseRaw>('/api/1.1/submit-direct', req, options);
  return normalizeDirectSubmitResponse(raw);
}

export async function editDirectSubmit(
  id: number,
  req: DirectSubmitRequest,
  options?: RequestOptions,
): Promise<DirectSubmitResponse> {
  const raw = await postJson<DirectSubmitResponseRaw>(`/api/1.1/message/${id}/edit`, req, options);
  return normalizeDirectSubmitResponse(raw);
}

export async function parseDirectSubmit(
  req: DirectSubmitParseRequest,
  options?: RequestOptions,
): Promise<DirectSubmitParseResponse> {
  return await postJson<DirectSubmitParseResponse>('/api/1.1/submit-direct/parse', req, options);
}
