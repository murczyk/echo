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
  PalitraGeometryDetails,
  PalitraReadV2,
  PalitraPoints,
  User,
} from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';

import { listAors } from './aor';
import {
  HttpRequestError,
  postBytes,
  postJson,
  postVoid,
  tryRunAndReturnNullExceptUnauthorized,
} from './client';
import { emitUnauthorizedEvent } from '../../auth-redirect';
import { isNullOrUndefined, isPresent } from '../../utils/misc';
import { hasRole } from '../../utils/roles';
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

type PalitraDownloadReqBody = {
  palitra_ids: number[];
};

type PalitraDownloadOptions = {
  splitForDelta?: boolean;
};

type PalitraFolderAssignReqBody = {
  palitra_ids: number[];
  folder: string;
};

type PalitraFolderRenameReqBody = {
  from_folder: string;
  to_folder: string;
};

type PalitraFolderReqBody = {
  folder: string;
};

type PalitraBulkActionRspBody = {
  palitra_ids?: Array<number | string> | null;
  palitraIds?: Array<number | string> | null;
};

type PalitraLike = {
  id?: number | string;
  name?: string;
  folder?: string | null;
  colorHex?: string;
  color_hex?: string;
  isArchived?: boolean;
  is_archived?: boolean;
  author?: string | null;
  sourceFileName?: string | null;
  source_file_name?: string | null;
  lastUploadedAtTs?: number | string | null;
  last_uploaded_at_ts?: number | string | null;
  conversionStatus?: string;
  conversion_status?: string;
  sourceFormat?: string | null;
  source_format?: string | null;
  conversionError?: string | null;
  conversion_error?: string | null;
  missingInGoi?: boolean;
  missing_in_goi?: boolean;
  importedFromGoi?: boolean;
  imported_from_goi?: boolean;
  goiOwned?: boolean;
  goi_owned?: boolean;
  goiSourceRefreshRetryAvailable?: boolean;
  goi_source_refresh_retry_available?: boolean;
  latestChangelogWarning?: boolean;
  latest_changelog_warning?: boolean;
  changelog?: PalitraChangelogEntryLike[] | null;
  geometry?: GeometryLike | null;
  accessAorId?: Array<number | string> | null;
  access_aor_id?: Array<number | string> | null;
  accessOrganismIds?: Array<number | string> | null;
  access_organism_ids?: Array<number | string> | null;
  accessLogins?: Array<string> | null;
  access_logins?: Array<string> | null;
};

type PalitraChangelogEntryLike = {
  isOk?: boolean;
  is_ok?: boolean;
  timestamp?: string;
  text?: string;
  description?: string;
};

type PalitraDetailsLike = {
  palitra?: PalitraLike;
  points?: PalitraDetails['points'] | null;
};

type PalitraGeometryDetailsLike = {
  id?: number | string;
  colorHex?: string;
  color_hex?: string;
  sourceFileName?: string | null;
  source_file_name?: string | null;
  lastUploadedAtTs?: number | string | null;
  last_uploaded_at_ts?: number | string | null;
  geometry?: GeometryLike | null;
  points?: PalitraGeometryDetails['points'] | null;
};

type PalitraReadWithGeometriesLike = {
  palitra: PalitraLike;
  geometries?: PalitraGeometryDetailsLike[] | null;
};

type PalitraReadV2Like = {
  palitra?: PalitraLike;
  geometries?: PalitraGeometryDetailsLike[] | null;
};

type CoordsLike = {
  lat?: number | string;
  lng?: number | string;
};

type GeometryLike = {
  center?: CoordsLike | null;
  perimeterLinearRing?: CoordsLike[] | null;
  perimeter_linear_ring?: CoordsLike[] | null;
  lineStrings?: CoordsLike[][] | null;
  line_strings?: CoordsLike[][] | null;
};

const primaryGeometryIdByPalitraId = new Map<number, number>();

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
  if (isNullOrUndefined(value)) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeNumberArray(values: Array<number | string> | null | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => normalizeOptionalNumber(value)).filter(isPresent);
}

