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
  computers: ComputerNameResponse[];
};

export type CreateComputerNameResponse = {
  computer: ComputerNameResponse;
};

export async function searchComputerNames(
  search: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse[]> {
  const result = await postJson<ComputerNameSearchResponse>(
    '/api/sigint/computer-name/search',
    { search },
    options,
  );
  return result?.computers || [];
}

export async function searchComputerName(
  search: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse | null> {
  const result = await postJson<ComputerNameSearchResponse>(
    '/api/sigint/computer-name/search',
    { search },
    options,
  );
  return result?.computers && result.computers.length > 0 ? result.computers[0] : null;
}

export async function createComputerName(
  name: string,
  options?: RequestOptions,
): Promise<ComputerNameResponse> {
  const result = await postJson<CreateComputerNameResponse>(
    '/api/sigint/computer-name/create',
    { name },
    options,
  );
  return result.computer;
}

export type CreateCyberEchoMessageRequest = {
  body: string;
  signal_group_master_key: string;
  computer_name_id: number;
  upload_urls: string[] | null;
};

export type CreateCyberEchoMessageResponse = {
  signal_message_id: number;
  message_uid: string;
  inbox_item_id: number;
  media_ids: string[];
};

export async function createCyberEchoMessage(
  req: CreateCyberEchoMessageRequest,
  options?: RequestOptions,
): Promise<CreateCyberEchoMessageResponse> {
  return await postJson<CreateCyberEchoMessageResponse>(
    '/api/sigint/cyber-echo/message/create',
    req,
    options,
  );
}
