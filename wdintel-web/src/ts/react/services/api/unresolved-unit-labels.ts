import type {
  ArchiveUnresolvedUnitLabelReq,
  ClassifyUnresolvedUnitLabelReq,
  ListUnresolvedUnitLabelsReq,
  ListUnresolvedUnitLabelsRsp,
  ResolveUnresolvedUnitLabelReq,
  UpdateUnresolvedUnitLabelNoteReq,
  UpdateUnresolvedUnitLabelsRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { RequestOptions } from './client';

export async function listUnresolvedUnitLabels(
  req: ListUnresolvedUnitLabelsReq,
  options?: RequestOptions,
): Promise<ListUnresolvedUnitLabelsRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/unresolved-unit-label/list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListUnresolvedUnitLabelsRsp>(raw);
}

export async function classifyUnresolvedUnitLabel(
  req: ClassifyUnresolvedUnitLabelReq,
): Promise<UpdateUnresolvedUnitLabelsRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/unresolved-unit-label/bad-data',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<UpdateUnresolvedUnitLabelsRsp>(raw);
}

export async function archiveUnresolvedUnitLabel(
  req: ArchiveUnresolvedUnitLabelReq,
): Promise<UpdateUnresolvedUnitLabelsRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/unresolved-unit-label/archive',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<UpdateUnresolvedUnitLabelsRsp>(raw);
}

export async function updateUnresolvedUnitLabelNote(
  req: UpdateUnresolvedUnitLabelNoteReq,
): Promise<UpdateUnresolvedUnitLabelsRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/unresolved-unit-label/note',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<UpdateUnresolvedUnitLabelsRsp>(raw);
}

export async function resolveUnresolvedUnitLabel(
  req: ResolveUnresolvedUnitLabelReq,
): Promise<UpdateUnresolvedUnitLabelsRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/unresolved-unit-label/resolve',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<UpdateUnresolvedUnitLabelsRsp>(raw);
}
