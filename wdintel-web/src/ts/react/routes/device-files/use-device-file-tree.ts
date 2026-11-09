import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BrowseDeviceFilesReq,
  DeviceFileFilters,
  DeviceFileRoot,
  DeviceFileTreeEntry,
  FileBreadcrumb,
  LocateDeviceFileRsp,
} from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { browseDeviceFiles, locateDeviceFile } from '../../services/api/devices';
import {
  appendDeviceFileEntries,
  buildBrowseDeviceFilesReq,
  toDeviceFileLoadError,
} from './helpers';
import type { DeviceAnalyticsTagFilter, DeviceFileLoadError } from './types';

export type DeviceFileTreeBranch = {
  archiveRevision: number | null;
  entries: DeviceFileTreeEntry[];
  nextCursor: string | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: DeviceFileLoadError | null;
  loadMoreError: DeviceFileLoadError | null;
};

type BranchLoadOptions = {
  archiveRevision?: number | null;
  append?: boolean;
  preserve?: boolean;
  force?: boolean;
};

type BranchRequest = {
  id: number;
  controller: AbortController;
  archiveRevision: number | null;
  cursor: string | null;
  options: BranchLoadOptions;
  promise: Promise<boolean>;
};

function createEmptyBranch(): DeviceFileTreeBranch {
  return {
    archiveRevision: null,
    entries: [],
    nextCursor: null,
    loading: false,
    refreshing: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  };
}

