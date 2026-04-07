import type { DutyTagsLayout, UserDutySettingsDto } from '../../../../Bindings';

import { getJson, putJson } from './client';
import type { TagsLayoutVariant } from '../../routes/rer-duty-neo/utils';

export type { UserDutySettingsDto };
export type UserDutySettings = {
  tagsLayout: TagsLayoutVariant;
  disableAutoScroll: boolean;
};

function normalizeTagsLayout(tagsLayout: DutyTagsLayout | null | undefined): TagsLayoutVariant {
  switch (tagsLayout) {
    case 'Compact':
      return 'compact';
    case 'Hidden':
      return 'hidden';
    default:
      return 'compact';
  }
}

function serializeTagsLayout(tagsLayout: TagsLayoutVariant): DutyTagsLayout {
  switch (tagsLayout) {
    case 'compact':
      return 'Compact';
    case 'hidden':
      return 'Hidden';
    default:
      return 'Full';
  }
}

function normalizeUserDutySettings(raw: UserDutySettingsDto): UserDutySettings {
  return {
    tagsLayout: normalizeTagsLayout(raw.tagsLayout),
    disableAutoScroll: raw.disableAutoScroll,
  };
}

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserDutySettings> {
  const response = await getJson<UserDutySettingsDto>('/api/user/settings', { signal });
  return normalizeUserDutySettings(response);
}

export async function saveUserSettings(
  body: UserDutySettings,
  signal?: AbortSignal,
): Promise<UserDutySettings> {
  const response = await putJson<UserDutySettingsDto>(
    '/api/user/settings',
    {
      tagsLayout: serializeTagsLayout(body.tagsLayout),
      disableAutoScroll: body.disableAutoScroll,
    },
    { signal },
  );
  return normalizeUserDutySettings(response);
}
