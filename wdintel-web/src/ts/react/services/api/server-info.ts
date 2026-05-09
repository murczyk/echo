import { ServerInfo } from '../../../../Bindings';

import { postJson } from './client';

type ServerInfoLike = {
  mode?: string;
  publicHost?: string;
  public_host?: string;
  grafanaAddress?: string;
  grafana_address?: string;
  featureDelta?: boolean;
  feature_delta?: boolean;
  featureAnalysisMap?: boolean;
  feature_analysis_map?: boolean;
  featureRerDutyShortState?: boolean;
  feature_rer_duty_short_state?: boolean;
  featureStrictNetworks?: boolean;
  feature_strict_networks?: boolean;
  version?: string;
};

function normalizeServerInfo(raw: ServerInfoLike | null | undefined): ServerInfo {
  return {
    mode: raw?.mode ?? '',
    publicHost: raw?.publicHost ?? raw?.public_host ?? '',
    grafanaAddress: raw?.grafanaAddress ?? raw?.grafana_address ?? '',
    featureDelta: raw?.featureDelta ?? raw?.feature_delta ?? false,
    featureAnalysisMap: raw?.featureAnalysisMap ?? raw?.feature_analysis_map ?? false,
    featureRerDutyShortState:
      raw?.featureRerDutyShortState ?? raw?.feature_rer_duty_short_state ?? false,
    featureStrictNetworks: raw?.featureStrictNetworks ?? raw?.feature_strict_networks ?? false,
    version: raw?.version ?? '',
  };
}

export async function fetchServerInfo(signal?: AbortSignal): Promise<ServerInfo> {
  const data = await postJson<ServerInfoLike>('/api-public/server-info', {}, { signal });
  return normalizeServerInfo(data ?? {});
}
