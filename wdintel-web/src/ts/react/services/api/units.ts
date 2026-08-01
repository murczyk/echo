import type {
  CreateUnitReq,
  CreateUnitWithAutoNetworkReq,
  CreateUnitWithAutoNetworkRsp,
  DeleteUnitAttachmentReq,
  LinkOrbitUnitReq,
  DeleteUnitAttachmentRsp,
  DeleteUnitDuplicateReq,
  ListUnitsByIdRsp,
  ListUnitsReq,
  ListUnitsRsp,
  OrbitUnitLinkCandidate,
  OrbitUnitLinkCandidatesReq,
  OrbitUnitLinkCandidatesRsp,
  Unit,
  UnitAttachment,
  UnitAttachmentUnitIdsRsp,
  UnitDetailsRsp,
  UpdateUnitAttachmentReq,
} from '../../../../Bindings';
import { emitUnauthorizedEvent } from '../../auth-redirect';
import { HttpRequestError, postBytes, postJson, postVoid } from './client';
import type { RequestOptions } from './client';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

/** Fetch all units (for network display text). Single request, backend limit is 100k. */
export async function getUnitsList(options?: RequestOptions): Promise<Unit[]> {
  const req: ListUnitsReq = {
    sortBy: null,
    afterUnitId: null,
    beforeUnitId: null,
  };
  const raw =
    options == null
      ? await postJson<unknown>('/api/sigint/units', transformCamelToSnake(req))
      : await postJson<unknown>('/api/sigint/units', transformCamelToSnake(req), options);
  const data = transformSnakeToCamel<ListUnitsRsp>(raw);
  return data?.units ?? [];
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

export async function createUnit(unit: CreateUnitReq): Promise<Unit> {
  const raw = await postJson<unknown>('/api/sigint/unit/create', transformCamelToSnake(unit));
  return transformSnakeToCamel<Unit>(raw);
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

export async function getUnitIdsWithVisibleAttachments(): Promise<number[]> {
  const raw = await postJson<unknown>('/api/sigint/unit/attachment-unit-ids');
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