function normalizePalitraBulkActionRsp(raw: PalitraBulkActionRspBody | null | undefined): number[] {
  return normalizeNumberArray(raw?.palitra_ids ?? raw?.palitraIds);
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

type UpdatePalitraReqBody = CreatePalitraReqBody & {
  geometry_id: number;
};

function toUpdatePalitraReqBody(req: CreatePalitraReq, geometryId: number): UpdatePalitraReqBody {
  return {
    ...toCreatePalitraReqBody(req),
    geometry_id: geometryId,
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
  const folder = raw?.folder?.trim() ?? '';
  const changelog = (raw?.changelog ?? []).map(normalizePalitraChangelogEntry);
  return {
    id: normalizeNumber(raw?.id),
    name: raw?.name ?? '',
    folder: folder.length > 0 ? folder : null,
    isArchived: raw?.isArchived ?? raw?.is_archived ?? false,
    colorHex: raw?.colorHex ?? raw?.color_hex ?? '#00bcd4',
    author: raw?.author ?? null,
    sourceFileName: raw?.sourceFileName ?? raw?.source_file_name ?? null,
    lastUploadedAtTs: normalizeOptionalNumber(raw?.lastUploadedAtTs ?? raw?.last_uploaded_at_ts),
    conversionStatus: raw?.conversionStatus ?? raw?.conversion_status ?? 'ready',
    sourceFormat: raw?.sourceFormat ?? raw?.source_format ?? null,
    conversionError: raw?.conversionError ?? raw?.conversion_error ?? null,
    missingInGoi: raw?.missingInGoi ?? raw?.missing_in_goi ?? false,
    importedFromGoi: raw?.importedFromGoi ?? raw?.imported_from_goi ?? false,
    goiOwned: raw?.goiOwned ?? raw?.goi_owned ?? false,
    goiSourceRefreshRetryAvailable:
      raw?.goiSourceRefreshRetryAvailable ?? raw?.goi_source_refresh_retry_available ?? false,
    latestChangelogWarning:
      raw?.latestChangelogWarning ??
      raw?.latest_changelog_warning ??
      (changelog.length > 0 ? !changelog[changelog.length - 1].isOk : false),
    changelog,
    geometry: normalizeGeometry(raw?.geometry),
    accessAorId: normalizeNumberArray(raw?.accessAorId ?? raw?.access_aor_id),
    accessOrganismIds: normalizeNumberArray(raw?.accessOrganismIds ?? raw?.access_organism_ids),
    accessLogins: raw?.accessLogins ?? raw?.access_logins ?? [],
  };
}

function normalizePalitraChangelogEntry(
  raw: PalitraChangelogEntryLike | null | undefined,
): Palitra['changelog'][number] {
  return {
    isOk: raw?.isOk ?? raw?.is_ok ?? false,
    timestamp: raw?.timestamp ?? '',
    text: raw?.text ?? '',
    description: raw?.description ?? '',
  };
}

function normalizePalitraDetails(raw: PalitraDetailsLike | null | undefined): PalitraDetails {
  return {
    palitra: normalizePalitra(raw?.palitra),
    points: raw?.points ?? [],
  };
}

function normalizeCoords(raw: CoordsLike | null | undefined): { lat: number; lng: number } | null {
  if (!raw) return null;
  const lat = raw.lat;
  const lng = raw.lng;
  if (isNullOrUndefined(lat) || isNullOrUndefined(lng)) return null;
  const normalizedLat = typeof lat === 'string' ? Number(lat) : lat;
  const normalizedLng = typeof lng === 'string' ? Number(lng) : lng;
  if (!Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLng)) return null;
  return { lat: normalizedLat, lng: normalizedLng };
}

function normalizeGeometry(
  raw: GeometryLike | null | undefined,
): PalitraGeometryDetails['geometry'] {
  if (!raw) return null;
  return {
    center: normalizeCoords(raw.center),
    perimeterLinearRing: (raw.perimeterLinearRing ?? raw.perimeter_linear_ring ?? [])
      .map((coords) => normalizeCoords(coords))
      .filter(isPresent),
    lineStrings: (raw.lineStrings ?? raw.line_strings ?? []).map((lineString) =>
      lineString.map((coords) => normalizeCoords(coords)).filter(isPresent),
    ),
  };
}

function normalizePalitraGeometryDetails(
  raw: PalitraGeometryDetailsLike | null | undefined,
): PalitraGeometryDetails {
  return {
    id: normalizeNumber(raw?.id),
    colorHex: raw?.colorHex ?? raw?.color_hex ?? '#00bcd4',
    sourceFileName: raw?.sourceFileName ?? raw?.source_file_name ?? null,
    lastUploadedAtTs: normalizeOptionalNumber(raw?.lastUploadedAtTs ?? raw?.last_uploaded_at_ts),
    geometry: normalizeGeometry(raw?.geometry),
    points: raw?.points ?? [],
  };
}

function normalizePalitraReadV2(raw: PalitraReadV2Like | null | undefined): PalitraReadV2 {
  return {
    palitra: normalizePalitra(raw?.palitra),
    geometries: (raw?.geometries ?? []).map(normalizePalitraGeometryDetails),
  };
}

function normalizeKmzColor(raw: KmzColorInfoLike | null | undefined): KmzColorInfo {
  return {
    colorHex: raw?.colorHex ?? raw?.color_hex ?? '#00bcd4',
    count: normalizeNumber(raw?.count),
    suggestedSuffix: raw?.suggestedSuffix ?? raw?.suggested_suffix ?? null,
  };
}

function normalizeAnalyzeKmzResponse(
  raw: AnalyzeKmzResponseLike | null | undefined,
): AnalyzeKmzResponse {
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

async function postMultipart<T>(
  url: string,
  formData: FormData,
  normalize: (raw: any) => T,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    throw new HttpRequestError(
      response.status,
      formatErrorMessage(response.status, await response.text()),
    );
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
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    throw new HttpRequestError(
      response.status,
      formatErrorMessage(response.status, await response.text()),
    );
  }
}

export async function listPalitras(): Promise<Palitra[]> {
  const data = await postJson<PalitraLike[]>('/api/palitra/list');
  primaryGeometryIdByPalitraId.clear();

  return (data ?? []).map((entry) => normalizePalitra(entry));
}

export async function listPalitrasV2(): Promise<PalitraReadV2[]> {
  const data = await postJson<PalitraReadV2Like[]>('/api/palitra/v2/list');
  primaryGeometryIdByPalitraId.clear();

  return (data ?? []).map((entry) => normalizePalitraReadV2(entry));
}

export async function listMapPalitrasV2(): Promise<PalitraReadV2[]> {
  const data = await postJson<PalitraReadV2Like[]>('/api/palitra/v2/list-map');

  return (data ?? []).map((entry) => normalizePalitraReadV2(entry));
}

export async function searchPalitraPoints(
  palitraIds: number[],
  pointLabels: string[],
): Promise<PalitraPoints[]> {
  const raw = await postJson<unknown>('/api/palitra/points/search', {
    palitra_ids: palitraIds,
    point_labels: pointLabels,
  });
  return transformSnakeToCamel<PalitraPoints[]>(raw) ?? [];
}

export async function readPalitraV2(palitraId: number): Promise<PalitraReadV2> {
  const data = await postJson<PalitraReadV2Like>(`/api/palitra/v2/read/${palitraId}`);
  return normalizePalitraReadV2(data);
}

export async function readPalitraPreviewV2(palitraId: number): Promise<PalitraReadV2> {
  const data = await postJson<PalitraReadV2Like>(`/api/palitra/v2/read-preview/${palitraId}`);
  return normalizePalitraReadV2(data);
}

async function getPrimaryGeometryIdForUpdate(palitraId: number): Promise<number | null> {
  const cached = primaryGeometryIdByPalitraId.get(palitraId);
  if (cached !== undefined) {
    return cached;
  }

  const data = await postJson<PalitraReadWithGeometriesLike>(`/api/palitra/v2/read/${palitraId}`);
  const geometryId = pickPrimaryGeometryIdForUpdate(data?.geometries);

  if (geometryId !== null) {
    primaryGeometryIdByPalitraId.set(palitraId, geometryId);
  }

  return geometryId;
}

function pickPrimaryGeometryIdForUpdate(
  geometries: PalitraGeometryDetailsLike[] | null | undefined,
): number | null {
  if (!Array.isArray(geometries) || geometries.length === 0) {
    return null;
  }

  for (const geometry of geometries) {
    const geometryId = normalizeOptionalNumber(geometry?.id);
    if (geometryId !== null) {
      return geometryId;
    }
  }
  return null;
}

export async function deletePalitra(palitraId: number): Promise<void> {
  await postVoid(`/api/palitra/delete/${palitraId}`);
}

export async function archivePalitra(palitraId: number): Promise<Palitra> {
  const data = await postJson<PalitraLike>(`/api/palitra/archive/${palitraId}`);
  return normalizePalitra(data);
}

export async function unarchivePalitra(palitraId: number): Promise<Palitra> {
  const data = await postJson<PalitraLike>(`/api/palitra/unarchive/${palitraId}`);
  return normalizePalitra(data);
}

export async function downloadPalitras(
  palitraIds: number[],
  options?: PalitraDownloadOptions,
): Promise<Blob> {
  const body: PalitraDownloadReqBody = {
    palitra_ids: palitraIds,
  };
  return postBytes(
    options?.splitForDelta ? '/api/palitra/download-delta-split' : '/api/palitra/download',
    body,
  );
}

export async function assignPalitraFolder(palitraIds: number[], folder: string): Promise<number[]> {
  const body: PalitraFolderAssignReqBody = {
    palitra_ids: palitraIds,
    folder,
  };
  const data = await postJson<PalitraBulkActionRspBody>('/api/palitra/folder/assign', body);
  return normalizePalitraBulkActionRsp(data);
}

export async function renamePalitraFolder(fromFolder: string, toFolder: string): Promise<number[]> {
  const body: PalitraFolderRenameReqBody = {
    from_folder: fromFolder,
    to_folder: toFolder,
  };
  const data = await postJson<PalitraBulkActionRspBody>('/api/palitra/folder/rename', body);
  return normalizePalitraBulkActionRsp(data);
}

export async function archivePalitraFolder(folder: string): Promise<number[]> {
  const body: PalitraFolderReqBody = {
    folder,
  };
  const data = await postJson<PalitraBulkActionRspBody>('/api/palitra/folder/archive', body);
  return normalizePalitraBulkActionRsp(data);
}

export async function deletePalitraFolder(folder: string): Promise<number[]> {
  const body: PalitraFolderReqBody = {
    folder,
  };
  const data = await postJson<PalitraBulkActionRspBody>('/api/palitra/folder/delete', body);
  return normalizePalitraBulkActionRsp(data);
}

export async function createPalitra(req: CreatePalitraReq): Promise<Palitra> {
  const data = await postJson<PalitraLike>('/api/palitra/create', toCreatePalitraReqBody(req));
  return normalizePalitra(data);
}

export async function updatePalitra(
  palitraId: number,
  req: CreatePalitraReq,
): Promise<PalitraDetails> {
  const geometryId = await getPrimaryGeometryIdForUpdate(palitraId);
  if (geometryId === null) {
    primaryGeometryIdByPalitraId.delete(palitraId);
    const data = await postJson<PalitraDetailsLike>(
      `/api/palitra/update/${palitraId}`,
      toCreatePalitraReqBody(req),
    );
    return normalizePalitraDetails(data);
  }

  const data = await postJson<PalitraReadWithGeometriesLike>(
    `/api/palitra/v2/update/${palitraId}`,
    toUpdatePalitraReqBody(req, geometryId),
  );

  const updatedGeometryId = pickPrimaryGeometryIdForUpdate(data?.geometries);
  if (updatedGeometryId !== null) {
    primaryGeometryIdByPalitraId.set(palitraId, updatedGeometryId);
  } else {
    primaryGeometryIdByPalitraId.delete(palitraId);
  }

  const normalizedDetails = normalizePalitraDetails({
    palitra: data?.palitra,
    points: [],
  });
  return {
    ...normalizedDetails,
    palitra: {
      ...normalizedDetails.palitra,
      colorHex: req.colorHex,
    },
  };
}

export async function uploadPalitraPoints(palitraId: number, file: File): Promise<void> {
  const formData = new FormData();
  formData.append(file.name, file);
  await postMultipartVoid(`/api/palitra/upload-points/${palitraId}`, formData);
}

export async function retryPalitraConversion(palitraId: number): Promise<Palitra> {
  const data = await postJson<PalitraLike>(`/api/palitra/retry-conversion/${palitraId}`);
  return normalizePalitra(data);
}

export async function retryGoiSourceConversion(palitraId: number): Promise<Palitra> {
  const data = await postJson<PalitraLike>(`/api/palitra/retry-goi-source-conversion/${palitraId}`);
  return normalizePalitra(data);
}

export async function analyzePalitraKmz(file: File): Promise<AnalyzeKmzResponse> {
  const formData = new FormData();
  formData.append(file.name, file);
  return postMultipart('/api/palitra/analyze-kmz', formData, normalizeAnalyzeKmzResponse);
}

export async function createPalitraWithKmz(req: CreatePalitraReq, file: File): Promise<Palitra> {
  return createPalitraWithKmzVia('/api/palitra/create-with-kmz', req, file);
}

export async function createPalitraBasicWithKmz(
  req: CreatePalitraReq,
  file: File,
): Promise<Palitra> {
  return createPalitraWithKmzVia('/api/palitra/v2/create-palitra-basic', req, file);
}

async function createPalitraWithKmzVia(
  url: string,
  req: CreatePalitraReq,
  file: File,
): Promise<Palitra> {
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

  return postMultipart(url, formData, normalizePalitra);
}

export async function fetchMyScope(): Promise<MyScope> {
  const data = await postJson<MyScopeLike>('/api/organism/my-scope');
  return normalizeMyScope(data);
}

async function fetchMyScopeOptional(): Promise<MyScope | null> {
  return tryRunAndReturnNullExceptUnauthorized(fetchMyScope);
}

async function fetchAdminReferenceOptional<T>(fetchReference: () => Promise<T>): Promise<T | null> {
  return tryRunAndReturnNullExceptUnauthorized(fetchReference);
}

export async function fetchPalitraReferenceData(user: User): Promise<{
  myScope: MyScope | null;
  logins: ListLoginsRsp | null;
  organismLogins: string[] | null;
  organisms: Organism[] | null;
  aors: Awaited<ReturnType<typeof listAors>> | null;
}> {
  const isAdmin = hasRole(user.roles, 'Admin');

  const [myScope, logins, organismLogins, organisms, aors] = await Promise.all([
    fetchMyScopeOptional(),
    isAdmin
      ? fetchAdminReferenceOptional(() => listLogins({ sortBy: null, filterByRoles: null }))
      : Promise.resolve(null),
    Promise.resolve(null),
    isAdmin
      ? fetchAdminReferenceOptional(() => listOrganisms({ sortBy: null }))
      : Promise.resolve(null),
    isAdmin ? fetchAdminReferenceOptional(() => listAors({ sortBy: null })) : Promise.resolve(null),
  ]);

  return { myScope, logins, organismLogins, organisms, aors };
}

export async function fetchPalitraBootstrapData(): Promise<{
  user: User;
  palitras: Palitra[];
  myScope: MyScope | null;
  logins: ListLoginsRsp | null;
  organismLogins: string[] | null;
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
