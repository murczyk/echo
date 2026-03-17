import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';
import type { SavedFilterDuty, SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import { ADJACENT_FREQS_RANGE_OPTIONS } from './utils';
import { PowerChip } from '../../components/PowerChip';

export type FeedFilterPanelProps = {
  feedId: string;
  filterStable: {
    groupsSelected: string[];
    sendersSelected: string[];
    deniedSenders: string[];
    freqsSelected: string[];
    freqsDenied: string[];
    postsSelected?: string[];
    postsDenied?: string[];
  };
  groupsList: string[];
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  senderOptions: Array<{ id: string; label: string }>;
  freqs: string[];
  postsList?: string[];
  adjacentFreqsRange?: number;
  highlightSignalsEnabled?: boolean;
  onlyMyUnitTagsEnabled?: boolean;
  /** 'dividers' = з роздільниками, 'fluid' = плавна без роздільників (для A/B тестування). */
  messageCardLayout?: 'dividers' | 'fluid';
  onMessageCardLayoutChange?: (v: 'dividers' | 'fluid') => void;
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
  onPostsChange?: (v: string[]) => void;
  onPostsDeniedChange?: (v: string[]) => void;
  onAdjacentFreqsRangeChange?: (v: number) => void;
  onHighlightSignalsChange?: (v: boolean) => void;
  onOnlyMyUnitTagsChange?: (v: boolean) => void;
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
  postsList,
  adjacentFreqsRange,
  highlightSignalsEnabled,
  onlyMyUnitTagsEnabled,
  messageCardLayout = 'dividers',
  onMessageCardLayoutChange,
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
  onPostsChange,
  onPostsDeniedChange,
  onAdjacentFreqsRangeChange,
  onHighlightSignalsChange,
  onOnlyMyUnitTagsChange,
  onReloadFreqs,
  onSavedFilterSelect,
  onSaveFilterNameChange,
  onSaveFilter,
  onApplySavedFilter,
  onDeleteSavedFilter,
}: FeedFilterPanelProps) {
  const [senderMode, setSenderMode] = React.useState<'include' | 'exclude'>(() =>
    filterStable.deniedSenders.length > 0 ? 'exclude' : 'include',
  );
  const [freqMode, setFreqMode] = React.useState<'include' | 'exclude'>(() =>
    filterStable.freqsDenied.length > 0 ? 'exclude' : 'include',
  );
  const postsSelected = filterStable.postsSelected ?? [];
  const postsDenied = filterStable.postsDenied ?? [];
  const [postMode, setPostMode] = React.useState<'include' | 'exclude'>(() =>
    postsDenied.length > 0 ? 'exclude' : 'include',
  );

  React.useEffect(() => {
    setSenderMode((m) => {
      const includeLen = filterStable.sendersSelected.length;
      const excludeLen = filterStable.deniedSenders.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [filterStable.sendersSelected.length, filterStable.deniedSenders.length]);
  React.useEffect(() => {
    setFreqMode((m) => {
      const includeLen = filterStable.freqsSelected.length;
      const excludeLen = filterStable.freqsDenied.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [filterStable.freqsSelected.length, filterStable.freqsDenied.length]);
  React.useEffect(() => {
    setPostMode((m) => {
      const includeLen = postsSelected.length;
      const excludeLen = postsDenied.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [postsSelected.length, postsDenied.length]);

  const postValue = postMode === 'include' ? postsSelected : postsDenied;
  const postEmptyLabel = postMode === 'include' ? 'всі' : 'ніяка';

  const [localSenderValue, setLocalSenderValue] = React.useState<{ id: string; label: string }[]>(() => {
    const ids =
      filterStable.deniedSenders?.length > 0 ? filterStable.deniedSenders : (filterStable.sendersSelected ?? []);
    return ids.map((id) => {
      const o = senderOptions.find((opt) => opt.id === id);
      return o ?? { id, label: id };
    });
  });
  const senderEmptyLabel = senderMode === 'include' ? 'всі' : 'ніхто';

  const freqValue = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
  const freqEmptyLabel = freqMode === 'include' ? 'всі' : 'ніяка';
  const [localFreqValue, setLocalFreqValue] = React.useState<string[]>(() => freqValue);
  const [localPostValue, setLocalPostValue] = React.useState<string[]>(() => postValue);

  // Resync local filter selections when feed filter changes
  React.useEffect(() => {
    const ids = senderMode === 'include' ? (filterStable.sendersSelected ?? []) : (filterStable.deniedSenders ?? []);
    setLocalSenderValue(
      ids.map((id) => {
        const o = senderOptions.find((opt) => opt.id === id);
        return o ?? { id, label: id };
      }),
    );
  }, [filterStable.sendersSelected, filterStable.deniedSenders, senderMode, senderOptions]);
  React.useEffect(() => {
    const value = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
    setLocalFreqValue(value ?? []);
  }, [filterStable.freqsSelected, filterStable.freqsDenied, freqMode]);
  React.useEffect(() => {
    const value = postMode === 'include' ? (filterStable.postsSelected ?? []) : (filterStable.postsDenied ?? []);
    setLocalPostValue(value);
  }, [filterStable.postsSelected, filterStable.postsDenied, postMode]);

  React.useEffect(() => {
    if (senderMode === 'include') onSendersChange(localSenderValue.map((o) => o.id));
    else onDeniedSendersChange(localSenderValue.map((o) => o.id));
  }, [localSenderValue]);

  React.useEffect(() => {
    if (freqMode === 'include') onFreqsChange(localFreqValue);
    else onFreqsDeniedChange(localFreqValue);
  }, [localFreqValue]);

  React.useEffect(() => {
    if (postMode === 'include') onPostsChange?.(localPostValue);
    else onPostsDeniedChange?.(localPostValue);
  }, [localPostValue]);

  return (
    <Paper variant="outlined" className="p-3 z-2">
      <Box className="flex flex-col gap-3">
        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Групи
          </Typography>
          <Box className="flex flex-wrap gap-1 items-center">
            <PowerChip
              label="всі"
              size="small"
              selected={filterStable.groupsSelected.length === 0}
              onClick={onSelectAllGroups}
            />
            {groupsList.map((key) => {
              const name = groupInfos[key]?.name ?? key;
              const selected = filterStable.groupsSelected.includes(key);
              return (
                <PowerChip key={key} label={name} size="small" selected={selected} onClick={() => onToggleGroup(key)} />
              );
            })}
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Відправник
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={senderMode}
              exclusive
              onChange={(_, v) => {
                if (v == null) return;
                setSenderMode(v);
                setLocalSenderValue([]);
                if (v === 'include') onDeniedSendersChange([]);
                else onSendersChange([]);
              }}
              size="small"
              sx={{
                flexShrink: 0,
                borderRadius: 3,
                '& .MuiToggleButton-root': { borderRadius: 2, textTransform: 'lowercase' },
              }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>

            <Autocomplete
              multiple
              size="small"
              options={senderOptions}
              getOptionLabel={(option) => option.label}
              value={localSenderValue}
              onChange={(_, value) => setLocalSenderValue(value)}
              isOptionEqualToValue={(option, val) => option.id === val.id}
              filterSelectedOptions
              clearOnEscape
              renderInput={(params) => (
                <TextField {...params} placeholder={localSenderValue.length === 0 ? senderEmptyLabel : undefined} />
              )}
              className="min-w-[180px] flex-1"
            />
          </Box>
        </Box>

        <Box>
          <Box className="flex items-center justify-between mb-1">
            <Typography variant="subtitle2" className="font-semibold">
              Частота
            </Typography>
            <Tooltip title="Оновити список частот">
              <span>
                <IconButton
                  size="small"
                  disabled={reloadFreqsLoading}
                  onClick={onReloadFreqs}
                  aria-label="Оновити список частот"
                  sx={{ padding: 0.5 }}
                >
                  {reloadFreqsLoading ? (
                    <CircularProgress size={18} />
                  ) : (
                    <i className="bi bi-arrow-clockwise w-[21px]" style={{ fontSize: '1rem' }} />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={freqMode}
              exclusive
              onChange={(_, v) => {
                if (v == null) return;
                setFreqMode(v);
                setLocalFreqValue([]);
                if (v === 'include') onFreqsDeniedChange([]);
                else onFreqsChange([]);
              }}
              size="small"
              sx={{
                flexShrink: 0,
                borderRadius: 3,
                '& .MuiToggleButton-root': { borderRadius: 2, textTransform: 'lowercase' },
              }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={freqs}
              getOptionLabel={(option) => option}
              value={localFreqValue}
              onChange={(_, value) => setLocalFreqValue(value)}
              filterSelectedOptions
              clearOnEscape
              renderInput={(params) => (
                <TextField {...params} placeholder={localFreqValue.length === 0 ? freqEmptyLabel : undefined} />
              )}
              className="min-w-[160px] flex-1"
            />
          </Box>
          <Box className="flex flex-wrap gap-2 justify-end mt-1">
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
                onChange={(e) => onAdjacentFreqsRangeChange?.(Number(e.target.value))}
                displayEmpty
              >
                {ADJACENT_FREQS_RANGE_OPTIONS.map((r) => (
                  <MenuItem key={r} value={r}>
                    {r === 0 ? 'вимкнено' : `${r * 1000} кГц`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Пост
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={postMode}
              exclusive
              onChange={(_, v) => {
                if (v == null) return;
                setPostMode(v);
                setLocalPostValue([]);
                if (v === 'include') onPostsDeniedChange?.([]);
                else onPostsChange?.([]);
              }}
              size="small"
              sx={{
                flexShrink: 0,
                borderRadius: 3,
                '& .MuiToggleButton-root': { borderRadius: 2, textTransform: 'lowercase' },
              }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={postsList ?? []}
              getOptionLabel={(option) => option}
              value={localPostValue}
              onChange={(_, value) => setLocalPostValue(value)}
              filterSelectedOptions
              clearOnEscape
              renderInput={(params) => (
                <TextField {...params} placeholder={localPostValue.length === 0 ? postEmptyLabel : undefined} />
              )}
              className="min-w-[160px] flex-1"
            />
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Додатково
          </Typography>
          <Box className="flex flex-col gap-1">
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={highlightSignalsEnabled ?? false}
                  onChange={(_, checked) => onHighlightSignalsChange?.(checked)}
                />
              }
              label="підсвічувати сигнали"
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={onlyMyUnitTagsEnabled ?? false}
                  onChange={(_, checked) => onOnlyMyUnitTagsChange?.(checked)}
                />
              }
              label="лише теги мого підрозділу"
            />
            {onMessageCardLayoutChange != null && (
              <Box className="flex items-center gap-2 mt-1">
                <Typography variant="caption" sx={{ fontSize: 12 }}>
                  картка повідомлення:
                </Typography>
                <ToggleButtonGroup
                  value={messageCardLayout}
                  exclusive
                  onChange={(_, v: 'dividers' | 'fluid' | null) => {
                    if (v != null) onMessageCardLayoutChange(v);
                  }}
                  size="small"
                  sx={{
                    flexShrink: 0,
                    borderRadius: 2,
                    '& .MuiToggleButton-root': { borderRadius: 1, textTransform: 'none', fontSize: 12 },
                  }}
                >
                  <ToggleButton value="dividers">з роздільниками</ToggleButton>
                  <ToggleButton value="fluid">без роздільників</ToggleButton>
                </ToggleButtonGroup>
              </Box>
            )}
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
