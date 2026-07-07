import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isNullOrUndefined, isPresent } from '../../utils/misc';

import type { SavedFilterDuty } from '../../../../Bindings';
import { savedFilterDelete, savedFilterRename, savedFilterUpsert } from '../../services/api/inbox';
import { normalizeFeed } from './utils';
import type { MessageFeedState } from './utils';

type Params = {
  messageFeeds: MessageFeedState[];
  savedFilters: SavedFilterDuty[];
  setSavedFilters: Dispatch<SetStateAction<SavedFilterDuty[]>>;
  selectedSavedIdByFeedId: Record<string, number | null>;
  setSelectedSavedIdByFeedId: Dispatch<SetStateAction<Record<string, number | null>>>;
  saveFilterNameByFeedId: Record<string, string>;
  setSaveFilterNameByFeedId: Dispatch<SetStateAction<Record<string, string>>>;
  applyFilter: (feedId: string, nextFilter: ReturnType<typeof normalizeFeed>) => void;
  setError: (value: string) => void;
};

export function useRerDutySavedFilterActions(params: Params) {
  const selectedSavedIdByFeedIdRef = useRef(params.selectedSavedIdByFeedId);

  useEffect(() => {
    selectedSavedIdByFeedIdRef.current = params.selectedSavedIdByFeedId;
  }, [params.selectedSavedIdByFeedId]);

  const getSelectedSavedIdForFeed = useCallback(
    (feedId: string) => params.selectedSavedIdByFeedId[feedId] ?? null,
    [params.selectedSavedIdByFeedId],
  );

  const setSavedFilterSelectionForFeed = useCallback(
    (feedId: string, savedId: number | null) => {
      params.setSelectedSavedIdByFeedId((prev) =>
        prev[feedId] === savedId ? prev : { ...prev, [feedId]: savedId },
      );
    },
    [params.setSelectedSavedIdByFeedId],
  );

  const setSavedFilterNameForFeed = useCallback(
    (feedId: string, name: string) => {
      params.setSaveFilterNameByFeedId((prev) =>
        prev[feedId] === name ? prev : { ...prev, [feedId]: name },
      );
    },
    [params.setSaveFilterNameByFeedId],
  );

  const handleSaveFilter = useCallback(
    async (feedId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      if (params.savedFilters.some((savedFilter) => savedFilter.name === trimmed)) {
        params.setError(`Фільтр з назвою "${trimmed}" вже існує`);
        return false;
      }
      const feed = params.messageFeeds.find((item) => item.id === feedId);
      if (!feed) return false;
      try {
        const list = await savedFilterUpsert({ name: trimmed, req: feed.filter });
        params.setSavedFilters(list);
        const created = list.find((savedFilter) => savedFilter.name === trimmed);
        if (isPresent(created)) {
          setSavedFilterSelectionForFeed(feedId, created.id);
          setSavedFilterNameForFeed(feedId, created.name);
        }
        return true;
      } catch (e) {
        params.setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [
      params.messageFeeds,
      params.savedFilters,
      params.setError,
      params.setSavedFilters,
      setSavedFilterNameForFeed,
      setSavedFilterSelectionForFeed,
    ],
  );

  const handleApplySavedFilter = useCallback(
    (feedId: string, saved: SavedFilterDuty) => {
      setSavedFilterSelectionForFeed(feedId, saved.id);
      setSavedFilterNameForFeed(feedId, saved.name);
      params.applyFilter(feedId, normalizeFeed(saved.req as unknown as Record<string, unknown>));
    },
    [params.applyFilter, setSavedFilterNameForFeed, setSavedFilterSelectionForFeed],
  );

  const handleUpdateSelectedSavedFilter = useCallback(
    async (feedId: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return;
      const selectedSaved = params.savedFilters.find(
        (savedFilter) => savedFilter.id === selectedSavedId,
      );
      if (!selectedSaved) return;
      const feed = params.messageFeeds.find((item) => item.id === feedId);
      if (!feed) return;
      try {
        const list = await savedFilterUpsert({ name: selectedSaved.name, req: feed.filter });
        params.setSavedFilters(list);
      } catch (e) {
        params.setError(e instanceof Error ? e.message : String(e));
      }
    },
    [
      getSelectedSavedIdForFeed,
      params.messageFeeds,
      params.savedFilters,
      params.setError,
      params.setSavedFilters,
    ],
  );

  const handleRenameSelectedSavedFilter = useCallback(
    async (feedId: string, name: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return false;
      const selectedSaved = params.savedFilters.find(
        (savedFilter) => savedFilter.id === selectedSavedId,
      );
      if (!selectedSaved) return false;
      const trimmed = name.trim();
      if (!trimmed || trimmed === selectedSaved.name) return false;
      if (
        params.savedFilters.some(
          (savedFilter) => savedFilter.id !== selectedSaved.id && savedFilter.name === trimmed,
        )
      ) {
        params.setError(`Фільтр з назвою "${trimmed}" вже існує`);
        return false;
      }
      try {
        await savedFilterRename({ id: selectedSaved.id, name: trimmed });
        params.setSavedFilters((prev) =>
          prev.map((savedFilter) =>
            savedFilter.id === selectedSaved.id ? { ...savedFilter, name: trimmed } : savedFilter,
          ),
        );
        params.setSaveFilterNameByFeedId((prev) => {
          let changed = false;
          const next = { ...prev };
          Object.entries(selectedSavedIdByFeedIdRef.current).forEach(
            ([targetFeedId, targetSavedId]) => {
              if (targetSavedId === selectedSaved.id && next[targetFeedId] !== trimmed) {
                next[targetFeedId] = trimmed;
                changed = true;
              }
            },
          );
          return changed ? next : prev;
        });
        return true;
      } catch (e) {
        params.setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [
      getSelectedSavedIdForFeed,
      params.savedFilters,
      params.setError,
      params.setSavedFilters,
      params.setSaveFilterNameByFeedId,
    ],
  );

  const clearDeletedSavedFilterFromFeeds = useCallback(
    (deletedSavedId: number) => {
      params.setSelectedSavedIdByFeedId((prev) => {
        let changed = false;
        const next = { ...prev };
        Object.entries(prev).forEach(([feedId, savedId]) => {
          if (savedId === deletedSavedId) {
            next[feedId] = null;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
      params.setSaveFilterNameByFeedId((prev) => {
        let changed = false;
        const next = { ...prev };
        Object.entries(prev).forEach(([feedId, savedName]) => {
          const savedId = selectedSavedIdByFeedIdRef.current[feedId] ?? null;
          if (savedId === deletedSavedId && savedName !== '') {
            next[feedId] = '';
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    },
    [params.setSaveFilterNameByFeedId, params.setSelectedSavedIdByFeedId],
  );

  const handleDeleteSelectedSavedFilter = useCallback(
    async (feedId: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return;
      try {
        await savedFilterDelete(selectedSavedId);
        params.setSavedFilters((prev) => prev.filter((x) => x.id !== selectedSavedId));
        clearDeletedSavedFilterFromFeeds(selectedSavedId);
      } catch (e) {
        params.setError(e instanceof Error ? e.message : String(e));
      }
    },
    [
      clearDeletedSavedFilterFromFeeds,
      getSelectedSavedIdForFeed,
      params.setError,
      params.setSavedFilters,
    ],
  );

  const handleDeleteSavedFilter = useCallback(
    async (id: number) => {
      try {
        await savedFilterDelete(id);
        params.setSavedFilters((prev) => prev.filter((x) => x.id !== id));
        clearDeletedSavedFilterFromFeeds(id);
      } catch (e) {
        params.setError(e instanceof Error ? e.message : String(e));
      }
    },
    [clearDeletedSavedFilterFromFeeds, params.setError, params.setSavedFilters],
  );

  return {
    getSelectedSavedIdForFeed,
    setSavedFilterSelectionForFeed,
    setSavedFilterNameForFeed,
    handleSaveFilter,
    handleApplySavedFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    clearDeletedSavedFilterFromFeeds,
    handleDeleteSelectedSavedFilter,
    handleDeleteSavedFilter,
  };
}
