import type { UserDutySettingsDto } from '../../../../Bindings';

import { getJson, putJson } from './client';

export type { UserDutySettingsDto };
export type UserDutySettings = UserDutySettingsDto;

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserDutySettingsDto> {
  return getJson<UserDutySettingsDto>('/api/user/settings', { signal });
}

export async function saveUserSettings(
  body: UserDutySettingsDto,
  signal?: AbortSignal,
): Promise<UserDutySettingsDto> {
  return putJson<UserDutySettingsDto>('/api/user/settings', body, { signal });
}
