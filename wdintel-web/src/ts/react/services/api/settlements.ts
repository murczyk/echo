import { postJson, type RequestOptions } from './client';

export type SettlementLanguage = 'Ua' | 'UaTranslit' | 'Ru';

export type SettlementDetails = {
  id: number | null;
  name: string;
  region: string;
  language: SettlementLanguage;
  coords: [number, number] | null;
};

export type FindSettlementPrefixParams = {
  query: string;
  relatedCoordinates: [number, number] | null;
  signalGroupMasterKey: string | null;
  signal?: AbortSignal;
};

export async function findSettlementPrefix(
  params: FindSettlementPrefixParams,
): Promise<SettlementDetails[]> {
  const options: RequestOptions | undefined = params.signal ? { signal: params.signal } : undefined;
  return postJson<SettlementDetails[]>(
    '/api/settlement/find-prefix',
    {
      query: params.query,
      region: null,
      related_coordinates: params.relatedCoordinates,
      aor_id: null,
      signal_group_master_key: params.signalGroupMasterKey,
    },
    options,
  );
}