export function useDeviceFileTree({
  deviceId,
  syncId = null,
  enabled,
  active = true,
  rootsReady = true,
  readBrowse = browseDeviceFiles,
  refreshBrowse = browseDeviceFiles,
  roots,
  tagFilter,
  hasContent = null,
  listingFilters = null,
  onDirectoryMissing,
  onDirectoriesLoaded,
  onAccessDenied,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  active?: boolean;
  rootsReady?: boolean;
  readBrowse?: typeof browseDeviceFiles;
  refreshBrowse?: typeof browseDeviceFiles;
  roots: DeviceFileRoot[];
  tagFilter: DeviceAnalyticsTagFilter;
  hasContent?: BrowseDeviceFilesReq['hasContent'];
  listingFilters?: DeviceFileFilters | null;
  onDirectoryMissing: (entryId: string) => void;
  onDirectoriesLoaded?: (parentEntryId: string, directoryEntryIds: string[]) => void;
  onAccessDenied?: () => void;
}) {
  const dataScope = JSON.stringify([deviceId, syncId, hasContent, listingFilters, tagFilter]);
  const [resultScope, setResultScope] = useState(dataScope);
  const [branches, setBranches] = useState<Record<string, DeviceFileTreeBranch>>({});
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(new Set());
  const branchesRef = useRef<Record<string, DeviceFileTreeBranch>>({});
  const expandedEntryIdsRef = useRef<Set<string>>(new Set());
  const rootsRef = useRef(roots);
  const onDirectoryMissingRef = useRef(onDirectoryMissing);
  const onDirectoriesLoadedRef = useRef(onDirectoriesLoaded);
  const onAccessDeniedRef = useRef(onAccessDenied);
  const requestsRef = useRef(new Map<string, BranchRequest>());
  const interruptedRef = useRef(new Map<string, BranchLoadOptions>());
  const loadedEntryIdsRef = useRef(new Set<string>());
  const requestIdRef = useRef(0);
  const tagFilterKey = JSON.stringify([tagFilter, listingFilters]);
  const listingFiltersRef = useRef(listingFilters);
  listingFiltersRef.current = listingFilters;
  const tagFilterRef = useRef(tagFilter);

  rootsRef.current = roots;
  onDirectoryMissingRef.current = onDirectoryMissing;
  onDirectoriesLoadedRef.current = onDirectoriesLoaded;
  onAccessDeniedRef.current = onAccessDenied;
  tagFilterRef.current = tagFilter;

  const updateBranch = useCallback(
    (entryId: string, update: (branch: DeviceFileTreeBranch) => DeviceFileTreeBranch) => {
      const branch = update(branchesRef.current[entryId] ?? createEmptyBranch());
      const nextBranches = { ...branchesRef.current, [entryId]: branch };
      branchesRef.current = nextBranches;
      setBranches(nextBranches);
    },
    [],
  );

  const abortAllRequests = useCallback((preserve = false) => {
    if (!preserve) interruptedRef.current.clear();
    const nextBranches = { ...branchesRef.current };
    for (const [entryId, request] of requestsRef.current) {
      if (preserve) interruptedRef.current.set(entryId, request.options);
      request.controller.abort();
      const branch = nextBranches[entryId];
      if (branch)
        nextBranches[entryId] = {
          ...branch,
          loading: false,
          refreshing: false,
          loadingMore: false,
        };
    }
    if (requestsRef.current.size) {
      branchesRef.current = nextBranches;
      setBranches(nextBranches);
    }
    requestsRef.current.clear();
  }, []);

  const loadBranch = useCallback(
    async (parentEntryId: string, options?: BranchLoadOptions) => {
      if (!enabled || !active || !rootsReady) return false;

      const append = options?.append ?? false;
      const preserve = options?.preserve ?? false;
      const currentBranch = branchesRef.current[parentEntryId] ?? createEmptyBranch();
      const archiveRevision =
        options?.archiveRevision === undefined
          ? currentBranch.archiveRevision
          : options.archiveRevision;
      const cursor = append ? currentBranch.nextCursor : null;
      if (append && (cursor === null || currentBranch.loadingMore)) return false;

      const pending = requestsRef.current.get(parentEntryId);
      if (
        pending &&
        !options?.force &&
        pending.archiveRevision === archiveRevision &&
        pending.cursor === cursor
      )
        return pending.promise;
      pending?.controller.abort();
      const controller = new AbortController();
      const request: BranchRequest = {
        id: ++requestIdRef.current,
        controller,
        archiveRevision,
        cursor,
        options: { ...options, archiveRevision, append, preserve },
        promise: Promise.resolve(false),
      };
      requestsRef.current.set(parentEntryId, request);
      interruptedRef.current.delete(parentEntryId);

      updateBranch(parentEntryId, (branch) => ({
        ...branch,
        archiveRevision,
        entries: append || preserve ? branch.entries : [],
        nextCursor: append || preserve ? branch.nextCursor : null,
        loading: !append && !preserve,
        refreshing: !append && preserve,
        loadingMore: append,
        error: append ? branch.error : null,
        loadMoreError: null,
      }));

      const execute = async () => {
        try {
          const rsp = await (options?.force ? refreshBrowse : readBrowse)(
            buildBrowseDeviceFilesReq({
              deviceId,
              syncId,
              archiveRevision,
              parentEntryId,
              cursor,
              hasContent,
              filters: listingFiltersRef.current,
              tagFilter: tagFilterRef.current,
              includeBreadcrumbs: false,
            }),
            { signal: controller.signal },
          );
          const activeRequest = requestsRef.current.get(parentEntryId);
          if (activeRequest?.id !== request.id || controller.signal.aborted) return false;
          loadedEntryIdsRef.current.add(parentEntryId);

          updateBranch(parentEntryId, (branch) => ({
            ...branch,
            entries: append ? appendDeviceFileEntries(branch.entries, rsp.entries) : rsp.entries,
            nextCursor: rsp.nextCursor,
            error: null,
            loadMoreError: null,
          }));
          return true;
        } catch (error) {
          const activeRequest = requestsRef.current.get(parentEntryId);
          if (
            activeRequest?.id !== request.id ||
            controller.signal.aborted ||
            isAbortError(error)
          ) {
            return false;
          }
          const loadError = toDeviceFileLoadError(error, 'Помилка перегляду каталогу');
          const denied = [401, 403].includes(loadError.status ?? 0);
          const missing = loadError.status === 404;
          if (denied) {
            abortAllRequests();
            branchesRef.current = {};
            loadedEntryIdsRef.current.clear();
            setBranches({});
            onAccessDeniedRef.current?.();
          }
          if (isUnauthorizedError(error)) {
            redirectToLogin();
            return false;
          }

          updateBranch(parentEntryId, (branch) => ({
            ...branch,
            entries: missing ? [] : branch.entries,
            nextCursor: missing ? null : branch.nextCursor,
            loading: false,
            refreshing: false,
            loadingMore: false,
            error: append && !denied && !missing ? branch.error : loadError,
            loadMoreError: append && !denied && !missing ? loadError : null,
          }));
          if (loadError.status === 404 && syncId === null)
            onDirectoryMissingRef.current(parentEntryId);
          return false;
        } finally {
          const activeRequest = requestsRef.current.get(parentEntryId);
          if (activeRequest?.id === request.id) {
            requestsRef.current.delete(parentEntryId);
            updateBranch(parentEntryId, (branch) => ({
              ...branch,
              loading: false,
              refreshing: false,
              loadingMore: false,
            }));
          }
        }
      };
      request.promise = execute();
      return request.promise;
    },
    [
      deviceId,
      syncId,
      enabled,
      active,
      rootsReady,
      readBrowse,
      refreshBrowse,
      tagFilterKey,
      hasContent,
      updateBranch,
      abortAllRequests,
    ],
  );

  const toggleDirectory = useCallback(
    (entryId: string) => {
      const nextExpandedEntryIds = new Set(expandedEntryIdsRef.current);
      if (nextExpandedEntryIds.has(entryId)) {
        nextExpandedEntryIds.delete(entryId);
      } else {
        nextExpandedEntryIds.add(entryId);
        const branch = branchesRef.current[entryId];
        const interrupted = interruptedRef.current.get(entryId);
        if (interrupted || !loadedEntryIdsRef.current.has(entryId) || branch?.error)
          void loadBranch(entryId, interrupted);
      }
      expandedEntryIdsRef.current = nextExpandedEntryIds;
      setExpandedEntryIds(nextExpandedEntryIds);
    },
    [loadBranch],
  );

  const revealDirectory = useCallback(
    async (breadcrumbs: FileBreadcrumb[], signal: AbortSignal) => {
      if (signal.aborted || !active || !rootsReady) return;
      const expanded = new Set([
        ...expandedEntryIdsRef.current,
        ...breadcrumbs.map((entry) => entry.entryId),
      ]);
      expandedEntryIdsRef.current = expanded;
      setExpandedEntryIds(expanded);
      for (const [index, { entryId, archiveRevision = null }] of breadcrumbs.entries()) {
        if (signal.aborted) return;
        const parentEntryId = breadcrumbs[index - 1]?.entryId;
        const ancestor = parentEntryId
          ? branchesRef.current[parentEntryId]?.entries.find((entry) => entry.entryId === entryId)
          : undefined;
        if (
          parentEntryId &&
          ancestor?.kind === 'file' &&
          archiveRevision !== null &&
          ancestor.revision !== archiveRevision
        ) {
          try {
            const located = await locateDeviceFile(
              { deviceId, fileId: ancestor.fileId!, revision: archiveRevision },
              { signal },
            );
            if (signal.aborted) return;
            updateBranch(parentEntryId, (branch) => ({
              ...branch,
              entries: branch.entries.map((entry) =>
                entry.entryId === entryId ? located.file : entry,
              ),
            }));
          } catch (error) {
            if (signal.aborted || isAbortError(error)) return;
            const loadError = toDeviceFileLoadError(error, 'Помилка відкриття ревізії архіву');
            updateBranch(entryId, (branch) => ({ ...branch, error: loadError }));
            if ([401, 403].includes(loadError.status ?? 0)) onAccessDeniedRef.current?.();
            if (isUnauthorizedError(error)) redirectToLogin();
            return;
          }
        }
        const branch = branchesRef.current[entryId];
        if (
          !loadedEntryIdsRef.current.has(entryId) ||
          branch.loading ||
          branch.refreshing ||
          branch.archiveRevision !== archiveRevision
        ) {
          if (!(await loadBranch(entryId, { archiveRevision }))) return;
        }
      }
    },
    [deviceId, active, rootsReady, loadBranch, updateBranch],
  );

  const revealFile = useCallback(
    async (located: LocateDeviceFileRsp, signal: AbortSignal) => {
      if (signal.aborted || (hasContent !== null && located.file.hasContent !== hasContent))
        return false;
      if (!active) return true;
      const path = [...located.ancestors, located.file];
      const parentIds = [located.rootEntryId, ...located.ancestors.map((entry) => entry.entryId)];
      const expanded = new Set([...expandedEntryIdsRef.current, ...parentIds]);
      expandedEntryIdsRef.current = expanded;
      setExpandedEntryIds(expanded);
      const loaded = await Promise.all(
        parentIds.map((parentId, index) => {
          const ancestor = located.ancestors.find((entry) => entry.entryId === parentId);
          const branch = branchesRef.current[parentId];
          const archiveRevision =
            ancestor?.isArchive || ancestor?.archiveOrigin ? ancestor.revision : null;
          const entry = branch?.entries.find((entry) => entry.entryId === path[index].entryId);
          if (
            loadedEntryIdsRef.current.has(parentId) &&
            !branch.error &&
            branch.archiveRevision === archiveRevision &&
            entry &&
            (entry.revision === path[index].revision || entry.kind === 'directory')
          )
            return true;
          return loadBranch(parentId, {
            preserve: true,
            archiveRevision,
            force: loadedEntryIdsRef.current.has(parentId),
          });
        }),
      );
      if (signal.aborted || loaded.some((success) => !success)) return false;
      parentIds.forEach((parentId, index) => {
        const locatedEntry = path[index];
        updateBranch(parentId, (branch) => ({
          ...branch,
          entries: appendDeviceFileEntries(
            branch.entries.map((entry) =>
              entry.entryId === locatedEntry.entryId ? locatedEntry : entry,
            ),
            listingFiltersRef.current &&
              (listingFiltersRef.current.favoritesOnly ||
                listingFiltersRef.current.unviewedOnly ||
                listingFiltersRef.current.archiveFailed ||
                listingFiltersRef.current.archiveEncrypted ||
                listingFiltersRef.current.fileTypes.length > 0 ||
                listingFiltersRef.current.extensions.length > 0 ||
                listingFiltersRef.current.modifiedFrom !== null ||
                listingFiltersRef.current.modifiedTo !== null ||
                listingFiltersRef.current.tagIds.length > 0 ||
                listingFiltersRef.current.untagged)
              ? []
              : [locatedEntry],
          ),
        }));
      });
      return true;
    },
    [active, hasContent, loadBranch, updateBranch],
  );

  const refreshExpanded = useCallback(async () => {
    if (!enabled || !active || !rootsReady) return;
    const entryIds = new Set([
      ...rootsRef.current.map((root) => root.entryId),
      ...expandedEntryIdsRef.current,
    ]);
    await Promise.all(
      [...entryIds].map((entryId) => loadBranch(entryId, { preserve: true, force: true })),
    );
  }, [enabled, active, rootsReady, loadBranch]);

  useEffect(() => {
    if (!enabled) return;
    for (const [parentEntryId, branch] of Object.entries(branches)) {
      const directoryEntryIds = branch.entries
        .filter((entry) => entry.kind === 'directory' && !entry.archiveOrigin)
        .map((entry) => entry.entryId);
      if (directoryEntryIds.length > 0) {
        onDirectoriesLoadedRef.current?.(parentEntryId, directoryEntryIds);
      }
    }
  }, [branches, enabled]);

  const rootsKey = roots.map((root) => root.entryId).join('|');
  useEffect(() => {
    abortAllRequests();
    setResultScope(dataScope);
    branchesRef.current = {};
    loadedEntryIdsRef.current.clear();
    setBranches({});

    const rootEntryIds = rootsRef.current.map((root) => root.entryId);
    const nextExpandedEntryIds = new Set(rootEntryIds);
    expandedEntryIdsRef.current = nextExpandedEntryIds;
    setExpandedEntryIds(nextExpandedEntryIds);

    return abortAllRequests;
  }, [abortAllRequests, dataScope, deviceId, enabled, rootsKey]);

  useEffect(() => {
    if (!active) abortAllRequests(true);
    if (!enabled || !active || !rootsReady) return;
    const entries = new Set([
      ...rootsRef.current.map((root) => root.entryId),
      ...expandedEntryIdsRef.current,
    ]);
    for (const entryId of entries) {
      const interrupted = interruptedRef.current.get(entryId);
      if (interrupted || !loadedEntryIdsRef.current.has(entryId))
        void loadBranch(entryId, interrupted);
    }
  }, [enabled, active, rootsReady, loadBranch, rootsKey, abortAllRequests]);

  return {
    branches: resultScope === dataScope ? branches : {},
    expandedEntryIds: resultScope === dataScope ? expandedEntryIds : new Set<string>(),
    refreshing: Object.values(branches).some(
      (branch) => branch.loading || branch.refreshing || branch.loadingMore,
    ),
    toggleDirectory,
    retryBranch: (entryId: string) => loadBranch(entryId, { preserve: true, force: true }),
    loadMoreBranch: (entryId: string) => loadBranch(entryId, { append: true }),
    refreshExpanded,
    revealFile,
    revealDirectory,
  };
}
