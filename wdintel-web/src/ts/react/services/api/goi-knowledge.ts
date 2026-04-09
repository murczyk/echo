import {
  GoiKnowledge,
  ListGoiKnowledgeReq,
  ListGoiKnowledgeRsp,
} from '../../../../Bindings';

import { postJson } from './client';

type GoiKnowledgeLike = {
  id?: number | string;
  integrationId?: number | string;
  integration_id?: number | string;
  serverLabel?: string | null;
  server_label?: string | null;
  ownerOrganismName?: string | null;
  owner_organism_name?: string | null;
  sourceKnowledgeId?: number | string;
  source_knowledge_id?: number | string;
  sourceCreatedAtMs?: number | string;
  source_created_at_ms?: number | string;
  createdAtMs?: number | string;
  created_at_ms?: number | string;
  deleted?: boolean;
  name?: string | null;
  key?: string | null;
  knowledgeType?: string | null;
  knowledge_type?: string | null;
  author?: string | null;
  note?: string | null;
  sourceDateRaw?: string | null;
  source_date_raw?: string | null;
  sourceDateMs?: number | string | null;
  source_date_ms?: number | string | null;
  formation?: string | null;
};

type ListGoiKnowledgeReqBody = {
  limit: number | null;
  offset: number | null;
  sort_by: ListGoiKnowledgeReq['sortBy'];
  filter_text: string | null;
  filter_server: string | null;
  filter_name: string | null;
  filter_key: string | null;
  filter_knowledge_type: string | null;
  filter_note: string | null;
  filter_author: string | null;
  filter_formation: string | null;
  filter_deleted: boolean | null;
};

type ListGoiKnowledgeRspLike = {
  items?: GoiKnowledgeLike[] | null;
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
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGoiKnowledge(raw: GoiKnowledgeLike | null | undefined): GoiKnowledge {
  return {
    id: normalizeNumber(raw?.id),
    integrationId: normalizeNumber(raw?.integrationId ?? raw?.integration_id),
    serverLabel: normalizeOptionalString(raw?.serverLabel ?? raw?.server_label) ?? '',
    ownerOrganismName:
      normalizeOptionalString(
        raw?.ownerOrganismName ?? raw?.owner_organism_name,
      ) ?? '',
    sourceKnowledgeId: normalizeNumber(
      raw?.sourceKnowledgeId ?? raw?.source_knowledge_id,
    ),
    sourceCreatedAtMs: normalizeNumber(
      raw?.sourceCreatedAtMs ?? raw?.source_created_at_ms,
    ),
    createdAtMs: normalizeNumber(raw?.createdAtMs ?? raw?.created_at_ms),
    deleted: raw?.deleted ?? false,
    name: normalizeOptionalString(raw?.name),
    key: normalizeOptionalString(raw?.key),
    knowledgeType: normalizeOptionalString(
      raw?.knowledgeType ?? raw?.knowledge_type,
    ),
    author: normalizeOptionalString(raw?.author),
    note: normalizeOptionalString(raw?.note),
    sourceDateRaw: normalizeOptionalString(
      raw?.sourceDateRaw ?? raw?.source_date_raw,
    ),
    sourceDateMs: normalizeOptionalNumber(
      raw?.sourceDateMs ?? raw?.source_date_ms,
    ),
    formation: normalizeOptionalString(raw?.formation),
  };
}

function toListGoiKnowledgeReqBody(
  req: ListGoiKnowledgeReq,
): ListGoiKnowledgeReqBody {
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
    filter_name: normalizeOptionalText(req.filterName),
    filter_key: normalizeOptionalText(req.filterKey),
    filter_knowledge_type: normalizeOptionalText(req.filterKnowledgeType),
    filter_note: normalizeOptionalText(req.filterNote),
    filter_author: normalizeOptionalText(req.filterAuthor),
    filter_formation: normalizeOptionalText(req.filterFormation),
    filter_deleted: req.filterDeleted ?? null,
  };
}

export async function listCurrentUserGoiKnowledge(
  req: ListGoiKnowledgeReq,
  signal?: AbortSignal,
): Promise<ListGoiKnowledgeRsp> {
  const data = await postJson<ListGoiKnowledgeRspLike>(
    '/api/goi/knowledge',
    toListGoiKnowledgeReqBody(req),
    { signal },
  );

  return {
    items: (data?.items ?? []).map(normalizeGoiKnowledge),
    hasMore: data?.hasMore ?? data?.has_more ?? false,
  };
}
