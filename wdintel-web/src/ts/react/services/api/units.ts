import type {
  CreateUnitReq,
  CreateUnitWithAutoNetworkReq,
  CreateUnitWithAutoNetworkRsp,
  ConfirmUnitNameReq,
  CreateDeviceNetworkReq,
  CreateDeviceNetworkRsp,
  DeleteUnitAttachmentReq,
  DeleteUnitAttachmentRsp,
  DeleteUnitDuplicateReq,
  ImportOrbitUnitReq,
  InconsistentUnit,
  LinkOrbitUnitReq,
  ListInconsistentUnitsRsp,
  ListUnitNameReviewsReq,
  ListUnitNameReviewsRsp,
  ListUnitDuplicatesRsp,
  ListUnitsByIdRsp,
  ListUnitsReq,
  ListUnitsRsp,
  OrbitUnitLinkCandidate,
  OrbitUnitLinkCandidatesReq,
  OrbitUnitLinkCandidatesRsp,
  OrbitUnitSearchReq,
  Unit,
  UnitAttachment,
  UnitDuplicate,
  UnitNameReview,
  UnitAttachmentUnitIdsRsp,
  UnitDetailsRsp,
  UnitStatusCountsRsp,
  UpdateUnitAttachmentReq,
  UpdateUnitNameReq,
} from '../../../../Bindings';
import { emitUnauthorizedEvent } from '../../auth-redirect';
import { HttpRequestError, postBytes, postJson, postVoid } from './client';
import type { RequestOptions } from './client';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

type GetUnitsListOptions = RequestOptions & {
  includeInactive?: boolean;
};

type GetUnitsPageOptions = GetUnitsListOptions & {
  afterUnitId?: number | null;
};

export const DEFAULT_LIST_UNITS_REQ: ListUnitsReq = {
  sortBy: null,
  afterUnitId: null,
  beforeUnitId: null,
  includeInactive: false,
  filterActive: null,
  filterText: null,
  filterName: null,
  filterOther: null,
  filterTeamOrCrew: null,
  filterSection: null,
  filterSquad: null,
  filterPlatoon: null,
  filterCompany: null,
  filterBattalion: null,
  filterRegiment: null,
  filterBrigade: null,
  filterDivision: null,
  filterCorps: null,
  filterArmy: null,
  filterMilitaryDistrict: null,
  filterArmyRegion: null,
  filterComment: null,
  filterOrbitNote: null,
  filterIsDeduplicateCandidate: null,
  filterHasOrbit: null,
  filterHasOrbitNote: null,
  searchMode: null,
  limit: null,
  offset: null,
};

export function mergeUnitsById(...unitLists: readonly Unit[][]): Unit[] {
  const unitsById = new Map<number, Unit>();
  for (const units of unitLists) {
    for (const unit of units) unitsById.set(unit.id, unit);
  }
  return Array.from(unitsById.values());
}

export type UnitSearchMatches = {
  strict: Unit[];
  relaxed: Unit[];
};

export async function searchUnitsByMatchTier(
  req: ListUnitsReq,
  options?: RequestOptions,
): Promise<UnitSearchMatches> {
  const strictPage = getUnitsPage({ ...req, searchMode: 'Strict' }, options);
  if (!req.filterText?.trim() && !req.filterName?.trim()) {
    return { strict: (await strictPage).units, relaxed: [] };
  }
  const [strict, relaxed] = await Promise.all([
    strictPage,
    getUnitsPage({ ...req, searchMode: 'Relaxed' }, options),
  ]);
  const strictIds = new Set(strict.units.map((unit) => unit.id));
  return {
    strict: strict.units,
    relaxed: relaxed.units.filter((unit) => !strictIds.has(unit.id)),
  };
}

export async function searchUnitsStrictThenRelaxed(
  req: ListUnitsReq,
  options?: RequestOptions,
): Promise<Unit[]> {
  const matches = await searchUnitsByMatchTier(req, options);
  return [...matches.strict, ...matches.relaxed];
}

export async function getUnitsPage(
  req: ListUnitsReq,
  options?: RequestOptions,
): Promise<ListUnitsRsp> {
  const raw = await postJson<unknown>('/api/sigint/units', transformCamelToSnake(req), options);
  return transformSnakeToCamel<ListUnitsRsp>(raw);
}

async function getUnitsCursorPage(options?: GetUnitsPageOptions): Promise<ListUnitsRsp> {
  const { afterUnitId = null, includeInactive = false, ...requestOptions } = options ?? {};
  const req: ListUnitsReq = {
    ...DEFAULT_LIST_UNITS_REQ,
    afterUnitId,
    includeInactive,
  };
  return getUnitsPage(req, requestOptions);
}

/** Fetch active units by default. Single request, backend limit is 100k. */
export async function getUnitsList(options?: GetUnitsListOptions): Promise<Unit[]> {
  return (await getUnitsCursorPage(options)).units ?? [];
}

