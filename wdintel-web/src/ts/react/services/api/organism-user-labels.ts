import type {
  AssignOrganismUserLabelReq,
  DeleteOrganismUserLabelReq,
  OrganismUserLabel,
  OrganismUserLabelsRsp,
  UpsertOrganismUserLabelReq,
  SetOrganismMessageStatsExclusionReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';

export async function listOrganismUserLabels(organismId: number): Promise<OrganismUserLabelsRsp> {
  const response = transformSnakeToCamel<OrganismUserLabelsRsp>(
    await postJson('/api/organism/user-labels', organismId),
  );
  return { ...response, excludedLoginIds: response.excludedLoginIds ?? [] };
}
export async function upsertOrganismUserLabel(
  req: UpsertOrganismUserLabelReq,
): Promise<OrganismUserLabel> {
  return transformSnakeToCamel<OrganismUserLabel>(
    await postJson('/api/organism/user-labels/upsert', transformCamelToSnake(req)),
  );
}
export async function deleteOrganismUserLabel(req: DeleteOrganismUserLabelReq): Promise<void> {
  await postJson('/api/organism/user-labels/delete', transformCamelToSnake(req));
}
export async function assignOrganismUserLabel(req: AssignOrganismUserLabelReq): Promise<void> {
  await postJson('/api/organism/user-labels/assign', transformCamelToSnake(req));
}

export async function setOrganismMessageStatsExclusion(
  req: SetOrganismMessageStatsExclusionReq,
): Promise<void> {
  await postJson('/api/organism/message-stats-exclusion', transformCamelToSnake(req));
}
