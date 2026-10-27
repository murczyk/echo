import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BrowseDeviceFilesReq,
  DeviceFileRoot,
  DeviceFileTreeEntry,
  LocateDeviceFileRsp,
} from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { browseDeviceFiles } from '../../services/api/devices';
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
};

type BranchRequest = {
  id: number;
  controller: AbortController;
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
  roots,
  tagFilter,
  hasContent = null,
  onDirectoryMissing,
  onDirectoriesLoaded,
  onAccessDenied,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  roots: DeviceFileRoot[];
  tagFilter: DeviceAnalyticsTagFilter;
  hasContent?: BrowseDeviceFilesReq['hasContent'];
  onDirectoryMissing: (entryId: string) => void;
  onDirectoriesLoaded: (parentEntryId: string, directoryEntryIds: string[]) => void;
  onAccessDenied?: () => void;
}) {
  const dataScope = `${deviceId}:${syncId ?? 'all'}:${hasContent}`;
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
  const requestIdRef = useRef(0);
  const tagFilterKey = JSON.stringify(tagFilter);
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

  const abortAllRequests = useCallback(() => {
    for (const request of requestsRef.current.values()) request.controller.abort();
    requestsRef.current.clear();
  }, []);

  const loadBranch = useCallback(
    async (parentEntryId: string, options?: BranchLoadOptions) => {
      if (!enabled) return false;

      const append = options?.append ?? false;
      const preserve = options?.preserve ?? false;
      const currentBranch = branchesRef.current[parentEntryId] ?? createEmptyBranch();
      const archiveRevision = options?.archiveRevision ?? currentBranch.archiveRevision;
      const cursor = append ? currentBranch.nextCursor : null;
      if (append && (cursor === null || currentBranch.loadingMore)) return false;

      requestsRef.current.get(parentEntryId)?.controller.abort();
      const controller = new AbortController();
      const request: BranchRequest = { id: ++requestIdRef.current, controller };
      requestsRef.current.set(parentEntryId, request);

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

      try {
        const rsp = await browseDeviceFiles(
          buildBrowseDeviceFilesReq({
            deviceId,
            syncId,
            archiveRevision,
            parentEntryId,
            cursor,
            hasContent,
            tagFilter: tagFilterRef.current,
          }),
          { signal: controller.signal },
        );
        const activeRequest = requestsRef.current.get(parentEntryId);
        if (activeRequest?.id !== request.id || controller.signal.aborted) return false;

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
        if (activeRequest?.id !== request.id || controller.signal.aborted || isAbortError(error)) {
          return false;
        }
        const loadError = toDeviceFileLoadError(error, 'Помилка перегляду каталогу');
        const denied = [401, 403].includes(loadError.status ?? 0);
        const missing = loadError.status === 404;
        if (denied) {
          abortAllRequests();
          branchesRef.current = {};
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
    },
    [deviceId, syncId, enabled, tagFilterKey, hasContent, updateBranch, abortAllRequests],
  );

  const toggleDirectory = useCallback(
    (entryId: string) => {
      const nextExpandedEntryIds = new Set(expandedEntryIdsRef.current);
      if (nextExpandedEntryIds.has(entryId)) {
        nextExpandedEntryIds.delete(entryId);
      } else {
        nextExpandedEntryIds.add(entryId);
        const branch = branchesRef.current[entryId];
        if (!branch || branch.error) void loadBranch(entryId);
      }
      expandedEntryIdsRef.current = nextExpandedEntryIds;
      setExpandedEntryIds(nextExpandedEntryIds);
    },
    [loadBranch],
  );

  const revealFile = useCallback(
    async (located: LocateDeviceFileRsp, signal: AbortSignal) => {
      if (signal.aborted || (hasContent !== null && located.file.hasContent !== hasContent))
        return false;
      const path = [...located.ancestors, located.file];
      const parentIds = [located.rootEntryId, ...located.ancestors.map((entry) => entry.entryId)];
      const expanded = new Set([...expandedEntryIdsRef.current, ...parentIds]);
      expandedEntryIdsRef.current = expanded;
      setExpandedEntryIds(expanded);
      const loaded = await Promise.all(
        parentIds.map((parentId) => {
          const ancestor = located.ancestors.find((entry) => entry.entryId === parentId);
          return loadBranch(parentId, {
            preserve: true,
            archiveRevision:
              ancestor?.isArchive || ancestor?.archiveOrigin ? ancestor.revision : null,
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
            [locatedEntry],
          ),
        }));
      });
      return true;
    },
    [hasContent, loadBranch, updateBranch],
  );

  const refreshExpanded = useCallback(async () => {
    if (!enabled) return;
    const entryIds = new Set([
      ...rootsRef.current.map((root) => root.entryId),
      ...expandedEntryIdsRef.current,
    ]);
    await Promise.all([...entryIds].map((entryId) => loadBranch(entryId, { preserve: true })));
  }, [enabled, loadBranch]);

  useEffect(() => {
    if (!enabled) return;
    for (const [parentEntryId, branch] of Object.entries(branches)) {
      const directoryEntryIds = branch.entries
        .filter((entry) => entry.kind === 'directory' && !entry.archiveOrigin)
        .map((entry) => entry.entryId);
      if (directoryEntryIds.length > 0) {
        onDirectoriesLoadedRef.current(parentEntryId, directoryEntryIds);
      }
    }
  }, [branches, enabled]);

  const rootsKey = roots.map((root) => root.entryId).join('|');
  useEffect(() => {
    abortAllRequests();
    setResultScope(dataScope);
    branchesRef.current = {};
    setBranches({});

    const rootEntryIds = rootsRef.current.map((root) => root.entryId);
    const nextExpandedEntryIds = new Set(rootEntryIds);
    expandedEntryIdsRef.current = nextExpandedEntryIds;
    setExpandedEntryIds(nextExpandedEntryIds);

    if (enabled) {
      for (const entryId of rootEntryIds) void loadBranch(entryId);
    }

    return abortAllRequests;
  }, [abortAllRequests, dataScope, deviceId, enabled, loadBranch, rootsKey]);

  return {
    branches: resultScope === dataScope ? branches : {},
    expandedEntryIds: resultScope === dataScope ? expandedEntryIds : new Set<string>(),
    refreshing: Object.values(branches).some(
      (branch) => branch.loading || branch.refreshing || branch.loadingMore,
    ),
    toggleDirectory,
    retryBranch: (entryId: string) => loadBranch(entryId, { preserve: true }),
    loadMoreBranch: (entryId: string) => loadBranch(entryId, { append: true }),
    refreshExpanded,
    revealFile,
  };
}
