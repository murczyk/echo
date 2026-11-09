import { useEffect, useState } from 'react';
import { ECHO_NAVIGATION_EVENT, requestNavigation } from '../../../browser/navigation-guard';
import type { DeviceAnalyticsTagFilter } from '../device-files/types';
import type { DeviceAnalyticsTagsState } from '../device-files/use-device-analytics-tags';
import type { useDeviceFileLink } from '../device-files/use-device-file-link';
import { DeviceDetailsSection, deviceSectionHref, readDeviceTagFilter } from './page-route';

export function useDevicePageNavigation({
  deviceId,
  section,
  linkedFile,
  tagsState,
}: {
  deviceId: string;
  section: DeviceDetailsSection;
  linkedFile: ReturnType<typeof useDeviceFileLink>;
  tagsState: DeviceAnalyticsTagsState;
}) {
  const isOverview = section === DeviceDetailsSection.Overview;
  useEffect(() => {
    if (isOverview && linkedFile) {
      void requestNavigation(
        deviceSectionHref(deviceId, DeviceDetailsSection.Files, window.location.search),
        { replace: true },
      );
    }
  }, [deviceId, isOverview, linkedFile?.fileId, linkedFile?.revision]);
  const [tagFilter, setTagFilter] = useState<DeviceAnalyticsTagFilter>(() =>
    readDeviceTagFilter(window.location.search),
  );
  const changeTagFilter = (filter: DeviceAnalyticsTagFilter) => {
    setTagFilter(filter);
    window.history.replaceState(
      window.history.state,
      '',
      deviceSectionHref(deviceId, section, window.location.search, filter),
    );
  };
  useEffect(() => {
    const restoreTagFilter = () => setTagFilter(readDeviceTagFilter(window.location.search));
    restoreTagFilter();
    window.addEventListener('popstate', restoreTagFilter);
    window.addEventListener(ECHO_NAVIGATION_EVENT, restoreTagFilter);
    return () => {
      window.removeEventListener('popstate', restoreTagFilter);
      window.removeEventListener(ECHO_NAVIGATION_EVENT, restoreTagFilter);
    };
  }, [deviceId, section]);
  useEffect(() => {
    if (!tagsState.loaded || tagsState.loading || tagsState.error !== null) return;
    const activeTagIds = new Set(tagsState.tags.map((tag) => tag.id));
    setTagFilter((current) => {
      const tagIds = current.tagIds.filter((tagId) => activeTagIds.has(tagId));
      return tagIds.length === current.tagIds.length ? current : { ...current, tagIds };
    });
  }, [tagsState.error, tagsState.loaded, tagsState.loading, tagsState.tags]);
  const homeHref = deviceSectionHref(
    deviceId,
    DeviceDetailsSection.Overview,
    window.location.search,
    tagFilter,
  );
  const backHref = isOverview ? '/devices' : homeHref;
  const backLabel = isOverview ? 'До списку пристроїв' : 'До пристрою';

  return { tagFilter, changeTagFilter, backHref, backLabel };
}
