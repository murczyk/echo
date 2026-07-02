import {
  ApiIntegration,
  ListApiIntegrationsRsp,
  TestIggyConnectionReq,
  UpsertApiIntegrationReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, postVoid } from './client';

export async function listApiIntegrations(): Promise<ApiIntegration[]> {
  const raw = await postJson<unknown>('/api/admin/api-integrations');
  return transformSnakeToCamel<ListApiIntegrationsRsp>(raw).items;
}

export async function upsertApiIntegration(req: UpsertApiIntegrationReq): Promise<ApiIntegration> {
  const raw = await postJson<unknown>(
    '/api/admin/api-integrations/upsert',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<ApiIntegration>(raw);
}

export async function deleteApiIntegration(id: number): Promise<void> {
  await postVoid('/api/admin/api-integrations/delete', { id });
}

export async function testConnection(req: TestIggyConnectionReq): Promise<void> {
  await postVoid('/api/admin/api-integrations/iggy/test-connection', transformCamelToSnake(req));
}