/** Fetch the complete unit catalog across every backend cursor page. */
export async function getAllUnitsList(options?: GetUnitsListOptions): Promise<Unit[]> {
  const unitsById = new Map<number, Unit>();
  let afterUnitId: number | null = null;

  while (true) {
    const page = await getUnitsCursorPage({ ...options, afterUnitId });
    for (const unit of page.units ?? []) unitsById.set(unit.id, unit);
    if (!page.showLoadMore) return Array.from(unitsById.values());

    const nextAfterUnitId = page.units?.at(-1)?.id;
    if (nextAfterUnitId === undefined || nextAfterUnitId === afterUnitId) {
      throw new Error('Unit pagination did not advance');
    }
    afterUnitId = nextAfterUnitId;
  }
}

export async function getUnitStatusCounts(options?: RequestOptions): Promise<UnitStatusCountsRsp> {
  const raw =
    options == null
      ? await postJson<unknown>('/api/sigint/units/status-counts', null)
      : await postJson<unknown>('/api/sigint/units/status-counts', null, options);
  return transformSnakeToCamel<UnitStatusCountsRsp>(raw);
}

/** Fetch units by IDs (legacy batch; prefer getUnitsList for duty page). */
export async function getUnitsByIds(ids: number[], options?: RequestOptions): Promise<Unit[]> {
  if (ids.length === 0) return [];
  const raw =
    options == null
      ? await postJson<unknown>('/api/sigint/units-by-id', { ids })
      : await postJson<unknown>('/api/sigint/units-by-id', { ids }, options);
  const data = transformSnakeToCamel<ListUnitsByIdRsp>(raw);
  return data?.units ?? [];
}

export async function getUnitDuplicates(options?: RequestOptions): Promise<UnitDuplicate[]> {
  const raw = await postJson<unknown>('/api/admin/unit-duplicates', null, options);
  return transformSnakeToCamel<ListUnitDuplicatesRsp>(raw).units;
}

export async function getInconsistentUnits(options?: RequestOptions): Promise<InconsistentUnit[]> {
  const raw = await postJson<unknown>('/api/admin/unit-inconsistent', null, options);
  return transformSnakeToCamel<ListInconsistentUnitsRsp>(raw).units;
}

export async function getUnitNameReviews(
  req: ListUnitNameReviewsReq,
  options?: RequestOptions,
): Promise<ListUnitNameReviewsRsp> {
  const raw = await postJson<unknown>('/api/admin/unit-names', transformCamelToSnake(req), options);
  return transformSnakeToCamel<ListUnitNameReviewsRsp>(raw);
}

