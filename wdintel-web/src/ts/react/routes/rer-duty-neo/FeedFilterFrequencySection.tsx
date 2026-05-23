import { Box, CircularProgress, FormControl, IconButton, MenuItem, Select, Tooltip, Typography } from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';
import { ADJACENT_FREQS_RANGE_OPTIONS } from './utils';

type FeedFilterFrequencySectionProps = {
  mode: 'include' | 'exclude';
  onModeChange: (mode: 'include' | 'exclude') => void;
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  options: readonly string[];
  placeholder?: string;
  reloadFreqsLoading: boolean;
  onReloadFreqs: () => void;
  adjacentFreqsRange?: number;
  onAdjacentFreqsRangeChange?: (value: number) => void;
};

export function FeedFilterFrequencySection({
  mode,
  onModeChange,
  value,
  onValueChange,
  options,
  placeholder,
  reloadFreqsLoading,
  onReloadFreqs,
  adjacentFreqsRange,
  onAdjacentFreqsRangeChange,
}: FeedFilterFrequencySectionProps) {
  return (
    <Box>
      <FeedFilterSelectionSection
        title="Частота"
        mode={mode}
        onModeChange={onModeChange}
        value={value}
        onValueChange={onValueChange}
        options={options}
        getOptionLabel={(option) => option}
        placeholder={placeholder}
        autocompleteClassName="min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1"
        headerRight={
          <Tooltip title="Оновити список частот">
            <span>
              <IconButton
                size="small"
                disabled={reloadFreqsLoading}
                onClick={onReloadFreqs}
                aria-label="Оновити список частот"
                sx={{ padding: 0.5 }}
              >
                {reloadFreqsLoading ? <CircularProgress size={18} /> : <RefreshOutlinedIcon sx={{ fontSize: '1rem' }} />}
              </IconButton>
            </span>
          </Tooltip>
        }
      />
      <Box className="flex flex-wrap gap-2 justify-end mt-2">
        <Tooltip title="Частоти в діапазоні від обраних будуть автоматично додаватись до фільтра.">
          <Typography variant="caption" sx={{ alignSelf: 'center', fontSize: 12 }}>
            автоматично додавати частоти в діапазоні:
          </Typography>
        </Tooltip>
        <FormControl size="small" sx={{ minWidth: 120, '& .MuiSelect-select': { fontSize: 12 } }}>
          <Select
            value={
              (ADJACENT_FREQS_RANGE_OPTIONS as readonly number[]).includes(adjacentFreqsRange ?? 0)
                ? (adjacentFreqsRange ?? 0)
                : 0
            }
            onChange={(event) => onAdjacentFreqsRangeChange?.(Number(event.target.value))}
            displayEmpty
          >
            {ADJACENT_FREQS_RANGE_OPTIONS.map((range) => (
              <MenuItem key={range} value={range}>
                {range === 0 ? 'вимкнено' : `${range * 1000} кГц`}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
}
