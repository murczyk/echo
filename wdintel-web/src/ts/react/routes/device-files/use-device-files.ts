import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DeviceFileFilters,
  DeviceFileSortBy,
  DeviceFileSortDirection,
  FileBreadcrumb,
} from '../../../../Bindings';
import { createDefaultDeviceFileFilters } from './helpers';
import { useDeviceFileSearchMode } from './use-device-file-search-mode';
import { useDeviceFileFilterOptions } from './use-device-file-filter-options';
import { isDeviceFolder, type DeviceFileSelection } from './device-file-archive';

import { useDeviceFileViewMode } from './use-device-file-view-mode';
import { useDeviceFileCounts } from './use-device-file-counts';
import { useDeviceFileTree } from './use-device-file-tree';
import { useDeviceFilesLoad } from './use-device-files.load';
import type { DeviceAnalyticsTagFilter } from './types';
import {
  setDeviceFileLink,
  useDeviceFileSearchLink,
  useDeviceDirectoryLink,
  useDeviceDirectoryRevision,
} from './use-device-file-link';
import { useDeviceDirectory } from './use-device-directory';
import { useDeviceFileMarkers } from './use-device-file-markers';
import { useDeviceFileBrowseRequests } from './use-device-file-browse-requests';
import { useLinkedDeviceFile, type DeviceFileSelectionState } from './use-linked-device-file';

