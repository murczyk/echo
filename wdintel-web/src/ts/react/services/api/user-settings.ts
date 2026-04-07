import type { DutyTagsLayout, UserDutySettingsDto } from '../../../../Bindings';

import { getJson, putJson } from './client';
import type { TagsLayoutVariant } from '../../routes/rer-duty-neo/utils';

export type UserDutySettings = {
  tagsLayout: TagsLayoutVariant;
  disableAutoScroll: boolean;
};

function normalizeTagsLayout(value: DutyTagsLayout): TagsLayoutVariant {
  switch (value) {
    case 'Full':
      return 'full';
    case 'Hidden':
      return 'hidden';
    case 'Compact':
    default:
      return 'compact';
  }
}

function toTagsLayoutDto(value: TagsLayoutVariant): DutyTagsLayout {
  switch (value) {
    case 'full':
      return 'Full';
    case 'hidden':
      return 'Hidden';
    case 'compact':
    default:
      return 'Compact';
  }
}

function normalizeUserDutySettings(dto: UserDutySettingsDto): UserDutySettings {
  return {
    tagsLayout: normalizeTagsLayout(dto.tagsLayout),
    disableAutoScroll: dto.disableAutoScroll,
  };
}

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserDutySettings> {
  const dto = await getJson<UserDutySettingsDto>('/api/user/settings', { signal });
  return normalizeUserDutySettings(dto);
}

export async function saveUserSettings(
  body: UserDutySettings,
  signal?: AbortSignal,
): Promise<UserDutySettings> {
  const dto = await putJson<UserDutySettingsDto>(
    '/api/user/settings',
    {
      tagsLayout: toTagsLayoutDto(body.tagsLayout),
      disableAutoScroll: body.disableAutoScroll,
    },
    { signal },
  );
  return normalizeUserDutySettings(dto);
}
