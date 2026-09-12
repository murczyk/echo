import type {
  AddNetworkFreqReq,
  CreateEncryptionKeyReq,
  CreateNetworkReq,
  AddNetworkDescriptionsReq,
  DeleteNetworkDescriptionReq,
  DeleteNetworkFreqReq,
  EtalonkaJimForksReq,
  EtalonkaNetworkBatchReq,
  EtalonkaReportType,
  ListNetworksReq,
  ListNetworksRsp,
  ListKeysReq,
  Network,
  NetworkGroupsActivityOneReq,
  ListNetworkPointsReq,
  ListNetworkPointsRsp,
  NetworkFreqCallsignsReq,
  NetworkFreqCallsignsBatchReq,
  NetworkFreqCallsignsBatchRsp,
  NetworkFreqCallsignsPeriod,
  NetworkGroupActivityPeriod,
  NetworkFreqsActivityReq,
  NetworkFreqsRes,
  ReactivateNetworkFreqReq,
  SingleNetworkFreqsListRsp,
  SingleNetworkFreqsReq,
  ListKeysRsp,
  SingleNetworkCallsignsListRsp,
  NetworkCallsignRelationsReq,
  NetworkCallsignRelationsRsp,
  NetworkCallsignRelationMessagesReq,
  NetworkCallsignRelationMessagesRsp,
  NetworkGroupsActivityReq,
  UpdateNetworkDescriptionReq,
  UpdateNetworkFreqReq,
  UpdateNetworkPostsReq,
  UpdateNetworkReq,
  UpdateNetworkUnitsReq,
  EncryptionKeyData,
} from '../../../../Bindings';
import { postBytes, postJson } from './client';
import type { RequestOptions } from './client';
import { downloadReportHistory } from './report-history';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

export async function listNetworks(
  req: ListNetworksReq,
  options?: RequestOptions,
): Promise<ListNetworksRsp> {
  const data = await postJson<ListNetworksRsp>(
    '/api/sigint/network-list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListNetworksRsp>(data);
}

/** Fetch all networks. Uses a filter so the backend returns full list without default limit. */
export async function getNetworksList(options?: RequestOptions): Promise<Network[]> {
  const req: ListNetworksReq = {
    filterFreq: null,
    filterUnit: null,
    filterUnitArmyRegion: null,
    filterUnitMilitaryDistrict: null,
    filterUnitArmy: null,
    filterUnitCorps: null,
    filterUnitDivision: null,
    filterUnitBrigade: null,
    filterUnitRegiment: null,
    filterUnitBattalion: null,
    filterUnitCompany: null,
    filterUnitPlatoon: null,
    filterUnitSquad: null,
    filterUnitSection: null,
    filterUnitTeamOrCrew: null,
    filterUnitOther: null,
    filterText: '',
    filterName: null,
    filterLocation: null,
    showOnlyFurtherInverstigation: null,
    showInactive: true,
    showOnlyDeleted: false,
    statusFilter: null,
    aorIds: null,
    ids: null,
    limit: null,
    offset: null,
    sortBy: ['NameAsc'],
  };
  const data = await listNetworks(req, options);
  return data.list ?? [];
}

/** Fetch networks by IDs */
export async function getNetworksByIds(
  ids: number[],
  options?: RequestOptions,
): Promise<Network[]> {
  if (ids.length === 0) return [];
  const data = await postJson<Network[]>('/api/sigint/network-info-batch-id', ids, options);
  if (!Array.isArray(data)) return [];
  return data.map((row) => transformSnakeToCamel<Network>(row));
}

export async function getNetworkById(id: number): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network-info-one', id);
  return transformSnakeToCamel<Network>(data);
}

export async function getNetworkCallsignsList(
  networkId: number,
  includeActivityInfo = true,
): Promise<SingleNetworkCallsignsListRsp> {
  const data = await postJson<SingleNetworkCallsignsListRsp>('/api/sigint/network-callsigns-list', {
    network_id: networkId,
    include_activity_info: includeActivityInfo,
  });
  return transformSnakeToCamel<SingleNetworkCallsignsListRsp>(data);
}

export async function getSingleNetworkFreqs(
  networkId: number,
  includeCallsigns = true,
  includeLastDatetimeInAor = true,
): Promise<SingleNetworkFreqsListRsp> {
  const data = await postJson<SingleNetworkFreqsListRsp>(
    '/api/sigint/network-freqs-list',
    transformCamelToSnake({
      networkId,
      includeCallsigns,
      includeLastDatetimeInAor,
    } satisfies SingleNetworkFreqsReq),
  );
  return transformSnakeToCamel<SingleNetworkFreqsListRsp>(data);
}

