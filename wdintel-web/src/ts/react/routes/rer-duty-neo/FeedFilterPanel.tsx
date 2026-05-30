import type { SavedFilterDuty, SignalGroupEntry, SignalProfileEntry, Unit } from '../../../../Bindings';
import { FeedFilterPanelView } from './FeedFilterPanelView';
import { useFeedFilterPanelViewModel } from './useFeedFilterPanelViewModel';

export type FeedFilterPanelModel = {
  feedId: string;
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
  };
  sources: {
    groupsList: string[];
    groupInfos: Record<string, SignalGroupEntry>;
    profiles: Record<string, SignalProfileEntry | null>;
    senderOptions: Array<{ id: string; label: string }>;
    freqs: string[];
    postsList?: string[];
    unitsList?: Unit[];
  };
  toggles: {
    adjacentFreqsRange?: number;
    highlightSignalsEnabled?: boolean;
    onlyMyUnitTagsEnabled?: boolean;
    unitsExactMatchOnly?: boolean | null;
    reloadFreqsLoading: boolean;
  };
  savedFilters: {
    savedFilters: SavedFilterDuty[];
    selectedSavedId: number | null;
    saveFilterName: string;
  };
  actions: {
    onGroupsChange: (v: string[]) => void;
    onDeniedGroupsChange: (v: string[]) => void;
    onSendersChange: (v: string[]) => void;
    onDeniedSendersChange: (v: string[]) => void;
    onFreqsChange: (v: string[]) => void;
    onFreqsDeniedChange: (v: string[]) => void;
    onPostsChange?: (v: string[]) => void;
    onPostsDeniedChange?: (v: string[]) => void;
    onUnitsChange?: (v: string[]) => void;
    onUnitsDeniedChange?: (v: string[]) => void;
    onUnitsExactMatchOnlyChange?: (v: boolean) => void;
    onAdjacentFreqsRangeChange?: (v: number) => void;
    onHighlightSignalsChange?: (v: boolean) => void;
    onOnlyMyUnitTagsChange?: (v: boolean) => void;
    onReloadFreqs: () => void;
    onSavedFilterSelect: (id: number | '') => void;
    onSaveFilterNameChange: (value: string) => void;
    onSaveFilter: (feedId: string, name: string) => Promise<boolean>;
    onUpdateSelectedSavedFilter: (feedId: string) => Promise<void>;
    onRenameSelectedSavedFilter: (feedId: string, name: string) => Promise<boolean>;
    onDeleteSelectedSavedFilter: (feedId: string) => Promise<void>;
    onApplySavedFilter: (saved: SavedFilterDuty) => void;
  };
};

export type FeedFilterPanelProps = {
  panel: FeedFilterPanelModel;
};

export function FeedFilterPanel({ panel }: FeedFilterPanelProps) {
  const viewModel = useFeedFilterPanelViewModel(panel);
  return <FeedFilterPanelView {...viewModel} />;
}
