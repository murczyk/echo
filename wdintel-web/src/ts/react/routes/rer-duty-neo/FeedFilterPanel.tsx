import type {
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Unit,
} from '../../../../Bindings';
import type { GroupCatalogError } from './useRerDutyFilterOptions';
import type { FeedFilterModeTransfer } from './useFeedFilterSelectionState';
import { FeedFilterPanelView } from './FeedFilterPanelView';
import { useFeedFilterPanelViewModel } from './useFeedFilterPanelViewModel';

export type FeedFilterPanelModel = {
  feedId: string;
  hasActiveFilter: boolean;
  filterState: {
    groupsSelected: string[];
    deniedGroups: string[];
    sendersSelected: string[];
    deniedSenders: string[];
    freqsSelected: string[];
    freqsDenied: string[];
    postsSelected?: string[];
    postsDenied?: string[];
    unitsSelected?: string[];
    unitsDenied?: string[];
    selectedDeviceNames?: string[];
    deniedDeviceNames?: string[];
  };
  devices?: {
    onSelectedChange: (v: string[]) => void;
    onDeniedChange: (v: string[]) => void;
    onModeTransfer: (next: FeedFilterModeTransfer) => void;
  };
  sources: {
    groupsList: string[];
    groupInfos: Record<string, SignalGroupEntry>;
    profiles: Record<string, SignalProfileEntry | null>;
    senderOptions: Array<{ id: string; label: string }>;
    freqs: string[];
    postsList?: string[];
    unitsList?: Unit[];
    persistentUnitFilterValues?: string[];
  };
  toggles: {
    adjacentFreqsRange?: number;
    highlightSignalsEnabled?: boolean;
    onlyMyUnitTagsEnabled?: boolean;
    unitsExactMatchOnly?: boolean | null;
    reloadFreqsLoading: boolean;
    groupCatalogLoading?: boolean;
    groupCatalogError?: GroupCatalogError | null;
  };
  savedFilters: {
    savedFilters: SavedFilterDuty[];
    selectedSavedId: number | null;
    saveFilterName: string;
  };
  actions: {
    onGroupsChange: (v: string[]) => void;
    onDeniedGroupsChange: (v: string[]) => void;
    onGroupsModeTransfer: (next: FeedFilterModeTransfer) => void;
    onSendersChange: (v: string[]) => void;
    onDeniedSendersChange: (v: string[]) => void;
    onSendersModeTransfer: (next: FeedFilterModeTransfer) => void;
    onFreqsChange: (v: string[]) => void;
    onFreqsDeniedChange: (v: string[]) => void;
    onFreqsModeTransfer: (next: FeedFilterModeTransfer) => void;
    onPostsChange?: (v: string[]) => void;
    onPostsDeniedChange?: (v: string[]) => void;
    onPostsModeTransfer: (next: FeedFilterModeTransfer) => void;
    onUnitsChange?: (v: string[]) => void;
    onUnitsDeniedChange?: (v: string[]) => void;
    onUnitsModeTransfer: (next: FeedFilterModeTransfer) => void;
    onUnitsExactMatchOnlyChange?: (v: boolean) => void;
    onAdjacentFreqsRangeChange?: (v: number) => void;
    onHighlightSignalsChange?: (v: boolean) => void;
    onOnlyMyUnitTagsChange?: (v: boolean) => void;
    onReloadFreqs: () => void;
    onReloadGroupCatalog?: () => void;
    onSavedFilterSelect: (id: number | '') => void;
    onSaveFilterNameChange: (value: string) => void;
    onSaveFilter: (feedId: string, name: string) => Promise<boolean>;
    onUpdateSelectedSavedFilter: (feedId: string) => Promise<void>;
    onRenameSelectedSavedFilter: (feedId: string, name: string) => Promise<boolean>;
    onDeleteSelectedSavedFilter: (feedId: string) => Promise<void>;
    onApplySavedFilter: (saved: SavedFilterDuty) => void;
    onDiscardCurrentFilter: () => void;
  };
};

export type FeedFilterPanelProps = {
  panel: FeedFilterPanelModel;
};

export function FeedFilterPanel({ panel }: FeedFilterPanelProps) {
  const viewModel = useFeedFilterPanelViewModel(panel);
  return <FeedFilterPanelView {...viewModel} />;
}
