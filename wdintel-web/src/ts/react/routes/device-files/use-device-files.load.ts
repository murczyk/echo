import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { listDeviceFileRoots, searchDeviceFiles } from '../../services/api/devices';
import {
  appendDeviceFileEntries,
  buildSearchDeviceFilesReq,
  buildSearchFingerprint,
  createDefaultFileSearchDraft,
  toDeviceFileLoadError,
  validateFileSearchDraft,
} from './helpers';
import type {
  DeviceAnalyticsTagFilter,
  DeviceFileLoadError,
  DeviceFileSearchDraft,
  DeviceFileSearchScope,
  DeviceFileSearchValidationErrors,
} from './types';

type LoadOptions = { append?: boolean; preserve?: boolean };

export function useDeviceFilesLoad({
  deviceId,
  syncId = null,
  enabled,
  tagFilter,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
}) {
  const [roots, setRoots] = useState<DeviceFileRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(enabled);
  const [rootsRefreshing, setRootsRefreshing] = useState(false);
  const [rootsError, setRootsError] = useState<DeviceFileLoadError | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [searchScope, setSearchScope] = useState<DeviceFileSearchScope | null>(null);
  const [searchDraft, setSearchDraftState] = useState<DeviceFileSearchDraft>(
    createDefaultFileSearchDraft,
  );
  const [appliedSearchDraft, setAppliedSearchDraft] = useState<DeviceFileSearchDraft | null>(null);
  const [searchValidationErrors, setSearchValidationErrors] =
    useState<DeviceFileSearchValidationErrors>({});
  const [searchEntries, setSearchEntries] = useState<DeviceFileTreeEntry[]>([]);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchRefreshing, setSearchRefreshing] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<DeviceFileLoadError | null>(null);
  const [searchLoadMoreError, setSearchLoadMoreError] = useState<DeviceFileLoadError | null>(null);

  const dataScope = `${deviceId}:${syncId ?? 'all'}`;
  const [resultScope, setResultScope] = useState(dataScope);
  const previousDeviceRef = useRef(deviceId);
  const rootsRef = useRef<DeviceFileRoot[]>([]);
  const searchScopeRef = useRef<DeviceFileSearchScope | null>(null);
  const searchNextCursorRef = useRef<string | null>(null);
  const searchFingerprintRef = useRef<string | null>(null);
  const appliedSearchDraftRef = useRef<DeviceFileSearchDraft | null>(null);
  const tagFilterKey = JSON.stringify(tagFilter);
  const tagFilterRef = useRef(tagFilter);
  const tagFilterKeyRef = useRef(tagFilterKey);
  const rootsSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const rootsAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  tagFilterRef.current = tagFilter;

  const replaceSearchScope = useCallback((scope: DeviceFileSearchScope | null) => {
    searchScopeRef.current = scope;
    setSearchScope(scope);
  }, []);

  const resetSearchResults = useCallback(() => {
    searchAbortRef.current?.abort();
    searchSeqRef.current += 1;
    searchFingerprintRef.current = null;
    searchNextCursorRef.current = null;
    appliedSearchDraftRef.current = null;
    setAppliedSearchDraft(null);
    setSearchEntries([]);
    setSearchNextCursor(null);
    setSearchLoading(false);
    setSearchRefreshing(false);
    setSearchLoadingMore(false);
    setSearchError(null);
    setSearchLoadMoreError(null);
  }, []);

  const loadRoots = useCallback(
    async (preserve = rootsRef.current.length > 0) => {
      if (!enabled) return;

      const seq = ++rootsSeqRef.current;
      rootsAbortRef.current?.abort();
      const controller = new AbortController();
      rootsAbortRef.current = controller;
      if (preserve) setRootsRefreshing(true);
      else setRootsLoading(true);
      setRootsError(null);

      try {
        const rsp = await listDeviceFileRoots({ deviceId, syncId }, { signal: controller.signal });
        if (rootsSeqRef.current !== seq || controller.signal.aborted) return;

        setRoots(rsp.roots);
        rootsRef.current = rsp.roots;
        const currentScope = searchScopeRef.current;
        const currentRoot = currentScope
          ? (rsp.roots.find((root) => root.entryId === currentScope.rootEntryId) ?? null)
          : null;

        if (rsp.roots.length === 0) {
          if (currentScope !== null) {
            replaceSearchScope(null);
            resetSearchResults();
            setScopeNotice('Файлові корені більше не існують.');
          }
        } else if (currentScope === null || currentRoot === null) {
          const firstRoot = rsp.roots[0];
          replaceSearchScope({
            entryId: firstRoot.entryId,
            rootEntryId: firstRoot.entryId,
            label: firstRoot.name,
          });
          resetSearchResults();
          if (currentScope !== null) {
            setScopeNotice(
              'Корінь області пошуку більше не існує. Вибрано перший доступний корінь.',
            );
          }
        } else if (
          currentScope.entryId === currentScope.rootEntryId &&
          currentScope.label !== currentRoot.name
        ) {
          replaceSearchScope({ ...currentScope, label: currentRoot.name });
        }
      } catch (error) {
        if (rootsSeqRef.current !== seq || controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        setRootsError(toDeviceFileLoadError(error, 'Помилка завантаження коренів'));
      } finally {
        if (rootsSeqRef.current === seq) {
          setRootsLoading(false);
          setRootsRefreshing(false);
        }
        if (rootsAbortRef.current === controller) rootsAbortRef.current = null;
      }
    },
    [deviceId, syncId, enabled, replaceSearchScope, resetSearchResults],
  );

  const fallbackToRoots = useCallback(
    (message: string) => {
      replaceSearchScope(null);
      resetSearchResults();
      setScopeNotice(message);
      void loadRoots(true);
    },
    [loadRoots, replaceSearchScope, resetSearchResults],
  );

  const loadSearch = useCallback(
    async (draft: DeviceFileSearchDraft, options?: LoadOptions) => {
      const scope = searchScopeRef.current;
      if (!enabled || scope === null) return;
      const currentTagFilter = tagFilterRef.current;
      const append = options?.append ?? false;
      const preserve = options?.preserve ?? false;
      const fingerprint = buildSearchFingerprint(
        deviceId,
        scope.entryId,
        draft,
        currentTagFilter,
        syncId,
      );
      if (append && searchFingerprintRef.current !== fingerprint) return;

      const cursor = append ? searchNextCursorRef.current : null;
      if (append && cursor === null) return;
      const seq = ++searchSeqRef.current;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      searchFingerprintRef.current = fingerprint;
      if (append) setSearchLoadingMore(true);
      else if (preserve) setSearchRefreshing(true);
      else setSearchLoading(true);
      if (append) setSearchLoadMoreError(null);
      else setSearchError(null);
      if (!append && !preserve) {
        searchNextCursorRef.current = null;
        setSearchNextCursor(null);
        setSearchEntries([]);
      }

      try {
        const rsp = await searchDeviceFiles(
          buildSearchDeviceFilesReq({
            deviceId,
            syncId,
            scopeEntryId: scope.entryId,
            draft,
            cursor,
            tagFilter: currentTagFilter,
          }),
          { signal: controller.signal },
        );
        if (
          searchSeqRef.current !== seq ||
          controller.signal.aborted ||
          searchFingerprintRef.current !== fingerprint
        ) {
          return;
        }

        setSearchEntries((current) =>
          append ? appendDeviceFileEntries(current, rsp.entries) : rsp.entries,
        );
        searchNextCursorRef.current = rsp.nextCursor;
        setSearchNextCursor(rsp.nextCursor);
      } catch (error) {
        if (searchSeqRef.current !== seq || controller.signal.aborted || isAbortError(error))
          return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        const loadError = toDeviceFileLoadError(error, 'Помилка пошуку файлів');
        if (loadError.status === 404 && syncId === null) {
          fallbackToRoots('Область пошуку більше не існує. Вибрано перший доступний корінь.');
        } else if (append) {
          setSearchLoadMoreError(loadError);
        } else {
          setSearchError(loadError);
        }
      } finally {
        if (searchSeqRef.current === seq) {
          setSearchLoading(false);
          setSearchRefreshing(false);
          setSearchLoadingMore(false);
        }
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      }
    },
    [deviceId, syncId, enabled, fallbackToRoots, tagFilterKey],
  );

  const selectSearchScope = useCallback(
    (scope: DeviceFileSearchScope) => {
      const currentScope = searchScopeRef.current;
      setScopeNotice(null);
      if (
        currentScope?.entryId === scope.entryId &&
        currentScope.rootEntryId === scope.rootEntryId
      ) {
        replaceSearchScope(scope);
        return;
      }
      resetSearchResults();
      replaceSearchScope(scope);
    },
    [replaceSearchScope, resetSearchResults],
  );

  const handleDirectoryMissing = useCallback(
    (entryId: string) => {
      if (searchScopeRef.current?.entryId === entryId) {
        fallbackToRoots('Область пошуку більше не існує. Вибрано перший доступний корінь.');
      } else {
        setScopeNotice('Один із каталогів більше не існує. Файлові корені оновлено.');
        void loadRoots(true);
      }
    },
    [fallbackToRoots, loadRoots],
  );

  const setSearchDraft = useCallback((draft: DeviceFileSearchDraft) => {
    setSearchDraftState(draft);
    setSearchValidationErrors({});
  }, []);

  const submitSearch = useCallback(() => {
    const validationErrors = validateFileSearchDraft(searchDraft);
    setSearchValidationErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0 || searchScopeRef.current === null) return;

    const appliedDraft = { ...searchDraft, kinds: [...searchDraft.kinds] };
    appliedSearchDraftRef.current = appliedDraft;
    setAppliedSearchDraft(appliedDraft);
    void loadSearch(appliedDraft);
  }, [loadSearch, searchDraft]);

  const refreshVisible = useCallback(async () => {
    await loadRoots(true);
    const appliedDraft = appliedSearchDraftRef.current;
    if (appliedDraft !== null && searchScopeRef.current !== null) {
      await loadSearch(appliedDraft, { preserve: true });
    }
  }, [loadRoots, loadSearch]);
  useEffect(() => {
    if (tagFilterKeyRef.current === tagFilterKey) return;
    tagFilterKeyRef.current = tagFilterKey;
    const appliedDraft = appliedSearchDraftRef.current;
    if (enabled && appliedDraft !== null && searchScopeRef.current !== null) {
      void loadSearch(appliedDraft);
    }
  }, [enabled, loadSearch, tagFilterKey]);

  const loadSearchRef = useRef(loadSearch);
  loadSearchRef.current = loadSearch;
  useEffect(() => {
    const sameDevice = previousDeviceRef.current === deviceId;
    previousDeviceRef.current = deviceId;
    const appliedDraft = sameDevice ? appliedSearchDraftRef.current : null;
    setResultScope(dataScope);
    rootsAbortRef.current?.abort();
    searchAbortRef.current?.abort();
    rootsSeqRef.current += 1;
    searchSeqRef.current += 1;
    searchScopeRef.current = null;
    searchNextCursorRef.current = null;
    searchFingerprintRef.current = null;
    appliedSearchDraftRef.current = appliedDraft;
    rootsRef.current = [];
    setRoots([]);
    setRootsLoading(enabled);
    setRootsRefreshing(false);
    setRootsError(null);
    setScopeNotice(null);
    setSearchScope(null);
    if (!sameDevice) setSearchDraftState(createDefaultFileSearchDraft());
    setSearchValidationErrors({});
    setAppliedSearchDraft(null);
    setSearchEntries([]);
    setSearchNextCursor(null);
    setSearchLoading(false);
    setSearchRefreshing(false);
    setSearchLoadingMore(false);
    setSearchError(null);
    setSearchLoadMoreError(null);
    if (enabled) {
      const controller = new AbortController();
      void loadRoots(false).then(() => {
        if (controller.signal.aborted || appliedDraft === null || searchScopeRef.current === null)
          return;
        appliedSearchDraftRef.current = appliedDraft;
        setAppliedSearchDraft(appliedDraft);
        void loadSearchRef.current(appliedDraft);
      });
      return () => {
        controller.abort();
        rootsAbortRef.current?.abort();
        searchAbortRef.current?.abort();
      };
    }

    return () => {
      rootsAbortRef.current?.abort();
      searchAbortRef.current?.abort();
    };
  }, [dataScope, deviceId, syncId, enabled, loadRoots]);

  return {
    roots: resultScope === dataScope ? roots : [],
    rootsLoading: resultScope !== dataScope || rootsLoading,
    rootsRefreshing,
    rootsError,
    scopeNotice,
    searchScope,
    searchDraft,
    appliedSearchDraft,
    searchActive: appliedSearchDraft !== null,
    searchValidationErrors,
    searchEntries: resultScope === dataScope ? searchEntries : [],
    searchNextCursor: resultScope === dataScope ? searchNextCursor : null,
    searchLoading,
    searchRefreshing,
    searchLoadingMore,
    searchError,
    searchLoadMoreError,
    setSearchDraft,
    reloadRoots: () => loadRoots(true),
    selectSearchScope,
    handleDirectoryMissing,
    submitSearch,
    clearSearchResults: resetSearchResults,
    retrySearch: () =>
      appliedSearchDraftRef.current === null
        ? Promise.resolve()
        : loadSearch(appliedSearchDraftRef.current, { preserve: searchEntries.length > 0 }),
    loadMoreSearch: () =>
      appliedSearchDraftRef.current === null
        ? Promise.resolve()
        : loadSearch(appliedSearchDraftRef.current, { append: true }),
    refreshVisible,
  };
}