export async function updateUnitNameReview(req: UpdateUnitNameReq): Promise<UnitNameReview> {
  const raw = await postJson<unknown>('/api/admin/unit-name/update', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitNameReview>(raw);
}

export async function confirmUnitNameReview(req: ConfirmUnitNameReq): Promise<UnitNameReview> {
  const raw = await postJson<unknown>('/api/admin/unit-name/confirm', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitNameReview>(raw);
}

export async function createUnit(unit: CreateUnitReq): Promise<Unit> {
  const raw = await postJson<unknown>('/api/sigint/unit/create', transformCamelToSnake(unit));
  return transformSnakeToCamel<Unit>(raw);
}

export async function getCreateUnitDuplicateCandidates(unit: CreateUnitReq): Promise<Unit[]> {
  const raw = await postJson<unknown>(
    '/api/sigint/unit/create-duplicate-candidates',
    transformCamelToSnake(unit),
  );
  return transformSnakeToCamel<ListUnitsByIdRsp>(raw).units ?? [];
}

export async function createUnitWithAutoNetwork(
  req: CreateUnitWithAutoNetworkReq,
): Promise<CreateUnitWithAutoNetworkRsp> {
  const raw = await postJson<unknown>(
    '/api/sigint/unit/create-with-auto-network',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<CreateUnitWithAutoNetworkRsp>(raw);
}

export async function createDeviceNetwork(
  req: CreateDeviceNetworkReq,
): Promise<CreateDeviceNetworkRsp> {
  const raw = await postJson<unknown>(
    '/api/sigint/unit/create-device-network',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<CreateDeviceNetworkRsp>(raw);
}

export async function updateUnit(unit: Unit): Promise<Unit> {
  const raw = await postJson<unknown>('/api/sigint/unit/update', transformCamelToSnake(unit));
  return transformSnakeToCamel<Unit>(raw);
}

export async function deleteUnit(unitId: number): Promise<Unit> {
  const raw = await postJson<unknown>('/api/sigint/unit/delete', unitId);
  return transformSnakeToCamel<Unit>(raw);
}

export async function mergeDuplicateUnit(req: DeleteUnitDuplicateReq): Promise<Unit> {
  const raw = await postJson<unknown>(
    '/api/sigint/unit/delete-duplicate',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<Unit>(raw);
}

export async function getUnitIdsWithVisibleAttachments(
  unitIds: number[],
  options?: RequestOptions,
): Promise<number[]> {
  const raw = await postJson<unknown>('/api/sigint/unit/attachment-unit-ids', unitIds, options);
  return transformSnakeToCamel<UnitAttachmentUnitIdsRsp>(raw).unitIds;
}

export async function getUnitDetails(unitId: number): Promise<UnitDetailsRsp> {
  const raw = await postJson<unknown>('/api/sigint/unit/details', { unit_id: unitId });
  return transformSnakeToCamel<UnitDetailsRsp>(raw);
}

export async function getOrbitUnitLinkCandidates(
  req: OrbitUnitLinkCandidatesReq,
  options?: RequestOptions,
): Promise<OrbitUnitLinkCandidate[]> {
  const raw =
    options == null
      ? await postJson<unknown>(
          '/api/sigint/unit/orbit-link-candidates',
          transformCamelToSnake(req),
        )
      : await postJson<unknown>(
          '/api/sigint/unit/orbit-link-candidates',
          transformCamelToSnake(req),
          options,
        );
  return transformSnakeToCamel<OrbitUnitLinkCandidatesRsp>(raw).units ?? [];
}

export async function searchOrbitUnits(
  req: OrbitUnitSearchReq,
  options?: RequestOptions,
): Promise<OrbitUnitLinkCandidate[]> {
  const raw =
    options == null
      ? await postJson<unknown>('/api/sigint/unit/orbit-search', transformCamelToSnake(req))
      : await postJson<unknown>(
          '/api/sigint/unit/orbit-search',
          transformCamelToSnake(req),
          options,
        );
  return transformSnakeToCamel<OrbitUnitLinkCandidatesRsp>(raw).units ?? [];
}

export async function importOrbitUnit(
  req: ImportOrbitUnitReq,
): Promise<CreateUnitWithAutoNetworkRsp> {
  const raw = await postJson<unknown>('/api/sigint/unit/orbit-import', transformCamelToSnake(req));
  return transformSnakeToCamel<CreateUnitWithAutoNetworkRsp>(raw);
}

export async function linkOrbitUnit(req: LinkOrbitUnitReq): Promise<void> {
  await postVoid('/api/sigint/unit/orbit-link', transformCamelToSnake(req));
}

export async function unlinkOrbitUnit(req: LinkOrbitUnitReq): Promise<void> {
  await postVoid('/api/sigint/unit/orbit-unlink', transformCamelToSnake(req));
}

export async function updateUnitAttachment(req: UpdateUnitAttachmentReq): Promise<UnitAttachment> {
  const raw = await postJson<unknown>(
    '/api/sigint/unit/attachment/update',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<UnitAttachment>(raw);
}

export async function deleteUnitAttachment(attachmentId: number): Promise<number> {
  const req: DeleteUnitAttachmentReq = { attachmentId };
  const raw = await postJson<unknown>(
    '/api/sigint/unit/attachment/delete',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<DeleteUnitAttachmentRsp>(raw).attachmentId;
}

export async function downloadUnitAttachment(attachmentId: number): Promise<Blob> {
  return postBytes('/api/sigint/unit/attachment/download', { attachment_id: attachmentId });
}

export type UploadUnitAttachmentParams = {
  unitId: number;
  shortDescription: string;
  fullDescription: string;
  aorIds: number[];
  file: File;
};

export async function uploadUnitAttachment({
  unitId,
  shortDescription,
  fullDescription,
  aorIds,
  file,
}: UploadUnitAttachmentParams): Promise<UnitAttachment> {
  const formData = new FormData();
  formData.append('unit_id', String(unitId));
  formData.append('short_description', shortDescription);
  formData.append('full_description', fullDescription);
  formData.append('aor_ids', JSON.stringify(aorIds));
  formData.append('file', file, file.name);

  let response: Response;
  try {
    response = await fetch('/api/sigint/unit/attachment/upload', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
  } catch (_) {
    throw new HttpRequestError(
      0,
      'Не вдалося підключитися до сервера. Перевірте мережу та спробуйте ще раз.',
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    const message = (await response.text()).trim();
    throw new HttpRequestError(response.status, message || `HTTP ${response.status}`);
  }

  const raw = (await response.json()) as unknown;
  return transformSnakeToCamel<UnitAttachment>(raw);
}

export async function uploadUnitsKmz(file: File): Promise<number> {
  const formData = new FormData();
  formData.append(file.name, file);

  let response: Response;
  try {
    response = await fetch('/api/delta/convert-kmz-to-geojson', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
  } catch (_) {
    throw new HttpRequestError(
      0,
      'Не вдалося підключитися до сервера. Перевірте мережу та спробуйте ще раз.',
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    const message = (await response.text()).trim();
    throw new HttpRequestError(response.status, message || `HTTP ${response.status}`);
  }

  return response.json() as Promise<number>;
}
