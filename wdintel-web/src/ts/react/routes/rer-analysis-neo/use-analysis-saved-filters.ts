import type { SavedFilter } from '../../../../Bindings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { deleteAnalysisSavedFilter, listAnalysisSavedFilters, renameAnalysisSavedFilter, upsertAnalysisSavedFilter } from '../../services/api/analysis';
import {
  buildAnalysisReq,
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
  renameExisting: (name: string) => Promise<boolean>;
  saveAsNew: (name: string) => Promise<boolean>;
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  setSavedFilterName: (name: string) => void;
  updateExisting: () => Promise<void>;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час роботи зі збереженими фільтрами.';
}

export function useAnalysisSavedFilters({ allFrequencies, onError, onUnauthorized, queryState, setQueryState }: Props): Result {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [loadedSavedFilterId, setLoadedSavedFilterId] = useState<number | null>(null);
  const [savedFilterName, setSavedFilterName] = useState('');
  const [saveInFlight, setSaveInFlight] = useState(false);
  const hasSyncedLoadedSavedFilterRef = useRef(false);

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

  useEffect(() => {
    if (savedFilters.length === 0) return;

    if (loadedSavedFilterId != null) {
      hasSyncedLoadedSavedFilterRef.current = true;
      return;
    }

    if (hasSyncedLoadedSavedFilterRef.current) return;

    const matchedSavedFilter = savedFilters.find((savedFilter) =>
      queryStateMatchesSavedFilter(queryState, savedFilter, allFrequencies),
    );
    if (matchedSavedFilter == null) {
      if (queryState.adjacentFreqsRange > 0 && allFrequencies.length === 0) return;
      hasSyncedLoadedSavedFilterRef.current = true;
      return;
    }

    setLoadedSavedFilterId(matchedSavedFilter.id);
    setSavedFilterName(matchedSavedFilter.name);
    hasSyncedLoadedSavedFilterRef.current = true;
  }, [allFrequencies, loadedSavedFilterId, queryState, savedFilters]);

  const applySavedFilter = useCallback(
    (savedFilter: SavedFilter | null) => {
      hasSyncedLoadedSavedFilterRef.current = true;
      if (savedFilter == null) {
        setLoadedSavedFilterId(null);
        setSavedFilterName('');
        return;
      }

      const current = queryState;
      const nextState = queryStateFromSavedFilter(savedFilter, current);
      setLoadedSavedFilterId(savedFilter?.id ?? null);
      setSavedFilterName(savedFilter.name);
      setQueryState(nextState);
    },
    [queryState, setQueryState],
  );

  const saveAsNew = useCallback(async (name: string) => {
    const req = buildAnalysisReq(queryState, allFrequencies);
    const nextName = name.trim();
    if (req == null || nextName === '') return false;
    setSaveInFlight(true);
    onError('');
    try {
      const next = await upsertAnalysisSavedFilter({ name: nextName, req });
      setSavedFilters(next);
      const saved = next.find((item) => item.name === nextName) ?? null;
      setLoadedSavedFilterId(saved?.id ?? null);
      setSavedFilterName(nextName);
      hasSyncedLoadedSavedFilterRef.current = true;
      return true;
    } catch (saveError) {
      if (!onUnauthorized(saveError)) {
        onError(toErrorMessage(saveError));
      }
      return false;
    } finally {
      setSaveInFlight(false);
    }
  }, [allFrequencies, onError, onUnauthorized, queryState]);

  const renameExisting = useCallback(async (name: string) => {
    if (!loadedSavedFilter) return false;
    const nextName = name.trim();
    if (nextName === '' || nextName === loadedSavedFilter.name) return false;
    setSaveInFlight(true);
    onError('');
    try {
      await renameAnalysisSavedFilter({ id: loadedSavedFilter.id, name: nextName });
      const next = await loadSavedFilters();
      setSavedFilters(next);
      setLoadedSavedFilterId(loadedSavedFilter.id);
      setSavedFilterName(nextName);
      hasSyncedLoadedSavedFilterRef.current = true;
      return true;
    } catch (renameError) {
      if (!onUnauthorized(renameError)) {
        onError(toErrorMessage(renameError));
      }
      return false;
    } finally {
      setSaveInFlight(false);
    }
  }, [loadSavedFilters, loadedSavedFilter, onError, onUnauthorized]);

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
