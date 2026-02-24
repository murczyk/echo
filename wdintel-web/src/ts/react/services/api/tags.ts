import { TagAdmin, TagKeyword, TagKeywordAddReq, TagUpsertReq } from '../../../../Bindings';

import { deleteVoid, getJson, postJson, putJson, putVoid } from './client';

type TagKeywordLike = {
  tagKeywordId?: number;
  tag_keyword_id?: number;
  isRegex?: boolean;
  is_regex?: boolean;
  keyword?: string;
  keywordForms?: string[];
  keyword_forms?: string[];
  keywordNegativeForms?: string[];
  keyword_negative_forms?: string[];
};

type TagModelErrorRaw = {
  id?: number;
  body?: string;
  removedAt?: number;
  removed_at?: number;
  removedByLogin?: string;
  removed_by_login?: string;
};

export type TagModelErrorFE = {
  id: number;
  body: string;
  removedAt: number;
  removedByLogin: string;
};

type TagAdminLike = {
  tagId?: number;
  tag_id?: number;
  label?: string;
  extra?: boolean | null;
  ord?: number | null;
  enabled?: boolean;
  keywords?: TagKeywordLike[] | null;
};

type TagKeywordAddReqBody = {
  is_regex: boolean;
  keyword: string;
  keyword_forms: string[] | null;
  keyword_negative_forms: string[] | null;
};

function normalizeTagKeyword(raw: TagKeywordLike): TagKeyword {
  return {
    tagKeywordId: raw.tagKeywordId ?? raw.tag_keyword_id ?? 0,
    isRegex: raw.isRegex ?? raw.is_regex ?? false,
    keyword: raw.keyword ?? '',
    keywordForms: raw.keywordForms ?? raw.keyword_forms ?? [],
    keywordNegativeForms: raw.keywordNegativeForms ?? raw.keyword_negative_forms ?? [],
  };
}

function normalizeTagAdmin(raw: TagAdminLike): TagAdmin {
  return {
    tagId: raw.tagId ?? raw.tag_id ?? 0,
    label: raw.label ?? '',
    extra: raw.extra ?? null,
    ord: raw.ord ?? null,
    enabled: raw.enabled ?? false,
    keywords: (raw.keywords ?? []).map(normalizeTagKeyword),
  };
}

function toTagModelErrorFE(raw: TagModelErrorRaw): TagModelErrorFE {
  return {
    id: raw.id ?? 0,
    body: raw.body ?? '',
    removedAt: raw.removedAt ?? raw.removed_at ?? 0,
    removedByLogin: raw.removedByLogin ?? raw.removed_by_login ?? '',
  };
}

function toTagKeywordAddReqBody(req: TagKeywordAddReq): TagKeywordAddReqBody {
  return {
    is_regex: req.isRegex,
    keyword: req.keyword,
    keyword_forms: req.keywordForms ?? null,
    keyword_negative_forms: req.keywordNegativeForms ?? null,
  };
}

export async function listTags(): Promise<TagAdmin[]> {
  const data = await postJson<TagAdminLike[]>('/api/admin/tags/list');
  return (data || []).map(normalizeTagAdmin);
}

export async function getTagModelErrors(tagId: number): Promise<TagModelErrorFE[]> {
  const data = await getJson<TagModelErrorRaw[]>(`/api/tags/${tagId}/model-errors`);
  return data.map(toTagModelErrorFE);
}

export async function createTag(req: TagUpsertReq): Promise<TagAdmin> {
  const data = await postJson<TagAdminLike>('/api/admin/tags', req);
  return normalizeTagAdmin(data);
}

export async function updateTag(tagId: number, req: TagUpsertReq): Promise<TagAdmin> {
  const data = await putJson<TagAdminLike>(`/api/admin/tags/${tagId}`, req);
  return normalizeTagAdmin(data);
}

export async function addTagKeywords(tagId: number, req: TagKeywordAddReq[]): Promise<TagKeyword[]> {
  const data = await postJson<TagKeywordLike[]>(
    `/api/tags/${tagId}/keywords`,
    req.map(toTagKeywordAddReqBody),
  );
  return (data || []).map(normalizeTagKeyword);
}

export async function updateTagKeyword(tagId: number, tagKeywordId: number, req: TagKeywordAddReq): Promise<void> {
  await putVoid(`/api/tags/${tagId}/keywords/${tagKeywordId}`, toTagKeywordAddReqBody(req));
}

export async function deleteTagKeyword(tagId: number, tagKeywordId: number): Promise<void> {
  await deleteVoid(`/api/tags/${tagId}/keywords/${tagKeywordId}`);
}
