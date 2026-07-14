import { postJson } from './client';
import type { RequestOptions } from './client';
import type { InboxMessage } from '../../../../Bindings';

export type ComputerNameSearchRequest = {
  search: string;
};

export type ComputerNameResponse = {
  id: number;
  name: string;
};

export type ComputerNameSearchResponse = {
  devices: ComputerNameResponse[];
};

export type CreateComputerNameResponse = {
  device: ComputerNameResponse;
};

export async function searchComputerNames(
  search: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse[]> {
  const result = await postJson<ComputerNameSearchResponse>(
    '/api/sigint/device-name/search',
    { search },
    options,
  );
  return result?.devices || [];
}

export async function searchComputerName(
  search: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse | null> {
  const result = await postJson<ComputerNameSearchResponse>(
    '/api/sigint/device-name/search',
    { search },
    options,
  );
  return result?.devices && result.devices.length > 0 ? result.devices[0] : null;
}

export async function createComputerName(
  name: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse> {
  const result = await postJson<CreateComputerNameResponse>(
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

export type NetworkResponse = {
  id: number;
  name: string;
};

export async function searchNetworkNames(
  search: string,
  options?: RequestOptions,
): Promise<NetworkResponse[]> {
  const result = await postJson<{ networks: NetworkResponse[] }>(
    '/api/sigint/network-name/search',
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
  post?: string;
  unit?: string;
  locations?: string[];
  network?: SubmitNetwork;
  dmr?: SubmitDmrMetadata[];
  signal_group_master_key: string;
  device_name_id?: number;
  upload_urls?: string[] | null;
  deleted_media_ids?: string[];
};

export type DirectSubmitResponse = {
  signal_message_id: number;
  message?: InboxMessage;
};

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
  locations: string[];
};

export async function submitDirect(
  req: DirectSubmitRequest,
  options?: RequestOptions,
): Promise<DirectSubmitResponse> {
  return await postJson<DirectSubmitResponse>('/api/1.1/submit-direct', req, options);
}

export async function editDirectSubmit(
  id: number,
  req: DirectSubmitRequest,
  options?: RequestOptions,
): Promise<DirectSubmitResponse> {
  return await postJson<DirectSubmitResponse>(`/api/1.1/message/${id}/edit`, req, options);
}

export async function parseDirectSubmit(
  req: DirectSubmitParseRequest,
  options?: RequestOptions,
): Promise<DirectSubmitParseResponse> {
  return await postJson<DirectSubmitParseResponse>('/api/1.1/submit-direct/parse', req, options);
}
