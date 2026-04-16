import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import { savedFilterDelete, savedFilterRename, savedFilterUpsert } from '../../services/api/inbox';
import { useRerDutyFilterOptions } from '../rer-duty-neo/useRerDutyFilterOptions';
import { emptyFilter, normalizeFeed, profileLabel } from '../rer-duty-neo/utils';

const EMPTY_FILTER = emptyFilter();

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function normalizeList(values?: string[] | null): string[] {
  return values ?? [];
}

function toNullableList(values: string[]): string[] | null {
  return values.length > 0 ? values : null;
}

export function SettingsDutySavedFiltersSection() {
  const {
    profiles,
    freqs,
    postsList,
    groupsList,
    groupInfos,
    savedFilters,
    setSavedFilters,
    reloadFreqsLoading,
    reloadLatestFrequencies,
  } = useRerDutyFilterOptions();
  const [selectedSavedId, setSelectedSavedId] = useState<number | null>(null);
  const [draftFilter, setDraftFilter] = useState<RerDutyFeedFilterState>(EMPTY_FILTER);
  const [renameName, setRenameName] = useState('');
  const [duplicateName, setDuplicateName] = useState('');
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [groupMode, setGroupMode] = useState<'include' | 'exclude'>('include');
  const [senderMode, setSenderMode] = useState<'include' | 'exclude'>('include');
  const [freqMode, setFreqMode] = useState<'include' | 'exclude'>('include');
  const [postMode, setPostMode] = useState<'include' | 'exclude'>('include');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const sortedSavedFilters = useMemo(
    () => [...savedFilters].sort((a, b) => a.name.localeCompare(b.name)),
    [savedFilters]
  );

  const selectedSaved = useMemo(
    () => savedFilters.find((s) => s.id === selectedSavedId) ?? null,
    [savedFilters, selectedSavedId]
  );

  const sortedGroupKeys = useMemo(
    () => [...groupsList].sort((a, b) => (groupInfos[a]?.name ?? a).localeCompare(groupInfos[b]?.name ?? b)),
    [groupsList, groupInfos]
  );

  const senderOptions = useMemo(
    () =>
      Object.entries(profiles)
        .map(([id, entry]) => ({ id, label: profileLabel(id, entry) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [profiles]
  );

  const senderOptionById = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>();
    senderOptions.forEach((opt) => map.set(opt.id, opt));
    return map;
  }, [senderOptions]);

  useEffect(() => {
    if (!selectedSaved) {
      setDraftFilter(EMPTY_FILTER);
      setRenameName('');
      setDuplicateName('');
      setGroupMode('include');
      setSenderMode('include');
      setFreqMode('include');
      setPostMode('include');
      return;
    }
    const normalized = normalizeFeed(selectedSaved.req as unknown as Record<string, unknown>);
    setDraftFilter(normalized);
    setRenameName(selectedSaved.name);
    setGroupMode((prev) => (normalized.groupsDenied?.length ? 'exclude' : prev));
    setSenderMode((prev) => (normalized.deniedSenders?.length ? 'exclude' : prev));
    setFreqMode((prev) => (normalized.freqsDenied?.length ? 'exclude' : prev));
    setPostMode((prev) => (normalized.postsDenied?.length ? 'exclude' : prev));
    setActionSuccess(null);
    setActionError(null);
  }, [selectedSaved]);

  const updateDraft = (next: Partial<RerDutyFeedFilterState>) => {
    setDraftFilter((prev) => ({ ...prev, ...next }));
  };

  const currentGroups = groupMode === 'include' ? normalizeList(draftFilter.groupsSelected) : normalizeList(draftFilter.groupsDenied);
  const currentSenders = senderMode === 'include' ? normalizeList(draftFilter.sendersSelected) : normalizeList(draftFilter.deniedSenders);
  const currentFreqs = freqMode === 'include' ? normalizeList(draftFilter.freqsSelected) : normalizeList(draftFilter.freqsDenied);
  const currentPosts = postMode === 'include' ? normalizeList(draftFilter.postsSelected) : normalizeList(draftFilter.postsDenied);

  const updateGroups = (next: string[]) => {
    if (groupMode === 'include') {
      updateDraft({ groupsSelected: toNullableList(next), groupsDenied: null });
    } else {
      updateDraft({ groupsDenied: toNullableList(next), groupsSelected: null });
    }
  };

  const updateSenders = (next: string[]) => {
    if (senderMode === 'include') {
      updateDraft({ sendersSelected: toNullableList(next), deniedSenders: null });
    } else {
      updateDraft({ deniedSenders: toNullableList(next), sendersSelected: null });
    }
  };

  const handleDuplicateFilter = async () => {
    if (!selectedSaved) return;
    const trimmed = duplicateName.trim();
    if (!trimmed) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);
    try {
      const list = await savedFilterUpsert({ name: trimmed, req: draftFilter });
      setSavedFilters(list);
      setDuplicateDialogOpen(false);
      setActionSuccess('Фільтр продубльовано');
    } catch (error) {
      setActionError(`Помилка дублювання: ${formatErrorMessage(error)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const updateFreqs = (next: string[]) => {
    if (freqMode === 'include') {
      updateDraft({ freqsSelected: toNullableList(next), freqsDenied: null });
    } else {
      updateDraft({ freqsDenied: toNullableList(next), freqsSelected: null });
    }
  };

  const updatePosts = (next: string[]) => {
    if (postMode === 'include') {
      updateDraft({ postsSelected: toNullableList(next), postsDenied: null });
    } else {
      updateDraft({ postsDenied: toNullableList(next), postsSelected: null });
    }
  };

  const handleUpdateFilter = async () => {
    if (!selectedSaved) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);
    try {
      const list = await savedFilterUpsert({ name: selectedSaved.name, req: draftFilter });
      setSavedFilters(list);
      setActionSuccess('Фільтр оновлено');
    } catch (error) {
      setActionError(`Помилка оновлення: ${formatErrorMessage(error)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRenameFilter = async () => {
    if (!selectedSaved) return;
    const trimmed = renameName.trim();
    if (!trimmed || trimmed === selectedSaved.name) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);
    try {
      await savedFilterRename({ id: selectedSaved.id, name: trimmed });
      setSavedFilters((prev) => prev.map((f) => (f.id === selectedSaved.id ? { ...f, name: trimmed } : f)));
      setRenameDialogOpen(false);
      setActionSuccess('Назву змінено');
    } catch (error) {
      setActionError(`Помилка перейменування: ${formatErrorMessage(error)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteFilter = async () => {
    if (!selectedSaved) return;
    const confirmed = window.confirm(`Видалити фільтр "${selectedSaved.name}"?`);
    if (!confirmed) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);
    try {
      await savedFilterDelete(selectedSaved.id);
      setSavedFilters((prev) => prev.filter((f) => f.id !== selectedSaved.id));
      setSelectedSavedId(null);
      setActionSuccess('Фільтр видалено');
    } catch (error) {
      setActionError(`Помилка видалення: ${formatErrorMessage(error)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const openRenameDialog = () => {
    if (!selectedSaved) return;
    setRenameName(selectedSaved.name);
    setRenameDialogOpen(true);
  };

  const openDuplicateDialog = () => {
    if (!selectedSaved) return;
    setDuplicateName(`${selectedSaved.name} (копія)`);
    setDuplicateDialogOpen(true);
  };

  const senderValue = currentSenders.map((id) => senderOptionById.get(id) ?? { id, label: id });

  return (
    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 3 }}>
      <Stack spacing={2}>
        <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 600 }}>
          Збережені фільтри (Оперативний)
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Оберіть фільтр, змініть частоти чи інші поля, та натисніть “Оновити цей фільтр”.
        </Typography>
        {actionError ? <Alert severity="error">{actionError}</Alert> : null}
        {actionSuccess ? <Alert severity="success">{actionSuccess}</Alert> : null}

        <Stack spacing={2}>
          <Box className="flex flex-wrap gap-2 items-center">
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="settings-duty-saved-filter">вибрати фільтр</InputLabel>
              <Select
                labelId="settings-duty-saved-filter"
                label="вибрати фільтр"
                value={selectedSavedId ?? ''}
                onChange={(e) => setSelectedSavedId(e.target.value === '' ? null : Number(e.target.value))}
              >
                <MenuItem value="">—</MenuItem>
                {sortedSavedFilters.map((filter) => (
                  <MenuItem key={filter.id} value={filter.id}>
                    {filter.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Tooltip title="Перейменувати фільтр">
              <span>
                <IconButton size="small" onClick={openRenameDialog} disabled={actionLoading || !selectedSaved} aria-label="Перейменувати фільтр">
                  <i className="bi bi-pencil-square" />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Дублювати фільтр">
              <span>
                <IconButton size="small" onClick={openDuplicateDialog} disabled={actionLoading || !selectedSaved} aria-label="Дублювати фільтр">
                  <i className="bi bi-files" />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Оновити поточний фільтр">
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={handleUpdateFilter}
                  disabled={actionLoading || !selectedSaved}
                  aria-label="Оновити поточний фільтр"
                >
                  {actionLoading ? <CircularProgress size={16} /> : <i className="bi bi-arrow-clockwise" />}
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Видалити фільтр">
              <span>
                <IconButton
                  size="small"
                  color="error"
                  onClick={handleDeleteFilter}
                  disabled={actionLoading || !selectedSaved}
                  aria-label="Видалити фільтр"
                >
                  <i className="bi bi-trash" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Stack>

        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Групи
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={groupMode}
              exclusive
              onChange={(_, v) => {
                if (!v) return;
                setGroupMode(v);
                updateGroups([]);
              }}
              size="small"
              sx={{ '& .MuiToggleButton-root': { textTransform: 'lowercase' } }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={sortedGroupKeys}
              getOptionLabel={(key) => groupInfos[key]?.name ?? key}
              value={currentGroups}
              onChange={(_, value) => updateGroups(value)}
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
              renderInput={(params) => <TextField {...params} placeholder={groupMode === 'include' ? 'всі' : 'ніяка'} />}
              className="min-w-[200px] flex-1"
            />
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Відправник
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={senderMode}
              exclusive
              onChange={(_, v) => {
                if (!v) return;
                setSenderMode(v);
                updateSenders([]);
              }}
              size="small"
              sx={{ '& .MuiToggleButton-root': { textTransform: 'lowercase' } }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={senderOptions}
              value={senderValue}
              onChange={(_, value) => updateSenders(value.map((v) => v.id))}
              getOptionLabel={(option) => option.label}
              isOptionEqualToValue={(option, val) => option.id === val.id}
              renderInput={(params) => <TextField {...params} placeholder={senderMode === 'include' ? 'всі' : 'ніхто'} />}
              className="min-w-[220px] flex-1"
            />
          </Box>
        </Box>

        <Box>
          <Box className="flex items-center justify-between mb-1">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              Частота
            </Typography>
            <Button size="small" variant="text" onClick={reloadLatestFrequencies} disabled={reloadFreqsLoading}>
              {reloadFreqsLoading ? <CircularProgress size={16} /> : 'оновити список'}
            </Button>
          </Box>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={freqMode}
              exclusive
              onChange={(_, v) => {
                if (!v) return;
                setFreqMode(v);
                updateFreqs([]);
              }}
              size="small"
              sx={{ '& .MuiToggleButton-root': { textTransform: 'lowercase' } }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={freqs}
              value={currentFreqs}
              onChange={(_, value) => updateFreqs(value)}
              renderInput={(params) => <TextField {...params} placeholder={freqMode === 'include' ? 'всі' : 'ніяка'} />}
              className="min-w-[200px] flex-1"
            />
          </Box>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Пост
          </Typography>
          <Box className="flex flex-wrap gap-2 items-center">
            <ToggleButtonGroup
              value={postMode}
              exclusive
              onChange={(_, v) => {
                if (!v) return;
                setPostMode(v);
                updatePosts([]);
              }}
              size="small"
              sx={{ '& .MuiToggleButton-root': { textTransform: 'lowercase' } }}
            >
              <ToggleButton value="include">лише</ToggleButton>
              <ToggleButton value="exclude">окрім</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              size="small"
              options={postsList}
              value={currentPosts}
              onChange={(_, value) => updatePosts(value)}
              renderInput={(params) => <TextField {...params} placeholder={postMode === 'include' ? 'всі' : 'ніяка'} />}
              className="min-w-[200px] flex-1"
            />
          </Box>
        </Box>
      </Stack>

      <Dialog open={renameDialogOpen} onClose={() => setRenameDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Перейменувати фільтр</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Нова назва"
            fullWidth
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" variant="text" onClick={() => setRenameDialogOpen(false)}>
            скасувати
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={handleRenameFilter}
            disabled={actionLoading || !selectedSaved || !renameName.trim() || renameName.trim() === selectedSaved?.name}
          >
            зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={duplicateDialogOpen} onClose={() => setDuplicateDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Дублювати фільтр</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Назва нового фільтра"
            fullWidth
            value={duplicateName}
            onChange={(e) => setDuplicateName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" variant="text" onClick={() => setDuplicateDialogOpen(false)}>
            скасувати
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={handleDuplicateFilter}
            disabled={actionLoading || !selectedSaved || !duplicateName.trim()}
          >
            дублювати
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
