import { getJson, putJson } from './client';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

/** Per-account JSON object; keys are feature-specific (e.g. rerDutyNeo). Response body is this object directly. */
export type UserSettingsJson = JsonObject;

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserSettingsJson> {
  return getJson<UserSettingsJson>('/api/user/settings', { signal });
}

export async function saveUserSettings(
  body: UserSettingsJson,
  signal?: AbortSignal,
): Promise<UserSettingsJson> {
  return putJson<UserSettingsJson>('/api/user/settings', body, { signal });
}
