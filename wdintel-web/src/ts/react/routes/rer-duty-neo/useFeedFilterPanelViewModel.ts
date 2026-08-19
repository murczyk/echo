import { useTheme } from '@mui/material';
import { useMemo } from 'react';
import { buildUnitFilterOptions, getUnitFilterValue } from '../../utils/unit-search';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import type { GroupCatalogError } from './useRerDutyFilterOptions';
import {
  useFeedFilterSavedFiltersViewModel,
  type FeedFilterSavedFiltersViewModel,
} from './useFeedFilterSavedFiltersViewModel';
import { useFeedFilterSelectionState } from './useFeedFilterSelectionState';

type FeedFilterMode = 'include' | 'exclude';

type FeedFilterSelectionViewModel<T> = {
  mode: FeedFilterMode;
  value: readonly T[];
  onModeChange: (mode: FeedFilterMode) => void;
  onValueChange: (value: T[]) => void;
  options: readonly T[];
  getOptionLabel: (option: T) => string;
  getOptionKey?: (option: T) => string;
  isOptionEqualToValue?: (option: T, value: T) => boolean;
  placeholder?: string;
  autocompleteClassName?: string;
  rankedSearch?: boolean;
  keepOpenAndPreserveInputOnSelect?: boolean;
  loading?: boolean;
  loadingText?: string;
  noOptionsText?: string;
  clearText?: string;
  openText?: string;
  closeText?: string;
  keepOpenOnSelect?: boolean;
  preserveInputOnSelect?: boolean;
  groupCatalogError?: GroupCatalogError | null;
  catalogLoading?: boolean;
  onRetryGroupCatalog?: () => void;
};

export type FeedFilterPanelViewModel = {
  isDarkMode: boolean;
  groups: FeedFilterSelectionViewModel<string>;
  senders: FeedFilterSelectionViewModel<{ id: string; label: string }>;
  freqs: FeedFilterSelectionViewModel<string> & {
    reloadFreqsLoading: boolean;
    onReloadFreqs: () => void;
    adjacentFreqsRange?: number;
    onAdjacentFreqsRangeChange?: (value: number) => void;
  };
  posts: FeedFilterSelectionViewModel<string>;
  units: FeedFilterSelectionViewModel<string> & {
    unitsExactMatchOnly: boolean;
    onUnitsExactMatchOnlyChange: (value: boolean) => void;
  };
  advanced: {
    highlightSignalsEnabled?: boolean;
    onlyMyUnitTagsEnabled?: boolean;
    onHighlightSignalsChange?: (value: boolean) => void;
    onOnlyMyUnitTagsChange?: (value: boolean) => void;
  };
  savedFilters: FeedFilterSavedFiltersViewModel;
};

