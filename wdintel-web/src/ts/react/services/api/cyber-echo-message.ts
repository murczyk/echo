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

export type CreateCyberEchoMessageRequest = {
  message_uid?: string;
  body?: string;
  text?: string;
  freq?: string;
  coords?: SubmitCoordinates[];
  from_callsign?: string;
  to_callsigns?: string[];
  tags?: string[];
  timestamp?: string;
  full_body?: string;
  post?: string;
  unit?: string;
  locations?: string[];
  network?: SubmitNetwork;
  signal_group_master_key: string;
  device_name_id?: number;
  upload_urls?: string[] | null;
  delete_media_ids?: string[];
};

export type CreateCyberEchoMessageResponse = {
  signal_message_id: number;
  message_uid?: string;
  inbox_item_id: number;
  media_ids: string[];
};

export async function submitCyberEchoMessage(
  req: CreateCyberEchoMessageRequest,
  options?: RequestOptions,
): Promise<CreateCyberEchoMessageResponse> {
  return await postJson<CreateCyberEchoMessageResponse>(
    '/api/sigint/cyber-echo/message/submit',
    req,
    options,
  );
}
