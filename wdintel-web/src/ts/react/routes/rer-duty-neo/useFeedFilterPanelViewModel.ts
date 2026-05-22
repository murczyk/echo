import { useTheme } from '@mui/material';
import { useMemo } from 'react';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import { useFeedFilterSavedFiltersViewModel, type FeedFilterSavedFiltersViewModel } from './useFeedFilterSavedFiltersViewModel';
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
  const { groupsList, groupInfos, senderOptions, freqs, postsList } = sources;
  const { adjacentFreqsRange, highlightSignalsEnabled, onlyMyUnitTagsEnabled, reloadFreqsLoading } = toggles;
  const {
    onGroupsChange,
    onDeniedGroupsChange,
    onSendersChange,
    onDeniedSendersChange,
    onFreqsChange,
    onFreqsDeniedChange,
    onPostsChange,
    onPostsDeniedChange,
    onAdjacentFreqsRangeChange,
    onHighlightSignalsChange,
    onOnlyMyUnitTagsChange,
    onReloadFreqs,
  } = actions;
  const sortedGroupKeys = useMemo(
    () => [...groupsList].sort((a, b) => (groupInfos[a]?.name ?? a).localeCompare(groupInfos[b]?.name ?? b)),
    [groupInfos, groupsList],
  );

  const groupsSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.groupsSelected,
    excludeValues: filterState.deniedGroups,
    onIncludeChange: onGroupsChange,
    onExcludeChange: onDeniedGroupsChange,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const senderSelectionState = useFeedFilterSelectionState<{ id: string; label: string }>({
    includeValues: filterState.sendersSelected,
    excludeValues: filterState.deniedSenders,
    onIncludeChange: onSendersChange,
    onExcludeChange: onDeniedSendersChange,
    toLocalValues: (values) =>
      values.map((id) => senderOptions.find((opt) => opt.id === id) ?? { id, label: id }),
    toParentValues: (values) => values.map((option) => option.id),
  });
  const freqSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.freqsSelected,
    excludeValues: filterState.freqsDenied,
    onIncludeChange: onFreqsChange,
    onExcludeChange: onFreqsDeniedChange,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const postSelectionState = useFeedFilterSelectionState<string>({
    includeValues: filterState.postsSelected ?? [],
    excludeValues: filterState.postsDenied ?? [],
    onIncludeChange: onPostsChange ?? (() => {}),
    onExcludeChange: onPostsDeniedChange ?? (() => {}),
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });

  const groupEmptyLabel = groupsSelectionState.mode === 'include' ? 'всі' : 'ніяка';
  const senderEmptyLabel = senderSelectionState.mode === 'include' ? 'всі' : 'ніхто';
  const freqEmptyLabel = freqSelectionState.mode === 'include' ? 'всі' : 'ніяка';
  const postEmptyLabel = postSelectionState.mode === 'include' ? 'всі' : 'ніяка';

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
    },
    senders: {
      mode: senderSelectionState.mode,
      value: senderSelectionState.localValue,
      onModeChange: senderSelectionState.setMode,
      onValueChange: senderSelectionState.setLocalValue,
      options: senderOptions,
      getOptionLabel: (option: { id: string; label: string }) => option.label,
      getOptionKey: (option: { id: string; label: string }) => option.id,
      isOptionEqualToValue: (option: { id: string; label: string }, value: { id: string; label: string }) =>
        option.id === value.id,
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
    advanced: {
      highlightSignalsEnabled,
      onlyMyUnitTagsEnabled,
      onHighlightSignalsChange,
      onOnlyMyUnitTagsChange,
    },
    savedFilters: useFeedFilterSavedFiltersViewModel(panel),
  };
}
