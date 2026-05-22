import { Box, Paper } from '@mui/material';
import type { SavedFilterDuty } from '../../../../Bindings';
import { SavedFiltersControl } from '../../components/SavedFiltersControl';
import { FeedFilterAdvancedSection } from './FeedFilterAdvancedSection';
import { FeedFilterFrequencySection } from './FeedFilterFrequencySection';
import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';

export type FeedFilterSelectionConfig<T> = {
  mode: 'include' | 'exclude';
  value: readonly T[];
  onModeChange: (mode: 'include' | 'exclude') => void;
  onValueChange: (value: T[]) => void;
  options: readonly T[];
  getOptionLabel: (option: T) => string;
  getOptionKey?: (option: T) => string;
  isOptionEqualToValue?: (option: T, value: T) => boolean;
  placeholder?: string;
  autocompleteClassName?: string;
};

type FeedFilterSavedFiltersConfig = {
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

export type FeedFilterPanelViewProps = {
  isDarkMode: boolean;
  groups: FeedFilterSelectionConfig<string>;
  senders: FeedFilterSelectionConfig<{ id: string; label: string }>;
  freqs: FeedFilterSelectionConfig<string> & {
    reloadFreqsLoading: boolean;
    onReloadFreqs: () => void;
    adjacentFreqsRange?: number;
    onAdjacentFreqsRangeChange?: (value: number) => void;
  };
  posts: FeedFilterSelectionConfig<string>;
  advanced: {
    highlightSignalsEnabled?: boolean;
    onlyMyUnitTagsEnabled?: boolean;
    onHighlightSignalsChange?: (value: boolean) => void;
    onOnlyMyUnitTagsChange?: (value: boolean) => void;
  };
  savedFilters: FeedFilterSavedFiltersConfig;
};

export function FeedFilterPanelView({
  isDarkMode,
  groups,
  senders,
  freqs,
  posts,
  advanced,
  savedFilters,
}: FeedFilterPanelViewProps) {
  return (
    <Paper
      variant="outlined"
      className="z-2"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: 'auto',
        maxHeight: '100%',
        alignSelf: 'stretch',
        minHeight: 0,
        overflow: 'hidden',
        border: 0,
        borderRadius: 0,
        background: 'transparent',
        boxShadow: 'none',
      }}
      aria-label="Панель фільтрів"
    >
      <Box
        className="flex flex-col gap-3"
        style={{
          width: '100%',
          height: 'auto',
          maxHeight: '100%',
          overflowX: 'hidden',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
        sx={{
          flex: 1,
          minHeight: 0,
          alignSelf: 'stretch',
          px: 2,
          py: 2,
          backgroundColor: 'background.paper',
          backgroundImage: isDarkMode
            ? 'linear-gradient(180deg, rgba(16, 20, 28, 0.98) 0%, rgba(12, 16, 24, 0.98) 100%)'
            : 'none',
          borderTop: '1px solid',
          borderTopColor: 'divider',
          borderRadius: 0,
        }}
      >
        <FeedFilterSelectionSection
          title="Групи"
          mode={groups.mode}
          onModeChange={groups.onModeChange}
          value={groups.value}
          onValueChange={groups.onValueChange}
          options={groups.options}
          getOptionLabel={groups.getOptionLabel}
          getOptionKey={groups.getOptionKey}
          placeholder={groups.placeholder}
          autocompleteClassName={groups.autocompleteClassName}
        />

        <FeedFilterSelectionSection
          title="Відправник"
          mode={senders.mode}
          onModeChange={senders.onModeChange}
          value={senders.value}
          onValueChange={senders.onValueChange}
          options={senders.options}
          getOptionLabel={senders.getOptionLabel}
          getOptionKey={senders.getOptionKey}
          isOptionEqualToValue={senders.isOptionEqualToValue}
          placeholder={senders.placeholder}
          autocompleteClassName={senders.autocompleteClassName}
        />

        <FeedFilterFrequencySection
          mode={freqs.mode}
          onModeChange={freqs.onModeChange}
          value={freqs.value}
          onValueChange={freqs.onValueChange}
          options={freqs.options}
          placeholder={freqs.placeholder}
          reloadFreqsLoading={freqs.reloadFreqsLoading}
          onReloadFreqs={freqs.onReloadFreqs}
          adjacentFreqsRange={freqs.adjacentFreqsRange}
          onAdjacentFreqsRangeChange={freqs.onAdjacentFreqsRangeChange}
        />

        <FeedFilterSelectionSection
          title="Пост"
          mode={posts.mode}
          onModeChange={posts.onModeChange}
          value={posts.value}
          onValueChange={posts.onValueChange}
          options={posts.options}
          getOptionLabel={posts.getOptionLabel}
          placeholder={posts.placeholder}
          autocompleteClassName={posts.autocompleteClassName}
        />

        <FeedFilterAdvancedSection
          highlightSignalsEnabled={advanced.highlightSignalsEnabled}
          onlyMyUnitTagsEnabled={advanced.onlyMyUnitTagsEnabled}
          onHighlightSignalsChange={advanced.onHighlightSignalsChange}
          onOnlyMyUnitTagsChange={advanced.onOnlyMyUnitTagsChange}
        />

        <SavedFiltersControl
          savedFilters={savedFilters.savedFilters}
          selectedSavedFilter={savedFilters.selectedSavedFilter}
          savedFilterName={savedFilters.saveFilterName}
          isDirty={savedFilters.isDirty}
          saveInFlight={savedFilters.saveInFlight}
          onApplySavedFilter={savedFilters.onApplySavedFilter}
          onSavedFilterNameChange={savedFilters.onSavedFilterNameChange}
          onUpdateExisting={savedFilters.onUpdateExisting}
          onSaveAsNew={savedFilters.onSaveAsNew}
          onRenameExisting={savedFilters.onRenameExisting}
          onDeleteExisting={savedFilters.onDeleteExisting}
        />
      </Box>
    </Paper>
  );
}
