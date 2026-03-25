import { postJson } from './client';

export type GoiRestartService = 'swapp' | 'goi';
export type CurrentUserGoiControlState = {
  canRestart: boolean;
  restartUnavailableReason: string | null;
};

type RestartCurrentUserGoiServiceReqBody = {
  service: GoiRestartService;
};

type CurrentUserGoiControlStateLike = {
  canRestart?: boolean;
  can_restart?: boolean;
  restartUnavailableReason?: string | null;
  restart_unavailable_reason?: string | null;
};

function toRestartCurrentUserGoiServiceReqBody(service: GoiRestartService): RestartCurrentUserGoiServiceReqBody {
  return { service };
}

function normalizeCurrentUserGoiControlState(
  raw: CurrentUserGoiControlStateLike | null | undefined,
): CurrentUserGoiControlState {
  return {
    canRestart: raw?.canRestart ?? raw?.can_restart ?? false,
    restartUnavailableReason:
      raw?.restartUnavailableReason ?? raw?.restart_unavailable_reason ?? null,
  };
}

export async function fetchCurrentUserGoiControlState(signal?: AbortSignal): Promise<CurrentUserGoiControlState> {
  const data = await postJson<CurrentUserGoiControlStateLike>(
    '/api/organism/goi-settings/current-user-control-state',
    undefined,
    { signal },
  );
  return normalizeCurrentUserGoiControlState(data);
}

export async function restartCurrentUserGoiService(service: GoiRestartService): Promise<void> {
  await postJson<boolean>(
    '/api/organism/goi-settings/restart-service',
    toRestartCurrentUserGoiServiceReqBody(service),
  );
}
