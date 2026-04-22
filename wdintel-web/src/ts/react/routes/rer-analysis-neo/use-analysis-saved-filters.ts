import type { AnalysisStatsReq, SavedFilter } from '../../../../Bindings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { deleteAnalysisSavedFilter, listAnalysisSavedFilters, renameAnalysisSavedFilter, upsertAnalysisSavedFilter } from '../../services/api/analysis';
import {
  buildAnalysisReq,
  clearQueryStateFromSavedFilter,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
} from './helpers';
import type { AnalysisQueryState } from './types';

type Props = {
  allFrequencies: string[];
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  setQueryState: Dispatch<SetStateAction<AnalysisQueryState>>;
};

type Result = {
  applySavedFilter: (savedFilter: SavedFilter | null) => void;
  deleteLoadedSavedFilter: () => Promise<void>;
  isDirty: boolean;
  loadedSavedFilter: SavedFilter | null;
  renameExisting: () => Promise<void>;
  saveAsNew: () => Promise<void>;
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  setSavedFilterName: (name: string) => void;
  updateExisting: () => Promise<void>;
};

type AppliedSavedFilterSnapshot = {
  baseQueryState: AnalysisQueryState;
  savedFilter: SavedFilter;
};

export function refreshAppliedSavedFilterSnapshot(
  snapshot: AppliedSavedFilterSnapshot | null,
  queryState: AnalysisQueryState,
  savedFilter: SavedFilter,
  req: AnalysisStatsReq,
): AppliedSavedFilterSnapshot {
  return {
    baseQueryState: snapshot?.baseQueryState ?? queryState,
    savedFilter: {
      ...savedFilter,
      req,
    },
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час роботи зі збереженими фільтрами.';
}

export function useAnalysisSavedFilters({ allFrequencies, onError, onUnauthorized, queryState, setQueryState }: Props): Result {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [loadedSavedFilterId, setLoadedSavedFilterId] = useState<number | null>(null);
  const [savedFilterName, setSavedFilterName] = useState('');
  const [saveInFlight, setSaveInFlight] = useState(false);
  const loadedSavedFilterSnapshotRef = useRef<AppliedSavedFilterSnapshot | null>(null);

  const loadedSavedFilter = useMemo(
    () => savedFilters.find((savedFilter) => savedFilter.id === loadedSavedFilterId) ?? null,
    [loadedSavedFilterId, savedFilters],
  );

  const isDirty = useMemo(() => {
    if (!loadedSavedFilter) return false;
    return !queryStateMatchesSavedFilter(queryState, loadedSavedFilter, allFrequencies);
  }, [allFrequencies, loadedSavedFilter, queryState]);

  const loadSavedFilters = useCallback(async () => {
    const next = await listAnalysisSavedFilters();
    setSavedFilters(next);
    return next;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadSavedFilters();
      } catch (savedError) {
        if (!onUnauthorized(savedError)) {
          onError(toErrorMessage(savedError));
        }
      }
    })();
  }, [loadSavedFilters, onError, onUnauthorized]);

  const applySavedFilter = useCallback(
    (savedFilter: SavedFilter | null) => {
      if (savedFilter == null) {
        const snapshot = loadedSavedFilterSnapshotRef.current;
        setQueryState((current) =>
          snapshot == null
            ? current
            : clearQueryStateFromSavedFilter(
                current,
                snapshot.baseQueryState,
                queryStateFromSavedFilter(snapshot.savedFilter, snapshot.baseQueryState),
              ),
        );
        setLoadedSavedFilterId(null);
        setSavedFilterName('');
        loadedSavedFilterSnapshotRef.current = null;
        return;
      }

      const current = queryState;
      const nextState = queryStateFromSavedFilter(savedFilter, current);
      loadedSavedFilterSnapshotRef.current = {
        baseQueryState: current,
        savedFilter,
      };
      setLoadedSavedFilterId(savedFilter?.id ?? null);
      setSavedFilterName(savedFilter.name);
      setQueryState(nextState);
    },
    [queryState, setQueryState],
  );

  const saveAsNew = useCallback(async () => {
    const req = buildAnalysisReq(queryState, allFrequencies);
    if (req == null || savedFilterName.trim() === '') return;
    setSaveInFlight(true);
    onError('');
    try {
      const next = await upsertAnalysisSavedFilter({ name: savedFilterName.trim(), req });
      setSavedFilters(next);
      const saved = next.find((item) => item.name === savedFilterName.trim()) ?? null;
      setLoadedSavedFilterId(saved?.id ?? null);
    } catch (saveError) {
      if (!onUnauthorized(saveError)) {
        onError(toErrorMessage(saveError));
      }
    } finally {
      setSaveInFlight(false);
    }
  }, [allFrequencies, onError, onUnauthorized, queryState, savedFilterName]);

  const renameExisting = useCallback(async () => {
    if (!loadedSavedFilter) return;
    const nextName = savedFilterName.trim();
    if (nextName === '' || nextName === loadedSavedFilter.name) return;
    setSaveInFlight(true);
    onError('');
    try {
      await renameAnalysisSavedFilter({ id: loadedSavedFilter.id, name: nextName });
      const next = await loadSavedFilters();
      setSavedFilters(next);
      setLoadedSavedFilterId(loadedSavedFilter.id);
      setSavedFilterName(nextName);
    } catch (renameError) {
      if (!onUnauthorized(renameError)) {
        onError(toErrorMessage(renameError));
      }
    } finally {
      setSaveInFlight(false);
    }
  }, [loadSavedFilters, loadedSavedFilter, onError, onUnauthorized, savedFilterName]);

  const updateExisting = useCallback(async () => {
    if (!loadedSavedFilter) return;
    const req = buildAnalysisReq(queryState, allFrequencies);
    if (req == null) return;
    setSaveInFlight(true);
    onError('');
    try {
      const next = await upsertAnalysisSavedFilter({ name: loadedSavedFilter.name, req });
      setSavedFilters(next);
      setLoadedSavedFilterId(loadedSavedFilter.id);
      // Keep the clear snapshot in sync with the saved request so "clear" can fully revert later edits.
      loadedSavedFilterSnapshotRef.current = refreshAppliedSavedFilterSnapshot(
        loadedSavedFilterSnapshotRef.current,
        queryState,
        loadedSavedFilter,
        req,
      );
    } catch (saveError) {
      if (!onUnauthorized(saveError)) {
        onError(toErrorMessage(saveError));
      }
    } finally {
      setSaveInFlight(false);
    }
  }, [allFrequencies, loadedSavedFilter, onError, onUnauthorized, queryState]);

  const deleteLoadedSavedFilter = useCallback(async () => {
    if (!loadedSavedFilter) return;
    setSaveInFlight(true);
    onError('');
    try {
      await deleteAnalysisSavedFilter(loadedSavedFilter.id);
      const next = await loadSavedFilters();
      setLoadedSavedFilterId(null);
      setSavedFilterName('');
      loadedSavedFilterSnapshotRef.current = null;
      setSavedFilters(next);
    } catch (deleteError) {
      if (!onUnauthorized(deleteError)) {
        onError(toErrorMessage(deleteError));
      }
    } finally {
      setSaveInFlight(false);
    }
  }, [loadSavedFilters, loadedSavedFilter, onError, onUnauthorized]);

  return {
    applySavedFilter,
    deleteLoadedSavedFilter,
    isDirty,
    loadedSavedFilter,
    renameExisting,
    saveAsNew,
    saveInFlight,
    savedFilterName,
    savedFilters,
    setSavedFilterName,
    updateExisting,
  };
}
