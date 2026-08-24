import { postJson } from './client';

export type TranscriberInstance = {
  id: string;
  name: string;
  host: string;
  is_active: boolean;
  rs_port: number;
  py_port: number;
  created_at: number;
  ordering: number;
};

export type TranscriberInstanceInput = {
  name: string;
  host: string;
  rs_port: number;
  py_port: number;
  ordering: number;
};

export type TranscriberMutationResult = {
  instance: TranscriberInstance | null;
  deleted: boolean;
  restart_status: 'requested' | 'failed';
  restart_error: string | null;
};

export type TranscriberHealthProbe = {
  ok: boolean;
  status: number | null;
  error: string | null;
};

export type TranscriberInstanceHealth = {
  rust: TranscriberHealthProbe;
  python: TranscriberHealthProbe;
};

export type TranscriptionResult = {
  id: string;
  source_id: string;
  file_name: string | null;
  content_type: string | null;
  created_at: number;
  started_transcription_at: number | null;
  completion_time_seconds: number | null;
  status: string;
  transcribed_value: string | null;
  error: string | null;
  instance_id: string | null;
  instance_name: string | null;
};

export type TranscriptionResultList = {
  rows: TranscriptionResult[];
  total: number;
  has_more: boolean;
};

export async function listTranscriberInstances(): Promise<TranscriberInstance[]> {
  return postJson<TranscriberInstance[]>('/api/admin/transcriber/instances/list');
}

export async function createTranscriberInstance(
  input: TranscriberInstanceInput,
): Promise<TranscriberMutationResult> {
  return postJson<TranscriberMutationResult>('/api/admin/transcriber/instances/create', input);
}

export async function updateTranscriberInstance(
  id: string,
  input: Partial<TranscriberInstanceInput> & { is_active?: boolean },
): Promise<TranscriberMutationResult> {
  return postJson<TranscriberMutationResult>('/api/admin/transcriber/instances/update', {
    id,
    ...input,
  });
}

export async function deleteTranscriberInstance(id: string): Promise<TranscriberMutationResult> {
  return postJson<TranscriberMutationResult>('/api/admin/transcriber/instances/delete', { id });
}

export async function checkTranscriberInstance(id: string): Promise<TranscriberInstanceHealth> {
  return postJson<TranscriberInstanceHealth>('/api/admin/transcriber/instances/check', { id });
}

export async function listTranscriptionResults(
  offset: number,
  options?: { signal?: AbortSignal },
): Promise<TranscriptionResultList> {
  return postJson<TranscriptionResultList>(
    '/api/admin/transcriber/results/list',
    { offset, limit: 100 },
    options,
  );
}