export function useFeedFilterPanelViewModel(panel: FeedFilterPanelModel): FeedFilterPanelViewModel {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const { filterState, sources, toggles, actions } = panel;
  const { groupsList, groupInfos, senderOptions, freqs, postsList, unitsList } = sources;
  const {
    adjacentFreqsRange,
    highlightSignalsEnabled,
    onlyMyUnitTagsEnabled,
    unitsExactMatchOnly,
    reloadFreqsLoading,
    groupCatalogLoading = false,
    groupCatalogError = null,
  } = toggles;
  const {
    onGroupsChange,
    onDeniedGroupsChange,
    onGroupsModeTransfer,
    onSendersChange,
    onDeniedSendersChange,
    onSendersModeTransfer,
    onFreqsChange,
    onFreqsDeniedChange,
    onFreqsModeTransfer,
    onPostsChange,
    onPostsDeniedChange,
    onPostsModeTransfer,
    onUnitsChange,
    onUnitsDeniedChange,
    onUnitsModeTransfer,
    onUnitsExactMatchOnlyChange,
    onAdjacentFreqsRangeChange,
    onHighlightSignalsChange,
    onOnlyMyUnitTagsChange,
    onReloadFreqs,
    onReloadGroupCatalog = () => {},
  } = actions;
  const sortedGroupKeys = useMemo(
    () =>
      [...groupsList].sort(
        (a, b) =>
          (groupInfos[a]?.name ?? a).localeCompare(groupInfos[b]?.name ?? b) || a.localeCompare(b),
      ),
    [groupInfos, groupsList],
  );

  const groupsSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.groupsSelected,
    excludeValues: filterState.deniedGroups,
    onIncludeChange: onGroupsChange,
    onExcludeChange: onDeniedGroupsChange,
    onModeTransfer: onGroupsModeTransfer,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const senderSelectionState = useFeedFilterSelectionState<{ id: string; label: string }>({
    includeValues: filterState.sendersSelected,
    excludeValues: filterState.deniedSenders,
    onIncludeChange: onSendersChange,
    onExcludeChange: onDeniedSendersChange,
    onModeTransfer: onSendersModeTransfer,
    toLocalValues: (values) =>
      values.map((id) => senderOptions.find((opt) => opt.id === id) ?? { id, label: id }),
    toParentValues: (values) => values.map((option) => option.id),
  });
  const freqSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.freqsSelected,
    excludeValues: filterState.freqsDenied,
    onIncludeChange: onFreqsChange,
    onExcludeChange: onFreqsDeniedChange,
    onModeTransfer: onFreqsModeTransfer,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const postSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.postsSelected ?? [],
    excludeValues: filterState.postsDenied ?? [],
    onIncludeChange: onPostsChange ?? (() => {}),
    onExcludeChange: onPostsDeniedChange ?? (() => {}),
    onModeTransfer: onPostsModeTransfer,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const unitsCatalogKey = useMemo(
    () =>
      (unitsList ?? [])
        .map((unit) => `${unit.id}:${unit.name}`)
        .sort()
        .join('|'),
    [unitsList],
  );
  const unitOptions = useMemo(
    () => buildUnitFilterOptions(unitsList ?? []).map(getUnitFilterValue),
    [unitsCatalogKey],
  );
  const unitSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.unitsSelected ?? [],
    excludeValues: filterState.unitsDenied ?? [],
    onIncludeChange: onUnitsChange ?? (() => {}),
    onExcludeChange: onUnitsDeniedChange ?? (() => {}),
    onModeTransfer: onUnitsModeTransfer,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });

  const groupEmptyLabel = groupsSelectionState.mode === 'include' ? 'всі' : 'ніяка';
  const visibleGroupCatalogError: GroupCatalogError | null =
    groupCatalogError?.kind === 'catalog' && sortedGroupKeys.length > 0
      ? {
          kind: 'catalog',
          message: 'Не вдалося завантажити повний список груп. Показано раніше доступні групи.',
        }
      : groupCatalogError;
  const senderEmptyLabel = senderSelectionState.mode === 'include' ? 'всі' : 'ніхто';
  const freqEmptyLabel = freqSelectionState.mode === 'include' ? 'всі' : 'ніяка';
  const postEmptyLabel = postSelectionState.mode === 'include' ? 'всі' : 'ніяка';
  const unitEmptyLabel = unitSelectionState.mode === 'include' ? 'всі' : 'жоден';

  return {
    isDarkMode,
    groups: {
      mode: groupsSelectionState.mode,
      value: groupsSelectionState.localValue,
      onModeChange: groupsSelectionState.setMode,
      onValueChange: groupsSelectionState.setLocalValue,
      options: sortedGroupKeys,
      getOptionLabel: (key: string) => groupInfos[key]?.name ?? key,
      getOptionKey: (key: string) => key,
      placeholder: groupsSelectionState.localValue.length === 0 ? groupEmptyLabel : undefined,
      autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[180px] min-[1024px]:flex-1',
      loading: groupCatalogLoading && sortedGroupKeys.length === 0,
      catalogLoading: groupCatalogLoading,
      loadingText: 'Завантажуємо групи…',
      noOptionsText: 'Груп не знайдено',
      clearText: 'Очистити',
      openText: 'Відкрити',
      closeText: 'Закрити',
      keepOpenOnSelect: true,
      preserveInputOnSelect: false,
      groupCatalogError: visibleGroupCatalogError,
      onRetryGroupCatalog: onReloadGroupCatalog,
    },
    senders: {
      mode: senderSelectionState.mode,
      value: senderSelectionState.localValue,
      onModeChange: senderSelectionState.setMode,
      onValueChange: senderSelectionState.setLocalValue,
      options: senderOptions,
      getOptionLabel: (option: { id: string; label: string }) => option.label,
      getOptionKey: (option: { id: string; label: string }) => option.id,
      isOptionEqualToValue: (
        option: { id: string; label: string },
        value: { id: string; label: string },
      ) => option.id === value.id,
      placeholder: senderSelectionState.localValue.length === 0 ? senderEmptyLabel : undefined,
      autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[180px] min-[1024px]:flex-1',
    },
    freqs: {
      mode: freqSelectionState.mode,
      value: freqSelectionState.localValue,
      onModeChange: freqSelectionState.setMode,
      onValueChange: freqSelectionState.setLocalValue,
      options: freqs,
      getOptionLabel: (option: string) => option,
      placeholder: freqSelectionState.localValue.length === 0 ? freqEmptyLabel : undefined,
      autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1',
      reloadFreqsLoading,
      onReloadFreqs,
      adjacentFreqsRange,
      onAdjacentFreqsRangeChange,
    },
    posts: {
      mode: postSelectionState.mode,
      value: postSelectionState.localValue,
      onModeChange: postSelectionState.setMode,
      onValueChange: postSelectionState.setLocalValue,
      options: postsList ?? [],
      getOptionLabel: (option: string) => option,
      placeholder: postSelectionState.localValue.length === 0 ? postEmptyLabel : undefined,
      autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1',
    },
    units: {
      mode: unitSelectionState.mode,
      value: unitSelectionState.localValue,
      onModeChange: unitSelectionState.setMode,
      onValueChange: unitSelectionState.setLocalValue,
      options: unitOptions,
      getOptionLabel: (name: string) => name,
      getOptionKey: (name: string) => name,
      rankedSearch: true,
      keepOpenAndPreserveInputOnSelect: true,
      placeholder: unitSelectionState.localValue.length === 0 ? unitEmptyLabel : undefined,
      autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1',
      unitsExactMatchOnly: unitsExactMatchOnly ?? false,
      onUnitsExactMatchOnlyChange: onUnitsExactMatchOnlyChange ?? (() => {}),
    },
    advanced: {
      highlightSignalsEnabled,
      onlyMyUnitTagsEnabled,
      onHighlightSignalsChange,
      onOnlyMyUnitTagsChange,
    },
    savedFilters: useFeedFilterSavedFiltersViewModel(panel),
  };
}
