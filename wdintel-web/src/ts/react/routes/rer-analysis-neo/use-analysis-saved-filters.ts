import type { SavedFilter } from '../../../../Bindings';
import React from 'react';

import { deleteAnalysisSavedFilter, listAnalysisSavedFilters, renameAnalysisSavedFilter, upsertAnalysisSavedFilter } from '../../services/api/analysis';
import { buildAnalysisReq, queryStateFromSavedFilter, queryStateMatchesSavedFilter } from './helpers';
import type { AnalysisQueryState } from './types';

type Props = {
  allFrequencies: string[];
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  setQueryState: React.Dispatch<React.SetStateAction<AnalysisQueryState>>;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час роботи зі збереженими фільтрами.';
}

export function useAnalysisSavedFilters({ allFrequencies, onError, onUnauthorized, queryState, setQueryState }: Props): Result {
  const [savedFilters, setSavedFilters] = React.useState<SavedFilter[]>([]);
  const [loadedSavedFilterId, setLoadedSavedFilterId] = React.useState<number | null>(null);
  const [savedFilterName, setSavedFilterName] = React.useState('');
  const [saveInFlight, setSaveInFlight] = React.useState(false);

  const loadedSavedFilter = React.useMemo(
    () => savedFilters.find((savedFilter) => savedFilter.id === loadedSavedFilterId) ?? null,
    [loadedSavedFilterId, savedFilters],
  );

  const isDirty = React.useMemo(() => {
    if (!loadedSavedFilter) return false;
    return !queryStateMatchesSavedFilter(queryState, loadedSavedFilter, allFrequencies);
  }, [allFrequencies, loadedSavedFilter, queryState]);

  const loadSavedFilters = React.useCallback(async () => {
    const next = await listAnalysisSavedFilters();
    setSavedFilters(next);
    return next;
  }, []);

  React.useEffect(() => {
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

  const applySavedFilter = React.useCallback(
    (savedFilter: SavedFilter | null) => {
      setLoadedSavedFilterId(savedFilter?.id ?? null);
      if (savedFilter == null) {
        return;
      }
      setSavedFilterName(savedFilter.name);
      setQueryState((current) => queryStateFromSavedFilter(savedFilter, current));
    },
    [setQueryState],
  );

  const saveAsNew = React.useCallback(async () => {
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

  const renameExisting = React.useCallback(async () => {
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

  const updateExisting = React.useCallback(async () => {
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

  const deleteLoadedSavedFilter = React.useCallback(async () => {
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
