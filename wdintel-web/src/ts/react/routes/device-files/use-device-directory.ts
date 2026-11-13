import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DeviceFileContentRef,
  DeviceFileFilters,
  DeviceFileRoot,
  DeviceFileTreeEntry,
  FileBreadcrumb,
} from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { browseDeviceFiles } from '../../services/api/devices';
import {
  appendDeviceFileEntries,
  buildBrowseDeviceFilesReq,
  toDeviceFileLoadError,
} from './helpers';
import {
  DEVICE_FILE_DIRECTORY_HISTORY_LIMIT,
  type DeviceAnalyticsTagFilter,
  type DeviceFileLoadError,
  type DeviceFileScrollPositions,
} from './types';

type DirectoryState = {
  scope: string;
  archiveSource: DeviceFileContentRef | null;
  entries: DeviceFileTreeEntry[];
  breadcrumbs: FileBreadcrumb[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: DeviceFileLoadError | null;
  scrollPositions: DeviceFileScrollPositions;
};

function emptyDirectory(scope: string): DirectoryState {
  return {
    scope,
    archiveSource: null,
    entries: [],
    breadcrumbs: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    refreshing: false,
    error: null,
    scrollPositions: new Map(),
  };
}

function rootEntry(root: DeviceFileRoot): DeviceFileTreeEntry {
  return {
    ...root,
    parentEntryId: '',
    fileId: null,
    pathComponents: [root.name],
    absolutePath: null,
    hasContent: false,
    mimeType: null,
    extension: null,
    revision: null,
    syncId: null,
    sourceFileState: null,
    archive: null,
    isArchive: false,
    archiveOrigin: null,
    virtualPath: null,
    isViewed: false,
    sizeBytes: null,
  };
}

export function useDeviceDirectory({
  deviceId,
  syncId = null,
  archiveRevision = null,
  enabled,
  active = true,
  readBrowse = browseDeviceFiles,
  refreshBrowse = browseDeviceFiles,
  entryId,
  roots,
  tagFilter,
  hasContent = null,
  listingFilters = null,
  favoritesOnly = false,
  unviewedOnly = false,
  archiveFailed = false,
  archiveEncrypted = false,
  sortBy = null,
  sortDirection = null,
}: {
  deviceId: string;
  syncId?: string | null;
  archiveRevision?: number | null;
  enabled: boolean;
  active?: boolean;
  readBrowse?: typeof browseDeviceFiles;
  refreshBrowse?: typeof browseDeviceFiles;
  entryId: string | null;
  roots: DeviceFileRoot[];
  tagFilter: DeviceAnalyticsTagFilter;
  hasContent?: boolean | null;
  listingFilters?: DeviceFileFilters | null;
  favoritesOnly?: boolean;
  unviewedOnly?: boolean;
  archiveFailed?: boolean;
  archiveEncrypted?: boolean;
  sortBy?: import('../../../../Bindings').BrowseDeviceFilesReq['sortBy'];
  sortDirection?: import('../../../../Bindings').BrowseDeviceFilesReq['sortDirection'];
}) {
  const context = JSON.stringify({
    deviceId,
    syncId,
    enabled,
    tagFilter,
    hasContent,
    filters: listingFilters,
    favoritesOnly,
    unviewedOnly,
    archiveFailed,
    archiveEncrypted,
    sortBy,
    sortDirection,
  });
  const history = useMemo(() => new Map<string, DirectoryState>(), [context]);
  const scope = JSON.stringify({ context, entryId, archiveRevision });
  const [state, setState] = useState(() => emptyDirectory(scope));
  const stateRef = useRef(state);
  const scopeRef = useRef(scope);
  const requestRef = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const optionsRef = useRef({
    deviceId,
    syncId,
    archiveRevision,
    entryId,
    tagFilter,
    hasContent,
    filters: listingFilters,
    sortBy,
    sortDirection,
  });
  scopeRef.current = scope;
  optionsRef.current = {
    deviceId,
    syncId,
    archiveRevision,
    entryId,
    tagFilter,
    hasContent,
    filters: listingFilters,
    sortBy,
    sortDirection,
  };

  const update = useCallback((next: DirectoryState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(
    async (append = false, preserve = false) => {
      const options = optionsRef.current;
      if (!enabled || !activeRef.current || options.entryId === null || scopeRef.current !== scope)
        return;
      const previous = stateRef.current.scope === scope ? stateRef.current : emptyDirectory(scope);
      if (append && (requestRef.current || previous.nextCursor === null)) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      update({
        ...(append || preserve ? previous : emptyDirectory(scope)),
        loading: !append && !preserve,
        refreshing: !append && preserve,
        loadingMore: append,
        error: null,
      });

      try {
        const response = await (preserve && !append ? refreshBrowse : readBrowse)(
          {
            ...buildBrowseDeviceFilesReq({
              ...options,
              parentEntryId: options.entryId,
              cursor: append ? previous.nextCursor : null,
            }),
            favoritesOnly: favoritesOnly || null,
            unviewedOnly: unviewedOnly || null,
            archiveFailed: archiveFailed || null,
            archiveEncrypted: archiveEncrypted || null,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || scopeRef.current !== scope) return;
        const next = {
          ...emptyDirectory(scope),
          archiveSource: response.archiveSource ?? null,
          entries: append
            ? appendDeviceFileEntries(previous.entries, response.entries)
            : response.entries,
          breadcrumbs: response.breadcrumbs,
          nextCursor: response.nextCursor,
          scrollPositions: append ? previous.scrollPositions : new Map(),
        };
        history.delete(scope);
        history.set(scope, next);
        if (history.size > DEVICE_FILE_DIRECTORY_HISTORY_LIMIT)
          history.delete(history.keys().next().value!);
        update(next);
      } catch (error) {
        if (controller.signal.aborted || scopeRef.current !== scope || isAbortError(error)) return;
        const loadError = toDeviceFileLoadError(error, 'Помилка перегляду каталогу');
        const invalidScope = [401, 403, 404].includes(loadError.status ?? 0);
        if (invalidScope) history.clear();
        update({
          ...(invalidScope ? emptyDirectory(scope) : stateRef.current),
          loading: false,
          refreshing: false,
          loadingMore: false,
          error: loadError,
        });
        if (isUnauthorizedError(error)) redirectToLogin();
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    },
    [
      enabled,
      readBrowse,
      refreshBrowse,
      scope,
      favoritesOnly,
      unviewedOnly,
      archiveFailed,
      archiveEncrypted,
      history,
      update,
    ],
  );

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    const cached = history.get(scope);
    if (cached) {
      history.delete(scope);
      history.set(scope, cached);
      update(cached);
    } else {
      update(emptyDirectory(scope));
      if (activeRef.current) void load();
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [scope, load, history, update]);

  useEffect(() => {
    if (active && !history.has(scope) && !requestRef.current && !stateRef.current.error)
      void load();
  }, [active, scope, load, history]);

  const current = state.scope === scope ? state : (history.get(scope) ?? emptyDirectory(scope));
  const loadMore = useCallback(() => load(true), [load]);
  const refresh = useCallback(() => {
    history.clear();
    return load(false, true);
  }, [load, history]);
  return {
    ...current,
    entries: !enabled
      ? []
      : entryId === null
        ? (sortBy === 'name' && sortDirection === 'descending' ? [...roots].reverse() : roots).map(
            rootEntry,
          )
        : current.entries,
    loading:
      enabled &&
      entryId !== null &&
      ((state.scope !== scope && !history.has(scope)) || current.loading),
    loadMore,
    refresh,
  };
}
