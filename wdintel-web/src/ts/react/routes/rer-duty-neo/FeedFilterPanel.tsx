import {
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import type { SavedFilterDuty, SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import { profileLabel } from './utils';

export type FeedFilterPanelProps = {
  feedId: string;
  filterStable: {
    groupsSelected: string[];
    sendersSelected: string[];
    deniedSenders: string[];
    freqsSelected: string[];
    freqsDenied: string[];
  };
  groupsList: string[];
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  senderOptions: Array<{ id: string; label: string }>;
  freqs: string[];
  savedFilters: SavedFilterDuty[];
  selectedSavedId: number | null;
  saveFilterName: string;
  reloadFreqsLoading: boolean;
  onSelectAllGroups: () => void;
  onToggleGroup: (key: string) => void;
  onSendersChange: (v: string[]) => void;
  onDeniedSendersChange: (v: string[]) => void;
  onFreqsChange: (v: string[]) => void;
  onFreqsDeniedChange: (v: string[]) => void;
  onReloadFreqs: () => void;
  onSavedFilterSelect: (id: number | '') => void;
  onSaveFilterNameChange: (value: string) => void;
  onSaveFilter: () => void;
  onApplySavedFilter: (saved: SavedFilterDuty) => void;
  onDeleteSavedFilter: (id: number) => void;
};

export function FeedFilterPanel({
  feedId: _feedId,
  filterStable,
  groupsList,
  groupInfos,
  profiles,
  senderOptions,
  freqs,
  savedFilters,
  selectedSavedId,
  saveFilterName,
  reloadFreqsLoading,
  onSelectAllGroups,
  onToggleGroup,
  onSendersChange,
  onDeniedSendersChange,
  onFreqsChange,
  onFreqsDeniedChange,
  onReloadFreqs,
  onSavedFilterSelect,
  onSaveFilterNameChange,
  onSaveFilter,
  onApplySavedFilter,
  onDeleteSavedFilter,
}: FeedFilterPanelProps) {
  return (
    <Paper variant="outlined" className="p-3">
      <Box className="flex flex-col gap-3">
        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Групи
          </Typography>
          <Box className="flex flex-wrap gap-1 items-center">
            <Chip
              size="small"
              label="всі"
              color={filterStable.groupsSelected.length === 0 ? 'primary' : 'default'}
              onClick={onSelectAllGroups}
            />
            {groupsList.map((key) => {
              const name = groupInfos[key]?.name ?? key;
              const selected = filterStable.groupsSelected.includes(key);
              return (
                <Chip
                  key={key}
                  size="small"
                  label={name}
                  color={selected ? 'primary' : 'default'}
                  onClick={() => onToggleGroup(key)}
                />
              );
            })}
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Відправник
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <Typography variant="caption" className="min-w-[56px] text-right">
              лише
            </Typography>
            <FormControl size="small" className="min-w-[180px] flex-1">
              <Select
                multiple
                displayEmpty
                value={filterStable.sendersSelected}
                onChange={(e) => onSendersChange((e.target.value as string[]) || [])}
                renderValue={(sel) =>
                  (sel as string[]).length === 0
                    ? 'всі'
                    : (sel as string[]).map((id) => profileLabel(id, profiles[id] ?? null)).join(', ')
                }
              >
                {senderOptions.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Box className="flex flex-wrap gap-2 items-center mt-1">
            <Typography variant="caption" className="min-w-[56px] text-right">
              окрім
            </Typography>
            <FormControl size="small" className="min-w-[180px] flex-1">
              <Select
                multiple
                displayEmpty
                value={filterStable.deniedSenders}
                onChange={(e) => onDeniedSendersChange((e.target.value as string[]) || [])}
                renderValue={(sel) =>
                  (sel as string[]).length === 0
                    ? 'ніхто'
                    : (sel as string[]).map((id) => profileLabel(id, profiles[id] ?? null)).join(', ')
                }
              >
                {senderOptions.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <Box>
          <Box className="flex items-center justify-between mb-1">
            <Typography variant="subtitle2" className="font-semibold">
              Частота
            </Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={reloadFreqsLoading}
              onClick={onReloadFreqs}
              startIcon={reloadFreqsLoading ? <CircularProgress size={14} /> : <i className="bi bi-arrow-clockwise" />}
            >
              {reloadFreqsLoading ? '…' : 'Оновити список'}
            </Button>
          </Box>
          <Box className="flex flex-wrap gap-2 items-center">
            <Typography variant="caption" className="min-w-[56px] text-right">
              лише
            </Typography>
            <FormControl size="small" className="min-w-[160px] flex-1">
              <Select
                multiple
                displayEmpty
                value={filterStable.freqsSelected}
                onChange={(e) => onFreqsChange((e.target.value as string[]) || [])}
                renderValue={(sel) => ((sel as string[]).length === 0 ? 'всі' : (sel as string[]).join(', '))}
              >
                {freqs.map((f) => (
                  <MenuItem key={f} value={f}>
                    {f}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Box className="flex flex-wrap gap-2 items-center mt-1">
            <Typography variant="caption" className="min-w-[56px] text-right">
              окрім
            </Typography>
            <FormControl size="small" className="min-w-[160px] flex-1">
              <Select
                multiple
                displayEmpty
                value={filterStable.freqsDenied}
                onChange={(e) => onFreqsDeniedChange((e.target.value as string[]) || [])}
                renderValue={(sel) => ((sel as string[]).length === 0 ? 'ніяка' : (sel as string[]).join(', '))}
              >
                {freqs.map((f) => (
                  <MenuItem key={f} value={f}>
                    {f}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Збережені фільтри
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <FormControl size="small" className="min-w-[180px]">
              <InputLabel>вибрати фільтр</InputLabel>
              <Select
                label="вибрати фільтр"
                className="min-w-[110px]"
                value={selectedSavedId ?? ''}
                onChange={(e) => {
                  const id = e.target.value as number | '';
                  onSavedFilterSelect(id);
                  if (id !== '') {
                    const saved = savedFilters.find((s) => s.id === id);
                    if (saved) onApplySavedFilter(saved);
                  }
                }}
              >
                <MenuItem value="">—</MenuItem>
                {savedFilters.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              placeholder="назва"
              value={saveFilterName}
              onChange={(e) => onSaveFilterNameChange(e.target.value)}
              className="w-[140px]"
            />
            <Button size="small" variant="outlined" onClick={onSaveFilter} disabled={!saveFilterName.trim()}>
              додати
            </Button>
            {selectedSavedId != null && (
              <Button
                size="small"
                color="error"
                variant="outlined"
                onClick={() => {
                  const s = savedFilters.find((x) => x.id === selectedSavedId);
                  if (s) onDeleteSavedFilter(s.id);
                }}
              >
                <i className="bi bi-trash" />
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
