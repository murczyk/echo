import { postJson } from './client';
import type { RequestOptions } from './client';

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
};

export type DirectSubmitResponse = {
  signal_message_id: number;
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

export async function parseDirectSubmit(
  req: DirectSubmitParseRequest,
  options?: RequestOptions,
): Promise<DirectSubmitParseResponse> {
  return await postJson<DirectSubmitParseResponse>('/api/1.1/submit-direct/parse', req, options);
}
