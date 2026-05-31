import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, FormControl, InputLabel, MenuItem, Select, Tooltip } from '@mui/material';
import type { SavedFilterDuty } from '../../../../Bindings';
import { SavedFiltersControl } from '../../components/SavedFiltersControl';
import { FeedFilterAdvancedSection } from './FeedFilterAdvancedSection';
import { FeedFilterFrequencySection } from './FeedFilterFrequencySection';
import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';
import { FeedFilterUnitsSection } from './FeedFilterUnitsSection';
import type { SearchableOptionSelection } from '../../components/searchable-option.types';
import type { Unit } from '../../../../Bindings';

type UnitsExactMatchSelectValue = 'exact' | 'not-exact';

const UNITS_EXACT_MATCH_OPTIONS: ReadonlyArray<{ value: UnitsExactMatchSelectValue; label: string }> = [
  { value: 'not-exact', label: 'Неточний збіг' },
  { value: 'exact', label: 'Точний збіг' },
];

function unitsExactMatchSelectValue(unitsExactMatchOnly: boolean): UnitsExactMatchSelectValue {
  return unitsExactMatchOnly ? 'exact' : 'not-exact';
}

function unitsExactMatchSelectLabel(value: UnitsExactMatchSelectValue): string {
  return UNITS_EXACT_MATCH_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

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
  units: {
    mode: 'include' | 'exclude';
    onModeChange: (mode: 'include' | 'exclude') => void;
    options: readonly Unit[];
    selected: readonly SearchableOptionSelection[];
    onSelectedChange: (value: SearchableOptionSelection[]) => void;
    placeholder?: string;
    autocompleteClassName?: string;
    unitsExactMatchOnly: boolean;
    onUnitsExactMatchOnlyChange: (value: boolean) => void;
  };
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
  units,
  advanced,
  savedFilters,
}: FeedFilterPanelViewProps) {
  return (
    <Box
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
          border: '1px solid',
          borderColor: 'divider',
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

        <Box>
          <FeedFilterUnitsSection
            title="Підрозділи"
            mode={units.mode}
            onModeChange={units.onModeChange}
            options={units.options}
            selected={units.selected}
            onSelectedChange={units.onSelectedChange}
            placeholder={units.placeholder}
            autocompleteClassName={units.autocompleteClassName}
          />
          <Box className="mt-3 flex w-full items-center gap-1">
            <Tooltip
              arrow
              placement="right"
              slotProps={{ tooltip: { sx: { maxWidth: 280 } } }}
              title="Точний збіг — лише підрозділи з прив'язки в Еталонних мережах. Неточний — також підрозділ з шапки повідомлення."
            >
              <Box
                component="span"
                aria-label="Пояснення збігу з еталонкою"
                sx={{
                  display: 'inline-flex',
                  flexShrink: 0,
                  lineHeight: 0,
                  cursor: 'default',
                  color: 'text.secondary',
                }}
              >
                <InfoOutlinedIcon sx={{ fontSize: 18 }} />
              </Box>
            </Tooltip>
            <FormControl fullWidth size="small">
              <InputLabel id="units-exact-match-only-label">Збіг з еталонкою</InputLabel>
              <Select
                labelId="units-exact-match-only-label"
                value={unitsExactMatchSelectValue(units.unitsExactMatchOnly)}
                label="Збіг з еталонкою"
                renderValue={(value) => unitsExactMatchSelectLabel(value as UnitsExactMatchSelectValue)}
                onChange={(e) => {
                  const value = e.target.value as UnitsExactMatchSelectValue;
                  units.onUnitsExactMatchOnlyChange(value === 'exact');
                }}
              >
                {UNITS_EXACT_MATCH_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>

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
    </Box>
  );
}
