import { useEffect, useRef } from 'react';
import type { FileBreadcrumb } from '../../../../Bindings';
import type { DeviceFileSelection } from './device-file-archive';
import type { DeviceFileScrollPositions } from './types';
import { createDefaultFileSearchDraft, validateFileSearchDraft } from './helpers';
import {
  setDeviceFileLink,
  setDeviceFileSearchLink,
  type useDeviceFileSearchLink,
} from './use-device-file-link';
import type { useDeviceFilesLoad } from './use-device-files.load';

export function useDeviceFileSearchMode({
  deviceId,
  syncId,
  enabled,
  searchLocation,
  load,
  directoryId,
  directoryRevision,
  breadcrumbs,
  clearSelection,
}: {
  deviceId: string;
  syncId: string | null;
  enabled: boolean;
  searchLocation: ReturnType<typeof useDeviceFileSearchLink>;
  load: ReturnType<typeof useDeviceFilesLoad>;
  directoryId: string | null;
  directoryRevision: number | null;
  breadcrumbs: FileBreadcrumb[];
  clearSelection: () => void;
}) {
  const searchLocationKey = JSON.stringify(
    searchLocation && [
      searchLocation.query,
      searchLocation.scopeId,
      searchLocation.scopeRevision,
      searchLocation.global,
    ],
  );
  const searchApplied = useRef<string | null>(null);
  const searchScrollPositions = useRef<DeviceFileScrollPositions>(new Map());
  useEffect(() => {
    const key = `${deviceId}:${syncId}:${searchLocationKey}`;
    if (!enabled) {
      searchApplied.current = null;
      return;
    }
    if (searchApplied.current === key) return;
    if (!searchLocation) {
      searchApplied.current = key;
      load.clearSearchResults();
      load.setSearchDraft(createDefaultFileSearchDraft());
      return;
    }
    const scopeId = searchLocation.scopeId ?? load.roots[0]?.entryId;
    if (!scopeId) return;
    searchApplied.current = key;
    searchScrollPositions.current = new Map();
    const draft = {
      ...createDefaultFileSearchDraft(),
      nameQuery: searchLocation.query,
      globalSearch: searchLocation.global || searchLocation.scopeId === null,
    };
    load.selectSearchScope({
      entryId: scopeId,
      archiveRevision: searchLocation.scopeRevision,
      rootEntryId: breadcrumbs[0]?.entryId ?? scopeId,
      label: breadcrumbs.map((item) => item.name).join(' / '),
    });
    load.setSearchDraft(draft);
    load.submitSearch(draft);
  }, [
    deviceId,
    syncId,
    enabled,
    searchLocationKey,
    load.roots,
    load.selectSearchScope,
    load.setSearchDraft,
    load.submitSearch,
    load.clearSearchResults,
  ]);
  const submitSearch = (globalSearch = false) => {
    if (Object.keys(validateFileSearchDraft(load.searchDraft)).length) {
      load.submitSearch();
      return;
    }
    const query = load.searchDraft.nameQuery.trim();
    if (!query) return;
    clearSelection();
    const scopeId = searchLocation?.view === 'results' ? searchLocation.scopeId : directoryId;
    setDeviceFileSearchLink(
      query,
      scopeId,
      searchLocation?.view === 'results' ? searchLocation.scopeRevision : directoryRevision,
      globalSearch,
    );
  };
  const returnToSearch = () => {
    if (!searchLocation) return;
    clearSelection();
    setDeviceFileLink(null, null, searchLocation.scopeId, searchLocation.scopeRevision, {
      searchView: 'results',
    });
  };
  const clearSearchResults = () => {
    clearSelection();
    load.clearSearchResults();
    load.setSearchDraft(createDefaultFileSearchDraft());
    setDeviceFileLink(
      null,
      null,
      searchLocation?.view === 'results' ? searchLocation.scopeId : directoryId,
      searchLocation?.view === 'results' ? searchLocation.scopeRevision : directoryRevision,
      { clearSearch: true },
    );
  };
  const openSearchParent = (entry: DeviceFileSelection) => {
    clearSelection();
    load.clearSearchResults();
    load.setSearchDraft(createDefaultFileSearchDraft());
    setDeviceFileLink(
      null,
      null,
      entry.parentEntryId,
      entry.archiveOrigin?.sourceRevision ?? null,
      { clearSearch: true },
    );
  };
  return {
    searchLocation,
    searchResultsVisible: searchLocation !== null && searchLocation.view === 'results',
    searchScrollPositions: searchScrollPositions.current,
    submitSearch,
    clearSearchResults,
    returnToSearch,
    openSearchParent,
  };
}
