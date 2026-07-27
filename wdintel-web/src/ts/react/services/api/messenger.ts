import {
  AccountStatusReq,
  AccountStatsTimelineReq,
  AccountStatsTimelineRsp,
  AccountsRsp,
  DeleteAccountReq,
  IsAccountLinkedReq,
  IsAccountLinkedRsp,
  LinkAccountReq,
  LinkAccountRsp,
  LinkEchoOperatorReq,
  SystemServiceNameAvailabilityReq,
  SystemServiceNameAvailabilityRsp,
  GroupEntryF1,
  GroupUpdateReq,
  InterseptionKind,
  QrCodeReq,
  QrCodeRsp,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';

type QrCodeReqBody = {
  account_id: number;
};

type IsAccountLinkedReqBody = {
  account_id: number;
};

type AccountStatsTimelineReqBody = {
  datasource_ids: number[];
  period_hours: number | null;
};

type AccountStatusReqBody = {
  account_id: number;
  aor_id: number | null;
  is_active: boolean;
  display_name: string;
  description: string | null;
  api_login: string | null;
  api_endpoint: string | null;
};

type DeleteAccountReqBody = {
  account_id: number;
};

type LinkAccountReqBody = {
  phone: string;
  messenger: string;
  display_name: string;
  system_service_name: string;
  signal_cli_mode: string | null;
  description: string | null;
  aor_id: number;
};

type SystemServiceNameAvailabilityReqBody = {
  messenger: string;
  system_service_name: string;
};

type LinkEchoOperatorReqBody = {
  api_login: string;
  api_endpoint: string;
  display_name: string;
  description: string | null;
  aor_id: number;
};

type GroupUpdateReqBody = {
  master_key: string;
  short_note: string | null;
  long_note: string | null;
  area_of_responsibility_id: number | null;
  area_of_responsibility_ids: number[] | null;
  interseption_kind: InterseptionKind | null;
  disable_network_assignment: boolean | null;
};

type AccountStatsTimelinePointLike = {
  timestamp?: number;
  count?: number;
};

type AccountStatsTimelineEntryLike = {
  datasourceId?: number;
  datasource_id?: number;
  points?: AccountStatsTimelinePointLike[] | null;
};

type AccountStatsTimelineRspLike = {
  data?: AccountStatsTimelineEntryLike[] | null;
};

type GroupEntryF1Like = {
  masterKey?: string;
  master_key?: string;
  name?: string;
  ignoreOperativny?: boolean;
  ignore_operativny?: boolean;
  disableNetworkAssignment?: boolean;
  disable_network_assignment?: boolean;
  shortNote?: string | null;
  short_note?: string | null;
  longNote?: string | null;
  long_note?: string | null;
  groupStats?: {
    activityLastDay?: number;
    activity_last_day?: number;
    activityLastWeek?: number;
    activity_last_week?: number;
  } | null;
  group_stats?: {
    activityLastDay?: number;
    activity_last_day?: number;
    activityLastWeek?: number;
    activity_last_week?: number;
  } | null;
  areasOfResponsibility?:
    | {
        id?: number;
        name?: string;
        description?: string | null;
        isTopLevel?: boolean;
        is_top_level?: boolean;
        orderForReport?: number | string | null;
        order_for_report?: number | string | null;
        leftBound?: number | string | null;
        left_bound?: number | string | null;
        rightBound?: number | string | null;
        right_bound?: number | string | null;
        leftCoordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        left_coordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        rightCoordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        right_coordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        createdAt?: number;
        created_at?: number;
      }[]
    | null;
  areas_of_responsibility?:
    | {
        id?: number;
        name?: string;
        description?: string | null;
        isTopLevel?: boolean;
        is_top_level?: boolean;
        orderForReport?: number | string | null;
        order_for_report?: number | string | null;
        leftBound?: number | string | null;
        left_bound?: number | string | null;
        rightBound?: number | string | null;
        right_bound?: number | string | null;
        leftCoordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        left_coordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        rightCoordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        right_coordinates?: {
          latitude?: number | string | null;
          longitude?: number | string | null;
          settlement?: string | null;
        } | null;
        createdAt?: number;
        created_at?: number;
      }[]
    | null;
};
function toQrCodeReqBody(req: QrCodeReq): QrCodeReqBody {
  return { account_id: req.accountId };
}

function toIsAccountLinkedReqBody(req: IsAccountLinkedReq): IsAccountLinkedReqBody {
  return { account_id: req.accountId };
}

function toAccountStatsTimelineReqBody(req: AccountStatsTimelineReq): AccountStatsTimelineReqBody {
  return {
    datasource_ids: req.datasourceIds,
    period_hours: req.periodHours ?? null,
  };
}

function toAccountStatusReqBody(req: AccountStatusReq): AccountStatusReqBody {
  return {
    account_id: req.accountId,
    aor_id: req.aorId,
    is_active: req.isActive,
    display_name: req.displayName,
    description: req.description,
    api_login: req.apiLogin,
    api_endpoint: req.apiEndpoint,
  };
}

function normalizeAccountStatsTimelineRsp(
  raw: AccountStatsTimelineRspLike,
): AccountStatsTimelineRsp {
  return {
    data: (raw.data ?? []).map((entry) => ({
      datasourceId: entry.datasourceId ?? entry.datasource_id ?? 0,
      points: (entry.points ?? []).map((point) => ({
        timestamp: point.timestamp ?? 0,
        count: point.count ?? 0,
      })),
    })),
  };
}

function toDeleteAccountReqBody(req: DeleteAccountReq): DeleteAccountReqBody {
  return { account_id: req.accountId };
}

function toLinkAccountReqBody(req: LinkAccountReq): LinkAccountReqBody {
  return {
    phone: req.phone,
    messenger: req.messenger,
    display_name: req.displayName,
    system_service_name: req.systemServiceName,
    signal_cli_mode: req.signalCliMode ?? null,
    description: req.description,
    aor_id: req.aorId,
  };
}

function toSystemServiceNameAvailabilityReqBody(
  req: SystemServiceNameAvailabilityReq,
): SystemServiceNameAvailabilityReqBody {
  return {
    messenger: req.messenger,
    system_service_name: req.systemServiceName,
  };
}

function toLinkEchoOperatorReqBody(req: LinkEchoOperatorReq): LinkEchoOperatorReqBody {
  return {
    api_login: req.apiLogin,
    api_endpoint: req.apiEndpoint,
    display_name: req.displayName,
    description: req.description,
    aor_id: req.aorId,
  };
}

function toGroupUpdateReqBody(req: GroupUpdateReq): GroupUpdateReqBody {
  return {
    master_key: req.masterKey,
    short_note: req.shortNote ?? null,
    long_note: req.longNote ?? null,
    area_of_responsibility_id: req.areaOfResponsibilityId ?? null,
    area_of_responsibility_ids: req.areaOfResponsibilityIds ?? null,
    interseption_kind: req.interseptionKind ?? null,
    disable_network_assignment: req.disableNetworkAssignment ?? null,
  };
}

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

function normalizeCoordinates(
  raw:
    | {
        latitude?: number | string | null;
        longitude?: number | string | null;
        settlement?: string | null;
      }
    | null
    | undefined,
) {
  if (!raw) return null;
  return {
    latitude: normalizeNumber(raw.latitude),
    longitude: normalizeNumber(raw.longitude),
    settlement: raw.settlement ?? null,
  };
}

function normalizeGroupEntry(raw: GroupEntryF1Like): GroupEntryF1 {
  const groupStats = raw.groupStats ?? raw.group_stats ?? null;
  return {
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    name: raw.name ?? '',
    ignoreOperativny: raw.ignoreOperativny ?? raw.ignore_operativny ?? false,
    disableNetworkAssignment:
      raw.disableNetworkAssignment ?? raw.disable_network_assignment ?? false,
    shortNote: raw.shortNote ?? raw.short_note ?? null,
    longNote: raw.longNote ?? raw.long_note ?? null,
    groupStats: {
      activityLastDay: groupStats?.activityLastDay ?? groupStats?.activity_last_day ?? 0,
      activityLastWeek: groupStats?.activityLastWeek ?? groupStats?.activity_last_week ?? 0,
    },
    areasOfResponsibility:
      (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null)?.map((aor) => ({
        id: aor.id ?? 0,
        name: aor.name ?? '',
        description: aor.description ?? null,
        isTopLevel: aor.isTopLevel ?? aor.is_top_level ?? false,
        orderForReport: normalizeNumber(aor.orderForReport ?? aor.order_for_report ?? 100),
        leftBound: normalizeNumber(aor.leftBound ?? aor.left_bound),
        rightBound: normalizeNumber(aor.rightBound ?? aor.right_bound),
        leftCoordinates: normalizeCoordinates(aor.leftCoordinates ?? aor.left_coordinates),
        rightCoordinates: normalizeCoordinates(aor.rightCoordinates ?? aor.right_coordinates),
        createdAt: aor.createdAt ?? aor.created_at ?? 0,
      })) ?? null,
  };
}

export async function listAccounts(): Promise<AccountsRsp> {
  return postJson<AccountsRsp>('/api/messenger/list', null);
}

export async function getQrCode(req: QrCodeReq): Promise<QrCodeRsp> {
  return postJson<QrCodeRsp>('/api/messenger/qr', toQrCodeReqBody(req));
}

export async function isLinked(req: IsAccountLinkedReq): Promise<IsAccountLinkedRsp> {
  return postJson<IsAccountLinkedRsp>('/api/messenger/is-linked', toIsAccountLinkedReqBody(req));
}

export async function fetchAccountStatsTimeline(
  req: AccountStatsTimelineReq,
  signal?: AbortSignal,
): Promise<AccountStatsTimelineRsp> {
  const data = await postJson<AccountStatsTimelineRspLike>(
    '/api/messenger/accounts-stats-timeline',
    toAccountStatsTimelineReqBody(req),
    { signal },
  );
  return normalizeAccountStatsTimelineRsp(data ?? {});
}

export async function editAccount(req: AccountStatusReq): Promise<void> {
  await postVoid('/api/messenger/edit', toAccountStatusReqBody(req));
}

export async function unlinkAccount(req: DeleteAccountReq): Promise<void> {
  await postVoid('/api/messenger/unlink', toDeleteAccountReqBody(req));
}

export async function linkAccount(req: LinkAccountReq): Promise<LinkAccountRsp> {
  return postJson<LinkAccountRsp>('/api/messenger/link', toLinkAccountReqBody(req));
}

export async function getSystemServiceNameAvailability(
  req: SystemServiceNameAvailabilityReq,
  signal?: AbortSignal,
): Promise<SystemServiceNameAvailabilityRsp> {
  return postJson<SystemServiceNameAvailabilityRsp>(
    '/api/messenger/system-service-name-availability',
    toSystemServiceNameAvailabilityReqBody(req),
    { signal },
  );
}

export async function linkOperator(req: LinkEchoOperatorReq): Promise<LinkAccountRsp> {
  return postJson<LinkAccountRsp>('/api/messenger/link-operator', toLinkEchoOperatorReqBody(req));
}

export async function editGroup(req: GroupUpdateReq): Promise<GroupEntryF1> {
  const data = await postJson<GroupEntryF1Like>(
    '/api/messenger/edit-group',
    toGroupUpdateReqBody(req),
  );
  return normalizeGroupEntry(data ?? {});
}
