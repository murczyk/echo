import { postJson } from './client';

export type RestartEchoPayload = {
  restartPostgres: boolean;
  restartOutdatedSources: boolean;
};

type RestartEchoRequestBody = {
  restart_postgres: boolean;
  restart_outdated_sources: boolean;
};

function toRestartEchoRequestBody(payload: RestartEchoPayload): RestartEchoRequestBody {
  return {
    restart_postgres: payload.restartPostgres,
    restart_outdated_sources: payload.restartOutdatedSources,
  };
}

export async function restartEcho(payload: RestartEchoPayload): Promise<boolean> {
  return postJson<boolean>('/api/admin/restart-echo', toRestartEchoRequestBody(payload));
}

export async function restartDatasource(datasourceId: number): Promise<boolean> {
  return postJson<boolean>('/api/admin/restart-datasource', datasourceId);
}
