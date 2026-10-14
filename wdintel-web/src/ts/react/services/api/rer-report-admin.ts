import type {
  CreateRerReportMetadataReq,
  DeleteRerReportMetadataReq,
  ReplaceRerReportAccessListReq,
  RerReportAccessListRsp,
  RerReportMetadataItem,
  RerReportMetadataListRsp,
  UpdateRerReportMetadataReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, postVoid } from './client';

export async function getRerReportAccessList(): Promise<RerReportAccessListRsp> {
  const raw = await postJson<unknown>('/api/admin/rer-report/access-list');
  return transformSnakeToCamel<RerReportAccessListRsp>(raw);
}

export async function replaceRerReportAccessList(
  req: ReplaceRerReportAccessListReq,
): Promise<RerReportAccessListRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/rer-report/access-list/replace',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<RerReportAccessListRsp>(raw);
}

export async function listRerReportMetadata(): Promise<RerReportMetadataItem[]> {
  const raw = await postJson<unknown>('/api/admin/rer-report/metadata');
  return transformSnakeToCamel<RerReportMetadataListRsp>(raw).items;
}

export async function createRerReportMetadata(
  req: CreateRerReportMetadataReq,
): Promise<RerReportMetadataItem> {
  const raw = await postJson<unknown>(
    '/api/admin/rer-report/metadata/create',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<RerReportMetadataItem>(raw);
}

export async function updateRerReportMetadata(
  req: UpdateRerReportMetadataReq,
): Promise<RerReportMetadataItem> {
  const raw = await postJson<unknown>(
    '/api/admin/rer-report/metadata/update',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<RerReportMetadataItem>(raw);
}

export async function deleteRerReportMetadata(req: DeleteRerReportMetadataReq): Promise<void> {
  await postVoid('/api/admin/rer-report/metadata/delete', transformCamelToSnake(req));
}
