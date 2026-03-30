import { Alert, Autocomplete, Button, Paper, Stack, TextField, Typography } from '@mui/material';

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
  const trimmedSavedFilterName = savedFilterName.trim();
  const hasLoadedFilter = loadedSavedFilter != null;
  const isRenaming = hasLoadedFilter && trimmedSavedFilterName !== '' && trimmedSavedFilterName !== loadedSavedFilter.name;
  const canUpdateExisting = !saveInFlight && hasLoadedFilter && isDirty;
  const canRenameExisting =
    !saveInFlight && hasLoadedFilter && trimmedSavedFilterName !== '' && trimmedSavedFilterName !== loadedSavedFilter.name;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">Збережені фільтри</Typography>
        <Autocomplete
          size="small"
          options={savedFilters}
          getOptionLabel={(option) => option.name}
          value={loadedSavedFilter}
          openText="Відкрити"
          closeText="Закрити"
          clearText="Очистити"
          noOptionsText="Немає варіантів"
          onChange={(_event, next) => onApplySavedFilter(next)}
          renderInput={(params) => <TextField {...params} label="Збережений фільтр" />}
        />
        <TextField
          size="small"
          label="Назва фільтра"
          value={savedFilterName}
          onChange={(event) => onSavedFilterNameChange(event.target.value)}
        />
        {loadedSavedFilter ? (
          <Alert severity={isDirty ? 'warning' : 'info'} sx={{ py: 0.5 }}>
            {isRenaming
              ? `Фільтр "${loadedSavedFilter.name}": змінено назву.`
              : isDirty
                ? `Фільтр "${loadedSavedFilter.name}": є незбережені зміни.`
                : `Фільтр "${loadedSavedFilter.name}" відкрито.`}
          </Alert>
        ) : null}
        <Stack spacing={1.25} sx={{ width: '100%' }}>
          <Button
            variant={hasLoadedFilter ? 'contained' : 'outlined'}
            onClick={onUpdateExisting}
            disabled={!canUpdateExisting}
            fullWidth
          >
            Оновити вибраний
          </Button>
          <Button variant="outlined" onClick={onRenameExisting} disabled={!canRenameExisting} fullWidth>
            Перейменувати
          </Button>
          <Button
            variant={hasLoadedFilter ? 'outlined' : 'contained'}
            onClick={onSaveAsNew}
            disabled={saveInFlight || trimmedSavedFilterName === ''}
            fullWidth
          >
            Зберегти як новий
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
            {trimmedSavedFilterName !== loadedSavedFilter.name
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
