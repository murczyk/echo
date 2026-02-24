import {
  AnalyzeKmzResponse,
  CreatePalitraReq,
  KmzColorInfo,
  ListLoginsRsp,
  MyScope,
  Organism,
  Palitra,
  PalitraAccess,
  PalitraDetails,
  User,
} from '../../../../Bindings';

import { listAors } from './aor';
import { HttpRequestError, isUnauthorizedError, postJson, postVoid } from './client';
import { listLogins } from './logins';
import { listOrganisms } from './organisms';
import { fetchCurrentUser } from './user';

type CreatePalitraReqBody = {
  name: string;
  color_hex: string;
  access: {
    ByLogins?: { logins: string[] };
    ByOrganisms?: { organism_ids: number[] };
    ByAor?: { aor_ids: number[] };
  };
  source_file_name: string | null;
  last_uploaded_at_ts: number | null;
};

type PalitraLike = {
  id?: number | string;
  name?: string;
  colorHex?: string;
  color_hex?: string;
  author?: string | null;
  sourceFileName?: string | null;
  source_file_name?: string | null;
  lastUploadedAtTs?: number | string | null;
  last_uploaded_at_ts?: number | string | null;
  geometry?: Palitra['geometry'];
  accessAorId?: Array<number | string> | null;
  access_aor_id?: Array<number | string> | null;
  accessOrganismIds?: Array<number | string> | null;
  access_organism_ids?: Array<number | string> | null;
  accessLogins?: Array<string> | null;
  access_logins?: Array<string> | null;
};

type PalitraDetailsLike = {
  palitra?: PalitraLike;
  points?: PalitraDetails['points'] | null;
};

type KmzColorInfoLike = {
  colorHex?: string;
  color_hex?: string;
  count?: number | string;
  suggestedSuffix?: string | null;
  suggested_suffix?: string | null;
};

type AnalyzeKmzResponseLike = {
  topColors?: KmzColorInfoLike[] | null;
  top_colors?: KmzColorInfoLike[] | null;
  filename?: string;
};

type MyScopeLike = {
  organism?: { id?: number | string; name?: string } | null;
  aorIds?: Array<number | string> | null;
  aor_ids?: Array<number | string> | null;
  aors?: Array<{ id?: number | string; name?: string }> | null;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeOptionalNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeNumberArray(values: Array<number | string> | null | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeOptionalNumber(value))
    .filter((value): value is number => value !== null);
}

function toCreatePalitraReqBody(req: CreatePalitraReq): CreatePalitraReqBody {
  return {
    name: req.name,
    color_hex: req.colorHex,
    access: toAccessBody(req.access),
    source_file_name: req.sourceFileName,
    last_uploaded_at_ts: req.lastUploadedAtTs,
  };
}

function toAccessBody(access: PalitraAccess): CreatePalitraReqBody['access'] {
  if ('ByLogins' in access) {
    return {
      ByLogins: {
        logins: access.ByLogins.logins,
      },
    };
  }

  if ('ByOrganisms' in access) {
    return {
      ByOrganisms: {
        organism_ids: access.ByOrganisms.organismIds,
      },
    };
  }

  return {
    ByAor: {
      aor_ids: access.ByAor.aorIds,
    },
  };
}

function normalizePalitra(raw: PalitraLike | null | undefined): Palitra {
  return {
    id: normalizeNumber(raw?.id),
    name: raw?.name ?? '',
    colorHex: raw?.colorHex ?? raw?.color_hex ?? '#00bcd4',
    author: raw?.author ?? null,
    sourceFileName: raw?.sourceFileName ?? raw?.source_file_name ?? null,
    lastUploadedAtTs: normalizeOptionalNumber(raw?.lastUploadedAtTs ?? raw?.last_uploaded_at_ts),
    geometry: raw?.geometry ?? null,
    accessAorId: normalizeNumberArray(raw?.accessAorId ?? raw?.access_aor_id),
    accessOrganismIds: normalizeNumberArray(raw?.accessOrganismIds ?? raw?.access_organism_ids),
    accessLogins: raw?.accessLogins ?? raw?.access_logins ?? [],
  };
}

function normalizePalitraDetails(raw: PalitraDetailsLike | null | undefined): PalitraDetails {
  return {
    palitra: normalizePalitra(raw?.palitra),
    points: raw?.points ?? [],
  };
}

function normalizeKmzColor(raw: KmzColorInfoLike | null | undefined): KmzColorInfo {
  return {
    colorHex: raw?.colorHex ?? raw?.color_hex ?? '#00bcd4',
    count: normalizeNumber(raw?.count),
    suggestedSuffix: raw?.suggestedSuffix ?? raw?.suggested_suffix ?? null,
  };
}

function normalizeAnalyzeKmzResponse(raw: AnalyzeKmzResponseLike | null | undefined): AnalyzeKmzResponse {
  return {
    topColors: (raw?.topColors ?? raw?.top_colors ?? []).map(normalizeKmzColor),
    filename: raw?.filename ?? '',
  };
}

