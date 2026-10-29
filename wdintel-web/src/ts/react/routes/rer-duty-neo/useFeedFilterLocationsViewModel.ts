import { useCallback, useMemo, useState } from 'react';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import { useFeedFilterSelectionState, type FeedFilterMode } from './useFeedFilterSelectionState';
import { useDutyBulkCopy } from './useDutyBulkCopy';
import {
  dutyLocationLabel,
  mergeDutyLocationOptions,
  normalizeDutyLocationValue,
} from './duty-location-filter';

const EMPTY_LOCATIONS: string[] = [];
const noop = () => {};

export type FeedFilterLocationsViewModel = {
  mode: FeedFilterMode;
  value: readonly string[];
  onModeChange: (mode: FeedFilterMode) => void;
  onValueChange: (value: string[]) => void;
  options: readonly string[];
  getOptionLabel: (option: string) => string;
  getOptionKey: (option: string) => string;
  placeholder?: string;
  autocompleteClassName: string;
  loading: boolean;
  loadingText: string;
  noOptionsText: string;
  keepOpenOnSelect: boolean;
  preserveInputOnSelect: boolean;
  onInputChange: (value: string) => void;
  onOpen: () => void;
  bulkCopy: boolean;
  bulkCopyMenuLabel: string;
  onBulkCopy: (selected: readonly string[]) => Promise<void>;
  resolveBulkPasteOptions: (tokens: readonly string[]) => Promise<readonly string[]>;
  includePelengLocations: boolean;
  onIncludePelengLocationsChange: (value: boolean) => void;
};

async function resolveTypedLocations(tokens: readonly string[]): Promise<readonly string[]> {
  return tokens.map(normalizeDutyLocationValue);
}

function serializeLocations(selected: readonly string[]): string {
  return selected.map(dutyLocationLabel).join('\n');
}

function useLocationOptions(
  fetched: readonly string[],
  selected: readonly string[],
  denied: readonly string[],
  inputValue: string,
): string[] {
  return useMemo(() => {
    const typed = normalizeDutyLocationValue(inputValue);
    const typedOptions = typed === '' ? [] : [typed];
    return mergeDutyLocationOptions(fetched, selected, denied, typedOptions);
  }, [denied, fetched, inputValue, selected]);
}

export function useFeedFilterLocationsViewModel(
  panel: FeedFilterPanelModel,
): FeedFilterLocationsViewModel {
  const { filterState, sources, toggles, actions } = panel;
  const selected = filterState.locationsSelected ?? EMPTY_LOCATIONS;
  const denied = filterState.locationsDenied ?? EMPTY_LOCATIONS;
  const [inputValue, setInputValue] = useState('');
  const options = useLocationOptions(
    sources.locationsList ?? EMPTY_LOCATIONS,
    selected,
    denied,
    inputValue,
  );
  const copyLocations = useDutyBulkCopy({ entityLabel: 'локації', serialize: serializeLocations });
  const selectionState = useFeedFilterSelectionState<string>({
    includeValues: selected,
    excludeValues: denied,
    onIncludeChange: actions.onLocationsChange ?? noop,
    onExcludeChange: actions.onLocationsDeniedChange ?? noop,
    onModeTransfer: actions.onLocationsModeTransfer ?? noop,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const { onLoadLocations } = actions;
  const onOpen = useCallback(() => onLoadLocations?.(), [onLoadLocations]);
  const emptyLabel = selectionState.mode === 'include' ? 'всі' : 'жодна';

  return {
    mode: selectionState.mode,
    value: selectionState.localValue,
    onModeChange: selectionState.setMode,
    onValueChange: selectionState.setLocalValue,
    options,
    getOptionLabel: dutyLocationLabel,
    getOptionKey: (option: string) => option,
    placeholder: selectionState.localValue.length === 0 ? emptyLabel : undefined,
    autocompleteClassName: 'min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1',
    loading: toggles.locationsLoading ?? false,
    loadingText: 'Завантажуємо локації…',
    noOptionsText: 'Локацій не знайдено',
    keepOpenOnSelect: true,
    preserveInputOnSelect: false,
    onInputChange: setInputValue,
    onOpen,
    bulkCopy: true,
    bulkCopyMenuLabel: 'Копіювати обрані локації',
    onBulkCopy: copyLocations,
    resolveBulkPasteOptions: resolveTypedLocations,
    includePelengLocations: filterState.includePelengLocations ?? false,
    onIncludePelengLocationsChange: actions.onIncludePelengLocationsChange ?? noop,
  };
}
