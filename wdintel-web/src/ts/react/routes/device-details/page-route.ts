import type { DeviceAnalyticsTagFilter } from '../device-files/types';

export enum DeviceDetailsSection {
  Overview = 'analytical',
  Files = 'files',
  Journal = 'journal',
  Audio = 'audio',
}

export function readDeviceSection(value: string | null): DeviceDetailsSection {
  return (
    Object.values(DeviceDetailsSection).find((section) => section === value) ??
    DeviceDetailsSection.Overview
  );
}

export function readDeviceTagFilter(search: string): DeviceAnalyticsTagFilter {
  const query = new URLSearchParams(search);
  const untagged = query.get('untagged') === '1';
  return {
    tagIds: untagged
      ? []
      : (query.get('tag_ids') ?? '')
          .split(',')
          .filter((id) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
          ),
    tagMatch: query.get('tag_match') === 'all' ? 'all' : 'any',
    untagged,
  };
}

export function deviceSectionHref(
  deviceId: string,
  section: DeviceDetailsSection,
  search = '',
  filter?: DeviceAnalyticsTagFilter,
): string {
  const query = new URLSearchParams(search);
  if (section !== DeviceDetailsSection.Files) {
    for (const key of ['sync_id', 'file', 'revision', 'extraction', 'section']) query.delete(key);
  }
  if (filter) {
    for (const key of ['tag_ids', 'tag_match', 'untagged']) query.delete(key);
    if (filter.untagged) query.set('untagged', '1');
    else if (filter.tagIds.length > 0) {
      query.set('tag_ids', filter.tagIds.join(','));
      if (filter.tagMatch === 'all') query.set('tag_match', 'all');
    }
  }
  const suffix = section === DeviceDetailsSection.Overview ? '' : `/${section}`;
  const serialized = query.toString();
  return `/devices/${encodeURIComponent(deviceId)}${suffix}${serialized ? `?${serialized}` : ''}`;
}