export function useDeviceFiles({
  deviceId,
  syncId = null,
  enabled,
  tagFilter,
  linkedFile = null,
  filtersOpen,
  setFiltersOpen,
  treeActive,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
  linkedFile?: { fileId: string; revision: number | null } | null;
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean) => void;
  treeActive: boolean;
}) {
  const searchLocation = useDeviceFileSearchLink();
  const searchLocationKey = JSON.stringify(
    searchLocation && [
      searchLocation.query,
      searchLocation.scopeId,
      searchLocation.scopeRevision,
      searchLocation.global,
    ],
  );
  const linkedDirectory = useDeviceDirectoryLink();
  const linkedDirectoryRevision = useDeviceDirectoryRevision();
  const [viewMode, setViewMode] = useDeviceFileViewMode();
  const [sorting, setSorting] = useState<{
    by: DeviceFileSortBy;
    direction: DeviceFileSortDirection;
  }>({ by: 'name', direction: 'ascending' });
  const selectSort = useCallback((by: DeviceFileSortBy) => {
    setSorting((current) => ({
      by,
      direction:
        current.by === by && current.direction === 'ascending' ? 'descending' : 'ascending',
    }));
  }, []);
  const [filterState, setListingFilters] = useState<DeviceFileFilters>(
    createDefaultDeviceFileFilters,
  );
  const {
    archiveFailed,
    archiveEncrypted,
    favoritesOnly,
    unviewedOnly,
    hasContent: contentFilter,
  } = filterState;
  const setArchiveFailed = (value: boolean) =>
    setListingFilters((current) => ({ ...current, archiveFailed: value }));
  const setArchiveEncrypted = (value: boolean) =>
    setListingFilters((current) => ({ ...current, archiveEncrypted: value }));
  const setFavoritesOnly = (value: boolean) =>
    setListingFilters((current) => ({ ...current, favoritesOnly: value }));
  const setUnviewedOnly = (value: boolean) =>
    setListingFilters((current) => ({ ...current, unviewedOnly: value }));
  const setContentFilter = (value: boolean | null) =>
    setListingFilters((current) => ({ ...current, hasContent: value }));
  const [fileBreadcrumbs, setFileBreadcrumbs] = useState<FileBreadcrumb[]>([]);
  const listingFilters = { ...filterState, ...tagFilter };
  const filterDateError =
    listingFilters.modifiedFrom &&
    listingFilters.modifiedTo &&
    new Date(listingFilters.modifiedFrom) > new Date(listingFilters.modifiedTo)
      ? 'Початок періоду має бути не пізніше завершення.'
      : null;
  const validFilters = useRef(listingFilters);
  if (!filterDateError) validFilters.current = listingFilters;
  const appliedListingFilters = validFilters.current;
  const filterOptions = useDeviceFileFilterOptions({
    deviceId,
    syncId,
    enabled,
    active: filtersOpen,
  });
  const browseRequests = useDeviceFileBrowseRequests(
    JSON.stringify([deviceId, syncId, enabled, appliedListingFilters, sorting]),
  );
  const [archiveEpoch, setArchiveEpoch] = useState(0);
  const [selection, setSelection] = useState<DeviceFileSelectionState>(null);
  const selectedFile =
    enabled && selection?.deviceId === deviceId && selection.syncId === syncId
      ? selection.file
      : null;
  const selectedDirectory = linkedDirectory ?? selectedFile?.parentEntryId ?? null;
  const directoryRevision =
    linkedDirectory !== null
      ? linkedDirectoryRevision
      : (selectedFile?.archiveOrigin?.sourceRevision ?? linkedDirectoryRevision);
  const directoryActive = !linkedFile && searchLocation?.view !== 'results';
  const clearSelectedFile = useCallback(() => {
    setSelection(null);
    setDeviceFileLink(
      null,
      null,
      searchLocation?.view === 'results' ? searchLocation.scopeId : selectedDirectory,
      searchLocation?.view === 'results' ? searchLocation.scopeRevision : directoryRevision,
      { searchView: searchLocation?.view },
    );
  }, [selectedDirectory, directoryRevision, searchLocationKey, searchLocation?.view]);
  useEffect(() => setSelection(null), [deviceId, syncId, enabled]);
  const load = useDeviceFilesLoad({
    deviceId,
    syncId,
    enabled,
    tagFilter,
    hasContent: contentFilter,
    listingFilters: appliedListingFilters,
    favoritesOnly,
    unviewedOnly,
    archiveFailed,
    archiveEncrypted,
  });
  const directory = useDeviceDirectory({
    deviceId,
    syncId,
    enabled,
    active: directoryActive,
    readBrowse: browseRequests.read,
    refreshBrowse: browseRequests.readFresh,
    entryId: selectedDirectory,
    archiveRevision: directoryRevision,
    roots: load.roots,
    tagFilter,
    hasContent: contentFilter,
    listingFilters: appliedListingFilters,
    favoritesOnly,
    unviewedOnly,
    archiveFailed,
    archiveEncrypted,
    sortBy: sorting.by,
    sortDirection: sorting.direction,
  });
  const markers = useDeviceFileMarkers(deviceId, selectedFile);
  const openDirectory = useCallback(
    (entryId: string | null, archiveRevision: number | null = null, replace = false) => {
      setSelection(null);
      setFileBreadcrumbs([]);
      setDeviceFileLink(null, null, entryId, archiveRevision, { replace });
    },
    [],
  );
  const selectFile = useCallback(
    (file: DeviceFileSelection) => {
      if (isDeviceFolder(file)) {
        openDirectory(file.entryId, file.revision);
        return;
      }
      setFileBreadcrumbs([]);
      setSelection({ deviceId, syncId, file, revisionPinned: false });
      setDeviceFileLink(
        file.fileId,
        file.revision,
        file.parentEntryId,
        file.archiveOrigin?.sourceRevision ?? null,
        { searchView: searchLocation?.view },
      );
    },
    [deviceId, syncId, openDirectory, searchLocation?.view],
  );
  const openPreparedArchive = useCallback(
    (entryId: string, revision: number) => openDirectory(entryId, revision, true),
    [openDirectory],
  );
  useEffect(() => {
    const root = directory.breadcrumbs[0];
    if (selectedDirectory && root && !searchLocation)
      load.selectSearchScope({
        entryId: selectedDirectory,
        archiveRevision: directoryRevision,
        rootEntryId: root.entryId,
        label: directory.breadcrumbs.map((item) => item.name).join(' / '),
      });
  }, [
    selectedDirectory,
    directoryRevision,
    directory.breadcrumbs,
    load.selectSearchScope,
    searchLocationKey,
  ]);
  const searchMode = useDeviceFileSearchMode({
    deviceId,
    syncId,
    enabled,
    searchLocation,
    load,
    directoryId: selectedDirectory,
    directoryRevision,
    breadcrumbs: directory.breadcrumbs,
    clearSelection: () => setSelection(null),
  });
  const counts = useDeviceFileCounts({ deviceId, syncId, enabled });
  const tree = useDeviceFileTree({
    deviceId,
    syncId,
    enabled,
    active: treeActive,
    rootsReady: load.rootsReady,
    readBrowse: browseRequests.read,
    refreshBrowse: browseRequests.readFresh,
    roots: load.roots,
    hasContent: contentFilter,
    listingFilters: appliedListingFilters,
    onDirectoryMissing: load.handleDirectoryMissing,
    tagFilter,
    onAccessDenied: clearSelectedFile,
  });
  useEffect(() => {
    const controller = new AbortController();
    if (
      directory.breadcrumbs.length &&
      load.roots.some((root) => root.entryId === directory.breadcrumbs[0].entryId)
    )
      void tree.revealDirectory(directory.breadcrumbs, controller.signal);
    return () => controller.abort();
  }, [directory.breadcrumbs, load.roots, tree.revealDirectory]);
  const linkError = useLinkedDeviceFile({
    deviceId,
    syncId,
    enabled,
    linkedFile,
    selection,
    setSelection,
    roots: load.roots,
    rootsLoading: load.rootsLoading,
    revealFile: tree.revealFile,
    fileBreadcrumbs,
    setFileBreadcrumbs,
  });

  const countEntryIds = directory.entries
    .filter((entry) => entry.kind === 'directory' && !entry.archiveOrigin)
    .map((entry) => entry.entryId)
    .join(',');
  useEffect(() => {
    if (viewMode !== 'grid' || !directoryActive || directory.loading) return;
    counts.enqueue({
      parentEntryId: selectedDirectory,
      directoryEntryIds: countEntryIds.split(',').filter(Boolean),
    });
  }, [
    counts.enqueue,
    countEntryIds,
    selectedDirectory,
    viewMode,
    directoryActive,
    directory.loading,
    archiveEpoch,
  ]);
  const refreshVisible = useCallback(async () => {
    setArchiveEpoch((value) => value + 1);
    browseRequests.reset();
    counts.reset();
    await Promise.all([load.refreshVisible(), directory.refresh(), tree.refreshExpanded()]);
    markers.reset();
  }, [
    counts.enqueue,
    counts.reset,
    load.refreshVisible,
    browseRequests,
    tree.refreshExpanded,
    directory.refresh,
    markers.reset,
  ]);

  const visibleEntry = (entry: { isViewed: boolean; isFavorite: boolean }) =>
    (!favoritesOnly || entry.isFavorite) && (!unviewedOnly || !entry.isViewed);
  return {
    ...load,
    ...searchMode,
    deviceId,
    selectedDirectory,
    directoryRevision,
    openDirectory,
    openPreparedArchive,
    directory: {
      ...directory,
      entries: directory.entries
        .map(markers.withMarkers)
        .filter((entry) => entry.kind === 'directory' || visibleEntry(entry)),
    },
    breadcrumbs: selectedFile && fileBreadcrumbs.length ? fileBreadcrumbs : directory.breadcrumbs,
    viewMode,
    setViewMode,
    filtersOpen,
    setFiltersOpen,
    sorting,
    selectSort,
    favoritesOnly,
    setFavoritesOnly,
    unviewedOnly,
    setUnviewedOnly,
    archiveFailed,
    setArchiveFailed,
    archiveEncrypted,
    setArchiveEncrypted,
    markers,
    toggleFavorite: markers.toggleFavorite,
    favoritePending: markers.pending,
    toggleViewed: markers.toggleViewed,
    viewedPending: markers.viewedPending,
    markerError: markers.error,
    searchEntries: load.searchEntries
      .map(markers.withMarkers)
      .filter((entry) => entry.kind === 'directory' || visibleEntry(entry)),
    archiveEpoch,
    tagFilter,
    contentFilter,
    setContentFilter,
    listingFilters,
    appliedListingFilters,
    setListingFilters,
    filterDateError,
    filterOptions,
    tree: {
      ...tree,
      branches: Object.fromEntries(
        Object.entries(tree.branches).map(([id, branch]) => [
          id,
          {
            ...branch,
            entries: branch.entries
              .map(markers.withMarkers)
              .filter((entry) => entry.kind === 'directory' || visibleEntry(entry)),
          },
        ]),
      ),
    },
    counts,
    refreshVisible,
    selectedFile: selectedFile ? markers.withMarkers(selectedFile) : null,
    revisionPinned: selectedFile !== null && (selection?.revisionPinned ?? false),
    linkError,
    selectFile,
    clearSelectedFile,
  };
}

export type DeviceFilesState = ReturnType<typeof useDeviceFiles>;
