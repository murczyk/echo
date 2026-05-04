import {
  GoiAssociation,
  ListGoiAssociationsReq,
  ListGoiAssociationsRsp,
} from '../../../../Bindings';

import { postJson } from './client';
import { isNullOrUndefined } from '../../utils/misc';

type GoiAssociationLike = {
  id?: number | string;
  integrationId?: number | string;
  integration_id?: number | string;
  serverLabel?: string | null;
  server_label?: string | null;
  ownerOrganismName?: string | null;
  owner_organism_name?: string | null;
  sourceAssociationId?: number | string;
  source_association_id?: number | string;
  sourceCreatedAtMs?: number | string;
  source_created_at_ms?: number | string;
  createdAtMs?: number | string;
  created_at_ms?: number | string;
  deleted?: boolean;
  associationType?: string | null;
  association_type?: string | null;
  frequency?: string | null;
  coordinates?: string | null;
  note?: string | null;
  category?: string | null;
  callSigns?: string[] | null;
  call_signs?: string[] | null;
  formation?: string | null;
  associationCount?: number | string | null;
  association_count?: number | string | null;
  sidc?: string | null;
  author?: string | null;
  sourceDateRaw?: string | null;
  source_date_raw?: string | null;
  sourceDateMs?: number | string | null;
  source_date_ms?: number | string | null;
};

type ListGoiAssociationsReqBody = {
  limit: number | null;
  offset: number | null;
  sort_by: ListGoiAssociationsReq['sortBy'];
  filter_text: string | null;
  filter_server: string | null;
  filter_frequency: string | null;
  filter_coordinates: string | null;
  filter_note: string | null;
  filter_category: string | null;
  filter_author: string | null;
  filter_deleted: boolean | null;
};

type ListGoiAssociationsRspLike = {
  items?: GoiAssociationLike[] | null;
  hasMore?: boolean;
  has_more?: boolean;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeOptionalNumber(
  value: number | string | null | undefined,
): number | null {
  if (isNullOrUndefined(value)) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeStringArray(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGoiAssociation(raw: GoiAssociationLike | null | undefined): GoiAssociation {
  return {
    id: normalizeNumber(raw?.id),
    integrationId: normalizeNumber(raw?.integrationId ?? raw?.integration_id),
    serverLabel: normalizeOptionalString(raw?.serverLabel ?? raw?.server_label) ?? '',
    ownerOrganismName:
      normalizeOptionalString(
        raw?.ownerOrganismName ?? raw?.owner_organism_name,
      ) ?? '',
    sourceAssociationId: normalizeNumber(
      raw?.sourceAssociationId ?? raw?.source_association_id,
    ),
    sourceCreatedAtMs: normalizeNumber(
      raw?.sourceCreatedAtMs ?? raw?.source_created_at_ms,
    ),
    createdAtMs: normalizeNumber(raw?.createdAtMs ?? raw?.created_at_ms),
    deleted: raw?.deleted ?? false,
    associationType: normalizeOptionalString(
      raw?.associationType ?? raw?.association_type,
    ),
    frequency: normalizeOptionalString(raw?.frequency),
    coordinates: normalizeOptionalString(raw?.coordinates),
    note: normalizeOptionalString(raw?.note),
    category: normalizeOptionalString(raw?.category),
    callSigns: normalizeStringArray(raw?.callSigns ?? raw?.call_signs),
    formation: normalizeOptionalString(raw?.formation),
    associationCount: normalizeOptionalNumber(
      raw?.associationCount ?? raw?.association_count,
    ),
    sidc: normalizeOptionalString(raw?.sidc),
    author: normalizeOptionalString(raw?.author),
    sourceDateRaw: normalizeOptionalString(
      raw?.sourceDateRaw ?? raw?.source_date_raw,
    ),
    sourceDateMs: normalizeOptionalNumber(
      raw?.sourceDateMs ?? raw?.source_date_ms,
    ),
  };
}

function toListGoiAssociationsReqBody(
  req: ListGoiAssociationsReq,
): ListGoiAssociationsReqBody {
  const normalizeOptionalText = (value: string | null | undefined) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    limit: req.limit ?? null,
    offset: req.offset ?? null,
    sort_by: req.sortBy ?? null,
    filter_text: normalizeOptionalText(req.filterText),
    filter_server: normalizeOptionalText(req.filterServer),
    filter_frequency: normalizeOptionalText(req.filterFrequency),
    filter_coordinates: normalizeOptionalText(req.filterCoordinates),
    filter_note: normalizeOptionalText(req.filterNote),
    filter_category: normalizeOptionalText(req.filterCategory),
    filter_author: normalizeOptionalText(req.filterAuthor),
    filter_deleted: req.filterDeleted ?? null,
  };
}

export async function listCurrentUserGoiAssociations(
  req: ListGoiAssociationsReq,
  signal?: AbortSignal,
): Promise<ListGoiAssociationsRsp> {
  const data = await postJson<ListGoiAssociationsRspLike>(
    '/api/goi/associations',
    toListGoiAssociationsReqBody(req),
    { signal },
  );

  return {
    items: (data?.items ?? []).map(normalizeGoiAssociation),
    hasMore: data?.hasMore ?? data?.has_more ?? false,
  };
}
