import {
  Box,
  Button,
  Checkbox,
  Chip,
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
import { profileLabel } from './utils';

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
  const setPostValue = postMode === 'include' ? (onPostsChange ?? (() => {})) : (onPostsDeniedChange ?? (() => {}));
  const postEmptyLabel = postMode === 'include' ? 'всі' : 'ніяка';

  const senderValue = senderMode === 'include' ? filterStable.sendersSelected : filterStable.deniedSenders;
  const setSenderValue = senderMode === 'include' ? onSendersChange : onDeniedSendersChange;
  const senderEmptyLabel = senderMode === 'include' ? 'всі' : 'ніхто';

  const freqValue = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
  const setFreqValue = freqMode === 'include' ? onFreqsChange : onFreqsDeniedChange;
  const freqEmptyLabel = freqMode === 'include' ? 'всі' : 'ніяка';

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
            <ToggleButtonGroup
              value={senderMode}
              exclusive
              onChange={(_, v) => {
                if (v == null) return;
                setSenderMode(v);
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
            <FormControl size="small" className="min-w-[180px] flex-1">
              <Select
                multiple
                displayEmpty
                value={senderValue}
                onChange={(e) => setSenderValue((e.target.value as string[]) || [])}
                renderValue={(sel) =>
                  (sel as string[]).length === 0
                    ? senderEmptyLabel
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
            <FormControl size="small" className="min-w-[160px] flex-1">
              <Select
                multiple
                displayEmpty
                value={freqValue}
                onChange={(e) => setFreqValue((e.target.value as string[]) || [])}
                renderValue={(sel) => ((sel as string[]).length === 0 ? freqEmptyLabel : (sel as string[]).join(', '))}
              >
                {freqs.map((f) => (
                  <MenuItem key={f} value={f}>
                    {f}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
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
            <FormControl size="small" className="min-w-[160px] flex-1">
              <Select
                multiple
                displayEmpty
                value={postValue}
                onChange={(e) => setPostValue((e.target.value as string[]) || [])}
                renderValue={(sel) => ((sel as string[]).length === 0 ? postEmptyLabel : (sel as string[]).join(', '))}
              >
                {(postsList ?? []).map((p) => (
                  <MenuItem key={p} value={p}>
                    {p}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
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
