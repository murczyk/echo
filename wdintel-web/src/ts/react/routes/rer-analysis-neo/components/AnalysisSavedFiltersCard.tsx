import { Autocomplete, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import React from 'react';

import type { SavedFilter } from '../../../../../Bindings';

type Props = {
  isDirty: boolean;
  loadedSavedFilter: SavedFilter | null;
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  onApplySavedFilter: (savedFilter: SavedFilter | null) => void;
  onDeleteLoadedSavedFilter: () => void;
  onRenameExisting: () => void;
  onSaveAsNew: () => void;
  onSavedFilterNameChange: (name: string) => void;
  onUpdateExisting: () => void;
};

export function AnalysisSavedFiltersCard({
  isDirty,
  loadedSavedFilter,
  saveInFlight,
  savedFilterName,
  savedFilters,
  onApplySavedFilter,
  onDeleteLoadedSavedFilter,
  onRenameExisting,
  onSaveAsNew,
  onSavedFilterNameChange,
  onUpdateExisting,
}: Props) {
  const canRenameExisting =
    !saveInFlight && loadedSavedFilter != null && savedFilterName.trim() !== '' && savedFilterName.trim() !== loadedSavedFilter.name;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">Збережені фільтри</Typography>
        <Autocomplete
          size="small"
          options={savedFilters}
          getOptionLabel={(option) => option.name}
          value={loadedSavedFilter}
          onChange={(_event, next) => onApplySavedFilter(next)}
          renderInput={(params) => <TextField {...params} label="Збережений фільтр" />}
        />
        <TextField
          size="small"
          label="Назва фільтра"
          value={savedFilterName}
          onChange={(event) => onSavedFilterNameChange(event.target.value)}
        />
        <Stack spacing={1.25} sx={{ width: '100%' }}>
          <Button
            variant="contained"
            onClick={onSaveAsNew}
            disabled={saveInFlight || savedFilterName.trim() === ''}
            fullWidth
          >
            Зберегти як новий
          </Button>
          <Button variant="outlined" onClick={onRenameExisting} disabled={!canRenameExisting} fullWidth>
            Перейменувати
          </Button>
          <Button
            variant="outlined"
            onClick={onUpdateExisting}
            disabled={saveInFlight || loadedSavedFilter == null || !isDirty}
            fullWidth
          >
            Оновити існуючий
          </Button>
          <Button
            variant="outlined"
            color="error"
            onClick={onDeleteLoadedSavedFilter}
            disabled={saveInFlight || loadedSavedFilter == null}
            fullWidth
          >
            Видалити
          </Button>
        </Stack>
        {loadedSavedFilter ? (
          <Typography variant="caption" color={isDirty ? 'warning.main' : 'text.secondary'}>
            {savedFilterName.trim() !== loadedSavedFilter.name
              ? 'Назва відрізняється від вибраного фільтра. Можна перейменувати окремо.'
              : isDirty
                ? 'Є незбережені зміни відносно вибраного фільтра.'
                : 'Поточний стан збігається із вибраним фільтром.'}
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );
}