export async function getNetworkFreqsActivity(
  networkId: number,
): Promise<Record<string, Record<string, number>>> {
  const data = await postJson<Record<string, Record<string, number>>>(
    '/api/sigint/network-freqs-activity-one',
    transformCamelToSnake({
      networkId,
    } satisfies NetworkFreqsActivityReq),
  );
  return transformSnakeToCamel<Record<string, Record<string, number>>>(data);
}

export async function getNetworkGroupsActivityOne(
  networkId: number,
  period: NetworkGroupActivityPeriod = 'Last10Days',
): Promise<Record<string, Record<string, number>>> {
  const data = await postJson<Record<string, Record<string, number>>>(
    '/api/sigint/network-group-activity-one',
    transformCamelToSnake({
      networkId,
      tillDateNoninclusiveMs: null,
      period,
    } satisfies NetworkGroupsActivityOneReq),
  );
  return data;
}

export async function getNetworksGroupsActivity(
  req: NetworkGroupsActivityReq,
  options?: RequestOptions,
): Promise<Record<string, Record<string, Record<string, number>>>> {
  const data = await postJson<Record<string, Record<string, Record<string, number>>>>(
    '/api/sigint/network-group-activity',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<Record<string, Record<string, Record<string, number>>>>(data);
}

export async function getNetworkUnitStats(): Promise<Array<{ unitId: number; count: number }>> {
  const data = await postJson<{ units: Array<{ unit_id: number; count: number }> }>(
    '/api/sigint/network/unit-stats',
  );
  const normalized = transformSnakeToCamel<{ units: Array<{ unitId: number; count: number }> }>(
    data,
  );
  return normalized.units ?? [];
}

export async function listNetworkPoints(req: ListNetworkPointsReq): Promise<ListNetworkPointsRsp> {
  const data = await postJson<ListNetworkPointsRsp>(
    '/api/sigint/network-points',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<ListNetworkPointsRsp>(data);
}

export async function getNetworkFreqCallsigns(
  networkFreqId: number,
  period: NetworkFreqCallsignsPeriod,
): Promise<string[]> {
  const data = await postJson<{ networkFreqId: number; callsigns: string[] }>(
    '/api/sigint/network-freq-callsigns',
    transformCamelToSnake({
      networkFreqId,
      period,
    } satisfies NetworkFreqCallsignsReq),
  );
  const normalized = transformSnakeToCamel<{ networkFreqId: number; callsigns: string[] }>(data);
  return normalized.callsigns ?? [];
}

export async function getNetworkFreqCallsignsBatch(
  networkFreqIds: number[],
  period: NetworkFreqCallsignsPeriod,
): Promise<Map<number, string[]>> {
  if (networkFreqIds.length === 0) {
    return new Map();
  }

  const data = await postJson<NetworkFreqCallsignsBatchRsp>(
    '/api/sigint/network-freq-callsigns-batch',
    transformCamelToSnake({
      networkFreqIds,
      period,
    } satisfies NetworkFreqCallsignsBatchReq),
  );
  const normalized = transformSnakeToCamel<NetworkFreqCallsignsBatchRsp>(data);
  const callsignsByNetworkFreqId = normalized.callsignsByNetworkFreqId ?? {};

  return new Map(
    Object.entries(callsignsByNetworkFreqId)
      .map(([networkFreqId, callsigns]) => {
        const parsedNetworkFreqId = Number(networkFreqId);
        return Number.isFinite(parsedNetworkFreqId)
          ? [parsedNetworkFreqId, Array.isArray(callsigns) ? callsigns : []]
          : null;
      })
      .filter((entry): entry is [number, string[]] => entry !== null),
  );
}

export async function getNetworkCallsignRelations(
  req: NetworkCallsignRelationsReq,
  options?: RequestOptions,
): Promise<NetworkCallsignRelationsRsp> {
  const data = await postJson<NetworkCallsignRelationsRsp>(
    '/api/sigint/network-callsigns/relations',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<NetworkCallsignRelationsRsp>(data);
}

export async function getNetworkCallsignRelationMessages(
  req: NetworkCallsignRelationMessagesReq,
  options?: RequestOptions,
): Promise<NetworkCallsignRelationMessagesRsp> {
  const data = await postJson<NetworkCallsignRelationMessagesRsp>(
    '/api/sigint/network-callsigns/relations/messages',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<NetworkCallsignRelationMessagesRsp>(data);
}

export async function addFreqToNetwork(req: AddNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/add-freq', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export type NetworkFreqMutationV2Rsp = {
  network: Network;
  freq: NetworkFreqsRes | null;
};

export async function addFreqToNetworkV2(
  req: AddNetworkFreqReq,
): Promise<NetworkFreqMutationV2Rsp> {
  const data = await postJson<NetworkFreqMutationV2Rsp>(
    '/api/sigint/network/v2/add-freq',
    transformCamelToSnake(req),
    undefined,
  );
  return transformSnakeToCamel<NetworkFreqMutationV2Rsp>(data);
}

export async function updateNetworkFreq(req: UpdateNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/update-freq',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkFreqV2(
  req: UpdateNetworkFreqReq,
): Promise<NetworkFreqMutationV2Rsp> {
  const data = await postJson<NetworkFreqMutationV2Rsp>(
    '/api/sigint/network/v2/update-freq',
    transformCamelToSnake(req),
    undefined,
  );
  return transformSnakeToCamel<NetworkFreqMutationV2Rsp>(data);
}

export async function deleteNetworkFreq(req: DeleteNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/delete-freq',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function reactivateNetworkFreq(req: ReactivateNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/reactivate-freq',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function listKeys(req: ListKeysReq): Promise<ListKeysRsp> {
  const data = await postJson<ListKeysRsp>('/api/sigint/keys', transformCamelToSnake(req));
  return transformSnakeToCamel<ListKeysRsp>(data);
}

export async function createKey(req: CreateEncryptionKeyReq): Promise<EncryptionKeyData> {
  const data = await postJson<EncryptionKeyData>(
    '/api/sigint/keys/create',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<EncryptionKeyData>(data);
}

export async function deleteNetwork(networkId: number): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/delete-network', { network_id: networkId });
  return transformSnakeToCamel<Network>(data);
}

export async function createNetwork(req: CreateNetworkReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/create-network', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

function toEtalonkaReportTypeBody(etalonkaType: EtalonkaReportType) {
  if ('AccordingToTheForm' in etalonkaType) {
    return {
      AccordingToTheForm: {
        active_freqs_only: etalonkaType.AccordingToTheForm.activeFreqsOnly,
        include_callsign_full_names: etalonkaType.AccordingToTheForm.includeCallsignFullNames,
        include_sigint_signs: etalonkaType.AccordingToTheForm.includeSigintSigns,
        include_confirmation: etalonkaType.AccordingToTheForm.includeConfirmation,
        include_headings_and_freqs: etalonkaType.AccordingToTheForm.includeHeadingsAndFreqs,
      },
    };
  }

  return {
    ExtendedReport: {
      since_date_inclusive_ms: etalonkaType.ExtendedReport.sinceDateInclusiveMs,
      till_date_inclusive_ms: etalonkaType.ExtendedReport.tillDateInclusiveMs,
      active_freqs_only: etalonkaType.ExtendedReport.activeFreqsOnly,
      include_freq_active_from: etalonkaType.ExtendedReport.includeFreqActiveFrom,
      include_freq_created_at: etalonkaType.ExtendedReport.includeFreqCreatedAt,
      include_callsign_full_names: etalonkaType.ExtendedReport.includeCallsignFullNames,
      include_unit_callsigns: etalonkaType.ExtendedReport.includeUnitCallsigns,
      include_sigint_signs: etalonkaType.ExtendedReport.includeSigintSigns,
      include_confirmation: etalonkaType.ExtendedReport.includeConfirmation,
      include_pelengs_map: etalonkaType.ExtendedReport.includePelengsMap,
      include_headings_and_freqs: etalonkaType.ExtendedReport.includeHeadingsAndFreqs,
    },
  };
}

export async function launchNetworksEtalonkaReportTask(req: EtalonkaJimForksReq): Promise<number> {
  const body = transformCamelToSnake(req) as Record<string, unknown>;
  body.etalonka_type = toEtalonkaReportTypeBody(req.etalonkaType);
  return postJson<number>('/api/sigint/etalonka/report-networks-task-launch', body as any);
}

export async function launchNetworkEtalonkaBatchReportTask(
  req: EtalonkaNetworkBatchReq,
): Promise<number> {
  const body = transformCamelToSnake(req) as Record<string, unknown>;
  body.etalonka_type = toEtalonkaReportTypeBody(req.etalonkaType);
  return postJson<number>('/api/sigint/etalonka/report-networks-batch-id-task-launch', body as any);
}

export async function downloadNetworkEtalonkaReportTaskResult(taskId: number): Promise<Blob> {
  return downloadReportHistory(taskId);
}

export async function launchNetworkGoiReportTask(): Promise<number> {
  return postJson<number>('/api/sigint/network/report-networks-goi-task-launch');
}

export async function updateNetworkPosts(req: UpdateNetworkPostsReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/update-posts',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkUnits(req: UpdateNetworkUnitsReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/update-units',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetwork(req: UpdateNetworkReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/update-network', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function addNetworkDescriptions(req: AddNetworkDescriptionsReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/add-descriptions',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkDescription(req: UpdateNetworkDescriptionReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/update-description',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}

export async function deleteNetworkDescription(req: DeleteNetworkDescriptionReq): Promise<Network> {
  const data = await postJson<Network>(
    '/api/sigint/network/delete-description',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Network>(data);
}
