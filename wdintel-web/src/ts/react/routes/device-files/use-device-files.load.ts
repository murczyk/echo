import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import {
  browseDeviceFiles,
  listDeviceFileRoots,
  searchDeviceFiles,
} from '../../services/api/devices';
import {
  appendDeviceFileEntries,
  buildBrowseDeviceFilesReq,
  buildBrowseFingerprint,
  buildSearchDeviceFilesReq,
  buildSearchFingerprint,
  createDefaultFileSearchDraft,
  toDeviceFileLoadError,
  validateFileSearchDraft,
} from './helpers';
import type {
  DeviceFileLoadError,
  DeviceFileSearchDraft,
  DeviceFileSearchValidationErrors,
} from './types';

type LoadOptions = { append?: boolean; preserve?: boolean };

export function useDeviceFilesLoad({ deviceId, enabled }: { deviceId: string; enabled: boolean }) {
  const [roots, setRoots] = useState<DeviceFileRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(enabled);
  const [rootsRefreshing, setRootsRefreshing] = useState(false);
  const [rootsError, setRootsError] = useState<DeviceFileLoadError | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [browseParentId, setBrowseParentId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ entryId: string; name: string }>>([]);
  const [browseEntries, setBrowseEntries] = useState<DeviceFileTreeEntry[]>([]);
  const [browseNextCursor, setBrowseNextCursor] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseRefreshing, setBrowseRefreshing] = useState(false);
  const [browseLoadingMore, setBrowseLoadingMore] = useState(false);
  const [browseError, setBrowseError] = useState<DeviceFileLoadError | null>(null);
  const [browseLoadMoreError, setBrowseLoadMoreError] = useState<DeviceFileLoadError | null>(null);
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
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

  const rootsRef = useRef<DeviceFileRoot[]>([]);
  const selectedRootIdRef = useRef<string | null>(null);
  const browseParentIdRef = useRef<string | null>(null);
  const browseNextCursorRef = useRef<string | null>(null);
  const browseFingerprintRef = useRef<string | null>(null);
  const searchNextCursorRef = useRef<string | null>(null);
  const searchFingerprintRef = useRef<string | null>(null);
  const appliedSearchDraftRef = useRef<DeviceFileSearchDraft | null>(null);
  const modeRef = useRef<'browse' | 'search'>('browse');
  const rootsSeqRef = useRef(0);
  const browseSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const rootsAbortRef = useRef<AbortController | null>(null);
  const browseAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const changeMode = useCallback((nextMode: 'browse' | 'search') => {
    modeRef.current = nextMode;
    setMode(nextMode);
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
        const rsp = await listDeviceFileRoots({ deviceId }, { signal: controller.signal });
        if (rootsSeqRef.current !== seq || controller.signal.aborted) return;

        rootsRef.current = rsp.roots;
        setRoots(rsp.roots);
        const selectedId = selectedRootIdRef.current;
        if (selectedId !== null && !rsp.roots.some((root) => root.entryId === selectedId)) {
          selectedRootIdRef.current = null;
          browseParentIdRef.current = null;
          browseNextCursorRef.current = null;
          browseFingerprintRef.current = null;
          searchNextCursorRef.current = null;
          searchFingerprintRef.current = null;
          appliedSearchDraftRef.current = null;
          setSelectedRootId(null);
          setBrowseParentId(null);
          setBreadcrumbs([]);
          setBrowseEntries([]);
          setBrowseNextCursor(null);
          setSearchEntries([]);
          setSearchNextCursor(null);
          setAppliedSearchDraft(null);
          setScopeNotice('Корінь більше не існує. Виберіть інший корінь файлової системи.');
          changeMode('browse');
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
    [changeMode, deviceId, enabled],
  );

  const fallbackToRoots = useCallback(
    (message: string) => {
      browseAbortRef.current?.abort();
      searchAbortRef.current?.abort();
      selectedRootIdRef.current = null;
      browseParentIdRef.current = null;
      browseNextCursorRef.current = null;
      browseFingerprintRef.current = null;
      searchNextCursorRef.current = null;
      searchFingerprintRef.current = null;
      appliedSearchDraftRef.current = null;
      setSelectedRootId(null);
      setBrowseParentId(null);
      setBreadcrumbs([]);
      setBrowseEntries([]);
      setBrowseNextCursor(null);
      setBrowseError(null);
      setBrowseLoadMoreError(null);
      setSearchEntries([]);
      setSearchNextCursor(null);
      setAppliedSearchDraft(null);
      setSearchError(null);
      setSearchLoadMoreError(null);
      setScopeNotice(message);
      changeMode('browse');
      void loadRoots(true);
    },
    [changeMode, loadRoots],
  );

  const loadBrowse = useCallback(
    async (parentEntryId: string, options?: LoadOptions) => {
      if (!enabled) return;
      const append = options?.append ?? false;
      const preserve = options?.preserve ?? false;
      const fingerprint = buildBrowseFingerprint(deviceId, parentEntryId);
      if (append && browseFingerprintRef.current !== fingerprint) return;

      const cursor = append ? browseNextCursorRef.current : null;
      if (append && cursor === null) return;
      const seq = ++browseSeqRef.current;
      browseAbortRef.current?.abort();
      const controller = new AbortController();
      browseAbortRef.current = controller;
      browseFingerprintRef.current = fingerprint;
      if (append) setBrowseLoadingMore(true);
      else if (preserve) setBrowseRefreshing(true);
      else setBrowseLoading(true);
      if (append) setBrowseLoadMoreError(null);
      else setBrowseError(null);
      if (!append && !preserve) {
        browseNextCursorRef.current = null;
        setBrowseNextCursor(null);
        setBrowseEntries([]);
        setBreadcrumbs([]);
      }

      try {
        const rsp = await browseDeviceFiles(
          buildBrowseDeviceFilesReq({ deviceId, parentEntryId, cursor }),
          { signal: controller.signal },
        );
        if (
          browseSeqRef.current !== seq ||
          controller.signal.aborted ||
          browseFingerprintRef.current !== fingerprint
        ) {
          return;
        }

        setBreadcrumbs(rsp.breadcrumbs);
        setBrowseEntries((current) =>
          append ? appendDeviceFileEntries(current, rsp.entries) : rsp.entries,
        );
        browseNextCursorRef.current = rsp.nextCursor;
        setBrowseNextCursor(rsp.nextCursor);
      } catch (error) {
        if (browseSeqRef.current !== seq || controller.signal.aborted || isAbortError(error))
          return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        const loadError = toDeviceFileLoadError(error, 'Помилка перегляду каталогу');
        if (loadError.status === 404) {
          fallbackToRoots('Каталог більше не існує. Виберіть корінь файлової системи.');
        } else if (append) {
          setBrowseLoadMoreError(loadError);
        } else {
          setBrowseError(loadError);
        }
      } finally {
        if (browseSeqRef.current === seq) {
          setBrowseLoading(false);
          setBrowseRefreshing(false);
          setBrowseLoadingMore(false);
        }
        if (browseAbortRef.current === controller) browseAbortRef.current = null;
      }
    },
    [deviceId, enabled, fallbackToRoots],
  );

  const loadSearch = useCallback(
    async (draft: DeviceFileSearchDraft, options?: LoadOptions) => {
      const scopeEntryId = browseParentIdRef.current;
      if (!enabled || scopeEntryId === null) return;
      const append = options?.append ?? false;
      const preserve = options?.preserve ?? false;
      const fingerprint = buildSearchFingerprint(deviceId, scopeEntryId, draft);
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
          buildSearchDeviceFilesReq({ deviceId, scopeEntryId, draft, cursor }),
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
        if (loadError.status === 404) {
          fallbackToRoots('Область пошуку більше не існує. Виберіть корінь файлової системи.');
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
    [deviceId, enabled, fallbackToRoots],
  );

  const resetSearchScope = useCallback(() => {
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

  const selectRoot = useCallback(
    (root: DeviceFileRoot) => {
      selectedRootIdRef.current = root.entryId;
      browseParentIdRef.current = root.entryId;
      setSelectedRootId(root.entryId);
      setBrowseParentId(root.entryId);
      setScopeNotice(null);
      resetSearchScope();
      changeMode('browse');
      void loadBrowse(root.entryId);
    },
    [changeMode, loadBrowse, resetSearchScope],
  );

  const openDirectory = useCallback(
    (entryId: string) => {
      browseParentIdRef.current = entryId;
      setBrowseParentId(entryId);
      resetSearchScope();
      changeMode('browse');
      void loadBrowse(entryId);
    },
    [changeMode, loadBrowse, resetSearchScope],
  );

  const setSearchDraft = useCallback((draft: DeviceFileSearchDraft) => {
    setSearchDraftState(draft);
    setSearchValidationErrors({});
  }, []);

  const submitSearch = useCallback(() => {
    const validationErrors = validateFileSearchDraft(searchDraft);
    setSearchValidationErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0 || browseParentIdRef.current === null) return;

    const appliedDraft = { ...searchDraft, kinds: [...searchDraft.kinds] };
    appliedSearchDraftRef.current = appliedDraft;
    setAppliedSearchDraft(appliedDraft);
    changeMode('search');
    void loadSearch(appliedDraft);
  }, [changeMode, loadSearch, searchDraft]);

  const backToBrowse = useCallback(() => changeMode('browse'), [changeMode]);

  const refreshVisible = useCallback(async () => {
    const tasks: Promise<void>[] = [loadRoots(true)];
    if (modeRef.current === 'search' && appliedSearchDraftRef.current !== null) {
      tasks.push(loadSearch(appliedSearchDraftRef.current, { preserve: true }));
    } else if (browseParentIdRef.current !== null) {
      tasks.push(loadBrowse(browseParentIdRef.current, { preserve: true }));
    }
    await Promise.all(tasks);
  }, [loadBrowse, loadRoots, loadSearch]);

  useEffect(() => {
    rootsRef.current = [];
    selectedRootIdRef.current = null;
    browseParentIdRef.current = null;
    browseNextCursorRef.current = null;
    searchNextCursorRef.current = null;
    appliedSearchDraftRef.current = null;
    setRoots([]);
    setSelectedRootId(null);
    setBrowseParentId(null);
    setBreadcrumbs([]);
    setBrowseEntries([]);
    setSearchEntries([]);
    setAppliedSearchDraft(null);
    setScopeNotice(null);
    setSearchDraftState(createDefaultFileSearchDraft());
    changeMode('browse');
    if (enabled) void loadRoots(false);

    return () => {
      rootsAbortRef.current?.abort();
      browseAbortRef.current?.abort();
      searchAbortRef.current?.abort();
    };
  }, [changeMode, deviceId, enabled, loadRoots]);

  return {
    roots,
    rootsLoading,
    rootsRefreshing,
    rootsError,
    scopeNotice,
    selectedRootId,
    browseParentId,
    breadcrumbs,
    browseEntries,
    browseNextCursor,
    browseLoading,
    browseRefreshing,
    browseLoadingMore,
    browseError,
    browseLoadMoreError,
    mode,
    searchDraft,
    appliedSearchDraft,
    searchValidationErrors,
    searchEntries,
    searchNextCursor,
    searchLoading,
    searchRefreshing,
    searchLoadingMore,
    searchError,
    searchLoadMoreError,
    setSearchDraft,
    reloadRoots: () => loadRoots(true),
    selectRoot,
    openDirectory,
    retryBrowse: () =>
      browseParentIdRef.current === null
        ? Promise.resolve()
        : loadBrowse(browseParentIdRef.current, { preserve: browseEntries.length > 0 }),
    loadMoreBrowse: () =>
      browseParentIdRef.current === null
        ? Promise.resolve()
        : loadBrowse(browseParentIdRef.current, { append: true }),
    submitSearch,
    backToBrowse,
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