function normalizeMyScope(raw: MyScopeLike | null | undefined): MyScope {
  return {
    organism: raw?.organism
      ? {
          id: normalizeNumber(raw.organism.id),
          name: raw.organism.name ?? '',
        }
      : null,
    aorIds: normalizeNumberArray(raw?.aorIds ?? raw?.aor_ids),
    aors: (raw?.aors ?? []).map((aor) => ({
      id: normalizeNumber(aor?.id),
      name: aor?.name ?? '',
    })),
  };
}

function formatErrorMessage(status: number, text: string): string {
  if (text.trim().length > 0) return text;
  return `HTTP ${status}`;
}

async function postMultipart<T>(url: string, formData: FormData, normalize: (raw: any) => T): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    throw new HttpRequestError(response.status, formatErrorMessage(response.status, await response.text()));
  }

  if (response.status === 204) return normalize(undefined);

  const text = await response.text();
  if (!text.trim()) return normalize(undefined);

  return normalize(JSON.parse(text));
}

async function postMultipartVoid(url: string, formData: FormData): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    throw new HttpRequestError(response.status, formatErrorMessage(response.status, await response.text()));
  }
}

export async function listPalitras(): Promise<Palitra[]> {
  const data = await postJson<PalitraLike[]>('/api/palitra/list');
  return (data ?? []).map(normalizePalitra);
}

export async function deletePalitra(palitraId: number): Promise<void> {
  await postVoid(`/api/palitra/delete/${palitraId}`);
}

export async function createPalitra(req: CreatePalitraReq): Promise<Palitra> {
  const data = await postJson<PalitraLike>('/api/palitra/create', toCreatePalitraReqBody(req));
  return normalizePalitra(data);
}

export async function updatePalitra(palitraId: number, req: CreatePalitraReq): Promise<PalitraDetails> {
  const data = await postJson<PalitraDetailsLike>(`/api/palitra/update/${palitraId}`, toCreatePalitraReqBody(req));
  return normalizePalitraDetails(data);
}

export async function uploadPalitraPoints(palitraId: number, file: File): Promise<void> {
  const formData = new FormData();
  formData.append(file.name, file);
  await postMultipartVoid(`/api/palitra/upload-points/${palitraId}`, formData);
}

export async function analyzePalitraKmz(file: File): Promise<AnalyzeKmzResponse> {
  const formData = new FormData();
  formData.append(file.name, file);
  return postMultipart('/api/palitra/analyze-kmz', formData, normalizeAnalyzeKmzResponse);
}

export async function createPalitraWithKmz(req: CreatePalitraReq, file: File): Promise<Palitra> {
  const formData = new FormData();
  formData.append('name', req.name);
  formData.append('color_hex', req.colorHex);

  if ('ByLogins' in req.access) {
    formData.append('access_type', 'logins');
    formData.append('access_values', req.access.ByLogins.logins.join(','));
  } else if ('ByOrganisms' in req.access) {
    formData.append('access_type', 'organisms');
    formData.append('access_values', req.access.ByOrganisms.organismIds.join(','));
  } else {
    formData.append('access_type', 'aor');
    formData.append('access_values', req.access.ByAor.aorIds.join(','));
  }

  formData.append('kmz', file);

  return postMultipart('/api/palitra/create-with-kmz', formData, normalizePalitra);
}

export async function fetchMyScope(): Promise<MyScope> {
  const data = await postJson<MyScopeLike>('/api/organism/my-scope');
  return normalizeMyScope(data);
}

async function fetchMyScopeOptional(): Promise<MyScope | null> {
  try {
    return await fetchMyScope();
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw error;
    }
    return null;
  }
}

export async function fetchPalitraReferenceData(user: User): Promise<{
  myScope: MyScope | null;
  logins: ListLoginsRsp | null;
  organisms: Organism[] | null;
  aors: Awaited<ReturnType<typeof listAors>> | null;
}> {
  const isAdmin = user.roles.includes('Admin');

  const [myScope, logins, organisms, aors] = await Promise.all([
    fetchMyScopeOptional(),
    isAdmin ? listLogins({ sortBy: null, filterByRoles: null }) : Promise.resolve(null),
    isAdmin ? listOrganisms({ sortBy: null }) : Promise.resolve(null),
    isAdmin ? listAors({ sortBy: null }) : Promise.resolve(null),
  ]);

  return { myScope, logins, organisms, aors };
}

export async function fetchPalitraBootstrapData(): Promise<{
  user: User;
  palitras: Palitra[];
  myScope: MyScope | null;
  logins: ListLoginsRsp | null;
  organisms: Organism[] | null;
  aors: Awaited<ReturnType<typeof listAors>> | null;
}> {
  const user = await fetchCurrentUser();

  const [palitras, references] = await Promise.all([
    listPalitras(),
    fetchPalitraReferenceData(user),
  ]);

  return {
    user,
    palitras,
    ...references,
  };
}
