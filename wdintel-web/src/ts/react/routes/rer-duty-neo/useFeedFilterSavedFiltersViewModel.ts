import { useMemo, useState } from 'react';
import type { SavedFilterDuty } from '../../../../Bindings';
import { isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import { normalizeFeed } from './utils';

export type FeedFilterSavedFiltersViewModel = {
  savedFilters: SavedFilterDuty[];
  selectedSavedFilter: SavedFilterDuty | null;
  saveFilterName: string;
  isDirty: boolean;
  saveInFlight: boolean;
  onApplySavedFilter: (saved: SavedFilterDuty | null) => void;
  onSavedFilterNameChange: (value: string) => void;
  onUpdateExisting: () => Promise<void> | void;
  onSaveAsNew: (name: string) => Promise<boolean>;
  onRenameExisting: (name: string) => Promise<boolean>;
  onDeleteExisting: () => Promise<void>;
};

export function useFeedFilterSavedFiltersViewModel(panel: FeedFilterPanelModel): FeedFilterSavedFiltersViewModel {
  const { feedId, filterState, savedFilters, actions } = panel;
  const {
    savedFilters: savedFilterItems,
    selectedSavedId,
    saveFilterName,
  } = savedFilters;
  const {
    onSavedFilterSelect,
    onSaveFilterNameChange,
    onSaveFilter,
    onUpdateSelectedSavedFilter,
    onRenameSelectedSavedFilter,
    onDeleteSelectedSavedFilter,
    onApplySavedFilter,
  } = actions;

  const [saveInFlight, setSaveInFlight] = useState(false);
  const loadedSavedFilter =
    isNullOrUndefined(selectedSavedId) ? null : (savedFilterItems.find((savedFilter) => savedFilter.id === selectedSavedId) ?? null);
  const loadedFilterNormalized = useMemo(
    () => (isNullOrUndefined(loadedSavedFilter) ? null : normalizeFeed(loadedSavedFilter.req as unknown as Record<string, unknown>)),
    [loadedSavedFilter],
  );
  const isDirty =
    isPresent(loadedFilterNormalized) &&
    !(
      JSON.stringify(filterState.groupsSelected) === JSON.stringify(loadedFilterNormalized.groupsSelected ?? []) &&
      JSON.stringify(filterState.deniedGroups) === JSON.stringify(loadedFilterNormalized.groupsDenied ?? []) &&
      JSON.stringify(filterState.sendersSelected) === JSON.stringify(loadedFilterNormalized.sendersSelected ?? []) &&
      JSON.stringify(filterState.deniedSenders) === JSON.stringify(loadedFilterNormalized.deniedSenders ?? []) &&
      JSON.stringify(filterState.freqsSelected) === JSON.stringify(loadedFilterNormalized.freqsSelected ?? []) &&
      JSON.stringify(filterState.freqsDenied) === JSON.stringify(loadedFilterNormalized.freqsDenied ?? []) &&
      JSON.stringify(filterState.postsSelected ?? []) === JSON.stringify(loadedFilterNormalized.postsSelected ?? []) &&
      JSON.stringify(filterState.postsDenied ?? []) === JSON.stringify(loadedFilterNormalized.postsDenied ?? [])
    );

  const runSavedFilterAction = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (saveInFlight) return;
    setSaveInFlight(true);
    try {
      return await action();
    } finally {
      setSaveInFlight(false);
    }
  };

  return {
    savedFilters: savedFilterItems,
    selectedSavedFilter: loadedSavedFilter,
    saveFilterName,
    isDirty,
    saveInFlight,
    onApplySavedFilter: (saved) => {
      if (isNullOrUndefined(saved)) {
        onSavedFilterSelect('');
        return;
      }
      onSavedFilterSelect(saved.id);
      onApplySavedFilter(saved);
    },
    onSavedFilterNameChange: onSaveFilterNameChange,
    onUpdateExisting: () => runSavedFilterAction(() => onUpdateSelectedSavedFilter(feedId)),
    onSaveAsNew: (name) => runSavedFilterAction(() => onSaveFilter(feedId, name)).then((result) => result === true),
    onRenameExisting: (name) =>
      runSavedFilterAction(() => onRenameSelectedSavedFilter(feedId, name)).then((result) => result === true),
    onDeleteExisting: () => runSavedFilterAction(() => onDeleteSelectedSavedFilter(feedId)),
  };
}
