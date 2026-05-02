import {
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  FormControl,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useEffect, useRef, useState } from 'react';
import type { SavedFilterDuty, SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import { SavedFiltersControl } from '../../components/SavedFiltersControl';
import { ADJACENT_FREQS_RANGE_OPTIONS, normalizeFeed } from './utils';

export type FeedFilterPanelProps = {
  feedId: string;
  filterStable: {
    groupsSelected: string[];
    deniedGroups: string[];
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
  onGroupsChange: (v: string[]) => void;
  onDeniedGroupsChange: (v: string[]) => void;
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
  onSaveFilter: (feedId: string, name: string) => Promise<boolean>;
  onUpdateSelectedSavedFilter: (feedId: string) => Promise<void>;
  onRenameSelectedSavedFilter: (feedId: string, name: string) => Promise<boolean>;
  onDeleteSelectedSavedFilter: (feedId: string) => Promise<void>;
  onApplySavedFilter: (saved: SavedFilterDuty) => void;
};

export function FeedFilterPanel({
  feedId,
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
  onSavedFilterSelect,
  onSaveFilterNameChange,
  onSaveFilter,
  onUpdateSelectedSavedFilter,
  onRenameSelectedSavedFilter,
  onDeleteSelectedSavedFilter,
  onApplySavedFilter,
}: FeedFilterPanelProps) {
  const [groupMode, setGroupMode] = useState<'include' | 'exclude'>(() =>
    filterStable.deniedGroups.length > 0 ? 'exclude' : 'include',
  );
  const [senderMode, setSenderMode] = useState<'include' | 'exclude'>(() =>
    filterStable.deniedSenders.length > 0 ? 'exclude' : 'include',
  );
  const [freqMode, setFreqMode] = useState<'include' | 'exclude'>(() =>
    filterStable.freqsDenied.length > 0 ? 'exclude' : 'include',
  );
  const postsSelected = filterStable.postsSelected ?? [];
  const postsDenied = filterStable.postsDenied ?? [];
  const [postMode, setPostMode] = useState<'include' | 'exclude'>(() =>
    postsDenied.length > 0 ? 'exclude' : 'include',
  );
  const toggleGroupSx = {
    flexShrink: 0,
    height: 36,
    borderRadius: 1,
    border: '1px solid rgba(148, 163, 184, 0.34)',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    '& .MuiToggleButtonGroup-grouped': {
      margin: 0,
      borderRadius: 0,
      border: 0,
      minHeight: 36,
      height: 36,
      '&:not(:first-of-type)': {
        borderLeft: '1px solid rgba(148, 163, 184, 0.34)',
      },
    },
    '& .MuiToggleButtonGroup-firstButton': {
      borderTopLeftRadius: 'inherit',
      borderBottomLeftRadius: 'inherit',
    },
    '& .MuiToggleButtonGroup-lastButton': {
      borderTopRightRadius: 'inherit',
      borderBottomRightRadius: 'inherit',
    },
    '& .MuiToggleButton-root': {
      minHeight: 36,
      height: 36,
      overflow: 'hidden',
      textTransform: 'none',
      fontSize: 13,
      px: 2,
      py: 0,
      whiteSpace: 'nowrap',
      color: 'text.primary',
      backgroundColor: 'transparent',
      '&:hover': {
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
      },
      '&.Mui-selected': {
        backgroundColor: 'rgba(148, 163, 184, 0.18)',
      },
      '&.Mui-selected:hover': {
        backgroundColor: 'rgba(148, 163, 184, 0.24)',
      },
    },
  } as const;

  useEffect(() => {
    setGroupMode((m) => {
      const includeLen = filterStable.groupsSelected.length;
      const excludeLen = filterStable.deniedGroups.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [filterStable.groupsSelected.length, filterStable.deniedGroups.length]);
  useEffect(() => {
    setSenderMode((m) => {
      const includeLen = filterStable.sendersSelected.length;
      const excludeLen = filterStable.deniedSenders.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [filterStable.sendersSelected.length, filterStable.deniedSenders.length]);
  useEffect(() => {
    setFreqMode((m) => {
      const includeLen = filterStable.freqsSelected.length;
      const excludeLen = filterStable.freqsDenied.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [filterStable.freqsSelected.length, filterStable.freqsDenied.length]);
  useEffect(() => {
    setPostMode((m) => {
      const includeLen = postsSelected.length;
      const excludeLen = postsDenied.length;
      if (m === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (m === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return m;
    });
  }, [postsSelected.length, postsDenied.length]);

  /** Stable deps for resync effects — parent uses `x ?? []` so empty filters get a new [] each render. */
  const groupsSelectedKey = JSON.stringify(filterStable.groupsSelected);
  const deniedGroupsKey = JSON.stringify(filterStable.deniedGroups);
  const sendersSelectedKey = JSON.stringify(filterStable.sendersSelected);
  const deniedSendersKey = JSON.stringify(filterStable.deniedSenders);
  const freqsSelectedKey = JSON.stringify(filterStable.freqsSelected);
  const freqsDeniedKey = JSON.stringify(filterStable.freqsDenied);
  const postsSelectedKey = JSON.stringify(postsSelected);
  const postsDeniedKey = JSON.stringify(postsDenied);

  const postValue = postMode === 'include' ? postsSelected : postsDenied;
  const postEmptyLabel = postMode === 'include' ? 'всі' : 'ніяка';

  const [localSenderValue, setLocalSenderValue] = useState<{ id: string; label: string }[]>(() => {
    const ids =
      filterStable.deniedSenders?.length > 0 ? filterStable.deniedSenders : (filterStable.sendersSelected ?? []);
    return ids.map((id) => {
      const o = senderOptions.find((opt) => opt.id === id);
      return o ?? { id, label: id };
    });
  });
  const senderEmptyLabel = senderMode === 'include' ? 'всі' : 'ніхто';
  const groupEmptyLabel = groupMode === 'include' ? 'всі' : 'ніяка';

  const freqValue = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
  const freqEmptyLabel = freqMode === 'include' ? 'всі' : 'ніяка';
  const [localFreqValue, setLocalFreqValue] = useState<string[]>(() => freqValue);
  const [localPostValue, setLocalPostValue] = useState<string[]>(() => postValue);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const sortedGroupKeys = [...groupsList].sort((a, b) =>
    (groupInfos[a]?.name ?? a).localeCompare(groupInfos[b]?.name ?? b),
  );
  const [localGroupValue, setLocalGroupValue] = useState<string[]>(() =>
    filterStable.deniedGroups?.length > 0 ? filterStable.deniedGroups : (filterStable.groupsSelected ?? []),
  );
  const pendingGroupResyncRef = useRef<string | null>(null);
  const loadedSavedFilter =
    selectedSavedId == null ? null : (savedFilters.find((savedFilter) => savedFilter.id === selectedSavedId) ?? null);
  const loadedFilterNormalized =
    loadedSavedFilter == null ? null : normalizeFeed(loadedSavedFilter.req as unknown as Record<string, unknown>);
  const isDirty =
    loadedFilterNormalized != null &&
    !(
      JSON.stringify(filterStable.groupsSelected) === JSON.stringify(loadedFilterNormalized.groupsSelected ?? []) &&
      JSON.stringify(filterStable.deniedGroups) === JSON.stringify(loadedFilterNormalized.groupsDenied ?? []) &&
      JSON.stringify(filterStable.sendersSelected) === JSON.stringify(loadedFilterNormalized.sendersSelected ?? []) &&
      JSON.stringify(filterStable.deniedSenders) === JSON.stringify(loadedFilterNormalized.deniedSenders ?? []) &&
      JSON.stringify(filterStable.freqsSelected) === JSON.stringify(loadedFilterNormalized.freqsSelected ?? []) &&
      JSON.stringify(filterStable.freqsDenied) === JSON.stringify(loadedFilterNormalized.freqsDenied ?? []) &&
      JSON.stringify(filterStable.postsSelected ?? []) === JSON.stringify(loadedFilterNormalized.postsSelected ?? []) &&
      JSON.stringify(filterStable.postsDenied ?? []) === JSON.stringify(loadedFilterNormalized.postsDenied ?? [])
    );

  const runSavedFilterAction = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (saveInFlight) return;
    setSaveInFlight(true);
    try {
      return await action();
    } finally {
      setSaveInFlight(false);
    }
  };

  // Resync local selections when *parent* filter changes. Do not depend on local* state: if local
  // is in deps, this runs after user picks an option but before the parent applies it, and would
  // overwrite the selection with the old filter → fight with writeback + MUI Autocomplete loop.
  useEffect(() => {
    const value = groupMode === 'include' ? filterStable.groupsSelected : filterStable.deniedGroups;
    const next = value ?? [];
    setLocalGroupValue((prev) => {
      const nextSignature = `${groupMode}:${JSON.stringify(next)}`;
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) return prev;
      pendingGroupResyncRef.current = nextSignature;
      return next;
    });
  }, [groupsSelectedKey, deniedGroupsKey, groupMode]);
  useEffect(() => {
    const ids = senderMode === 'include' ? (filterStable.sendersSelected ?? []) : (filterStable.deniedSenders ?? []);
    setLocalSenderValue((prev) => {
      const currentIds = prev.map((o) => o.id);
      if (ids.length === currentIds.length && ids.every((id, i) => id === currentIds[i])) return prev;
      return ids.map((id) => {
        const o = senderOptions.find((opt) => opt.id === id);
        return o ?? { id, label: id };
      });
    });
  }, [sendersSelectedKey, deniedSendersKey, senderMode, senderOptions]);
  useEffect(() => {
    const value = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
    const next = value ?? [];
    setLocalFreqValue((prev) => {
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) return prev;
      return next;
    });
  }, [freqsSelectedKey, freqsDeniedKey, freqMode]);
  useEffect(() => {
    const value = postMode === 'include' ? (filterStable.postsSelected ?? []) : (filterStable.postsDenied ?? []);
    setLocalPostValue((prev) => {
      if (value.length === prev.length && value.every((v, i) => v === prev[i])) return prev;
      return value;
    });
  }, [postsSelectedKey, postsDeniedKey, postMode]);

  // Push local selections to parent only when they differ from filterStable; avoid rewriting on mount
  useEffect(() => {
    const nextSignature = `${groupMode}:${JSON.stringify(localGroupValue)}`;
    if (pendingGroupResyncRef.current === nextSignature) {
      pendingGroupResyncRef.current = null;
      return;
    }
    const current = groupMode === 'include' ? filterStable.groupsSelected : filterStable.deniedGroups;
    const next = localGroupValue;
    if (current.length === next.length && current.every((v, i) => v === next[i])) return;
    if (groupMode === 'include') onGroupsChange(next);
    else onDeniedGroupsChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on localGroupValue so writeback runs after resync
  }, [groupMode, localGroupValue]);

  useEffect(() => {
    const ids = localSenderValue.map((o) => o.id);
    const current = senderMode === 'include' ? filterStable.sendersSelected : filterStable.deniedSenders;
    if (current == null && ids.length === 0) return;
    if (current != null && current.length === ids.length && current.every((id, i) => id === ids[i])) return;
    if (senderMode === 'include') onSendersChange(ids);
    else onDeniedSendersChange(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on localSenderValue so writeback runs after resync
  }, [localSenderValue]);

  useEffect(() => {
    const current = freqMode === 'include' ? filterStable.freqsSelected : filterStable.freqsDenied;
    if (current == null && localFreqValue.length === 0) return;
    if (current != null && current.length === localFreqValue.length && current.every((v, i) => v === localFreqValue[i]))
      return;
    if (freqMode === 'include') onFreqsChange(localFreqValue);
    else onFreqsDeniedChange(localFreqValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on localFreqValue so writeback runs after resync
  }, [localFreqValue]);

  useEffect(() => {
    const current = postMode === 'include' ? filterStable.postsSelected : filterStable.postsDenied;
    if (current == null && localPostValue.length === 0) return;
    if (current != null && current.length === localPostValue.length && current.every((v, i) => v === localPostValue[i]))
      return;
    if (postMode === 'include') onPostsChange?.(localPostValue);
    else onPostsDeniedChange?.(localPostValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on localPostValue so writeback runs after resync
  }, [localPostValue]);

  return (
    <Paper
      variant="outlined"
      className="z-2"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: 'auto',
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
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          px: 2,
          py: 2,
          background:
            'linear-gradient(180deg, rgba(16, 20, 28, 0.98) 0%, rgba(12, 16, 24, 0.98) 100%)',
          borderTop: '1px solid rgba(148, 163, 184, 0.28)',
          borderRadius: 0,
        }}
      >
        <Box>
          <Typography variant="subtitle2" className="mb-2 font-semibold">
            Групи
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={groupMode}
              exclusive
              onChange={(_, v) => {
                if (v == null) return;
                setGroupMode(v);
                setLocalGroupValue([]);
                if (v === 'include') onDeniedGroupsChange([]);
                else onGroupsChange([]);
              }}
              size="small"
              sx={toggleGroupSx}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={sortedGroupKeys}
              getOptionLabel={(key) => groupInfos[key]?.name ?? key}
              value={localGroupValue}
              onChange={(_, value) => setLocalGroupValue(value)}
              filterSelectedOptions
              clearOnEscape
              renderOption={(props, option, state) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={`${option}-${state.index}`}>
                    {groupInfos[option]?.name ?? option}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={localGroupValue.length === 0 ? groupEmptyLabel : undefined} />
              )}
              className="min-w-0 w-full min-[1024px]:min-w-[180px] min-[1024px]:flex-1"
            />
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
              sx={toggleGroupSx}
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
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={option.id}>
                    {option.label}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={localSenderValue.length === 0 ? senderEmptyLabel : undefined} />
              )}
              className="min-w-0 w-full min-[1024px]:min-w-[180px] min-[1024px]:flex-1"
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
                    <RefreshOutlinedIcon sx={{ fontSize: '1rem' }} />
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
              sx={toggleGroupSx}
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
              renderOption={(props, option, state) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={`${option}-${state.index}`}>
                    {option}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={localFreqValue.length === 0 ? freqEmptyLabel : undefined} />
              )}
              className="min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1"
            />
          </Box>
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
              sx={toggleGroupSx}
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
              renderOption={(props, option, state) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={`${option}-${state.index}`}>
                    {option}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={localPostValue.length === 0 ? postEmptyLabel : undefined} />
              )}
              className="min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1"
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
          </Box>
        </Box>

        <Box>
          <SavedFiltersControl
            savedFilters={savedFilters}
            selectedSavedFilter={loadedSavedFilter}
            savedFilterName={saveFilterName}
            isDirty={isDirty}
            saveInFlight={saveInFlight}
            onApplySavedFilter={(saved) => {
              if (saved == null) {
                onSavedFilterSelect('');
                return;
              }
              onSavedFilterSelect(saved.id);
              onApplySavedFilter(saved);
            }}
            onSavedFilterNameChange={onSaveFilterNameChange}
            onUpdateExisting={() => runSavedFilterAction(() => onUpdateSelectedSavedFilter(feedId))}
            onSaveAsNew={(name) =>
              runSavedFilterAction(() => onSaveFilter(feedId, name)).then((result) => result === true)
            }
            onRenameExisting={(name) =>
              runSavedFilterAction(() => onRenameSelectedSavedFilter(feedId, name)).then((result) => result === true)
            }
            onDeleteExisting={() => runSavedFilterAction(() => onDeleteSelectedSavedFilter(feedId))}
          />
        </Box>
      </Box>
    </Paper>
  );
}
