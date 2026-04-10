import { useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { formatFolderActionPreviewLines, validateFolderPath } from '../helpers';
import type { FolderActionDialogState } from '../types';

type Props = {
  state: FolderActionDialogState | null;
  folderOptions: string[];
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onNextFolderPathChange: (value: string) => void;
};

function getDialogTitle(state: FolderActionDialogState): string {
  if (state.kind === 'assign') return 'Перемістити палітри в папку';
  if (state.kind === 'rename') return 'Перейменувати папку';
  if (state.kind === 'archive') return 'Архівувати всі палітри в папці';
  return 'Видалити всі палітри в папці';
}

function getConfirmLabel(state: FolderActionDialogState): string {
  if (state.kind === 'assign') return 'Перемістити';
  if (state.kind === 'rename') return 'Зберегти';
  if (state.kind === 'archive') return 'Архівувати';
  return 'Видалити';
}

function sanitizeFolderInput(value: string): string {
  return value.replaceAll('/', ' ');
}

function getDescription(state: FolderActionDialogState): string {
  if (state.kind === 'assign') return 'Введіть назву папки';
  if (state.kind === 'rename') return 'Введіть нову назву папки';
  if (state.kind === 'archive') return 'В архів буде перенесено всі доступні палітри в цій папці.';
  return 'Буде видалено всі доступні палітри в цій папці.';
}

export function PalitraFolderActionDialog({
  state,
  folderOptions,
  submitting,
  onClose,
  onConfirm,
  onNextFolderPathChange,
}: Props) {
  const [nameTouched, setNameTouched] = useState(false);
  const [folderAutocompleteInput, setFolderAutocompleteInput] = useState('');

  useEffect(() => {
    setNameTouched(false);
    setFolderAutocompleteInput('');
  }, [state]);

  const normalizedFolderOptions = useMemo(
    () => [...folderOptions].sort((left, right) => left.localeCompare(right, 'uk')),
    [folderOptions],
  );

  if (!state) return null;

  const nextFolderPathError =
    state.kind === 'assign' || state.kind === 'rename' ? validateFolderPath(state.nextFolderPath) : null;
  const showNameError = nameTouched && Boolean(nextFolderPathError);
  const previewLines = formatFolderActionPreviewLines(state);
  const hasFolderOptions = normalizedFolderOptions.length > 0;

  return (
    <Dialog open onClose={submitting ? undefined : onClose} fullWidth maxWidth='sm'>
      <DialogTitle>{getDialogTitle(state)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <DialogContentText>{getDescription(state)}</DialogContentText>

          {state.kind === 'assign' ? (
            <>
              <TextField
                label='Назва папки'
                value={state.nextFolderPath}
                onChange={(event) => onNextFolderPathChange(sanitizeFolderInput(event.target.value))}
                onBlur={() => setNameTouched(true)}
                error={showNameError}
                helperText={showNameError ? nextFolderPathError : undefined}
                autoFocus
              />

              {hasFolderOptions ? (
                <Stack spacing={1}>
                  <Typography variant='body2' color='text.secondary'>
                    Оберіть існуючу папку
                  </Typography>
                  <Autocomplete
                    options={normalizedFolderOptions}
                    value={null}
                    inputValue={folderAutocompleteInput}
                    onInputChange={(_event, value) => setFolderAutocompleteInput(value)}
                    onChange={(_event, value) => {
                      if (!value) return;
                      onNextFolderPathChange(value);
                      setFolderAutocompleteInput(value);
                      setNameTouched(true);
                    }}
                    renderInput={(params) => <TextField {...params} placeholder='Почніть вводити назву папки' />}
                  />
                </Stack>
              ) : null}
            </>
          ) : null}

          {state.kind === 'rename' ? (
            <TextField
              label='Нова назва папки'
              value={state.nextFolderPath}
              onChange={(event) => onNextFolderPathChange(sanitizeFolderInput(event.target.value))}
              onBlur={() => setNameTouched(true)}
              error={showNameError}
              helperText={showNameError ? nextFolderPathError : 'Поточна назва: ' + state.folderPath}
              autoFocus
            />
          ) : null}

          <Stack spacing={1}>
            {previewLines.map((line) => (
              <Typography key={line} variant='body2'>
                {line}
              </Typography>
            ))}
          </Stack>

          {state.kind === 'delete' ? (
            <Alert severity='error'>Ця дія видалить палітри, що зараз лежать у папці.</Alert>
          ) : null}

          {state.kind === 'assign' && state.preview.unchangedCount > 0 ? (
            <Alert severity='info'>Частина вибраних палітр уже лежить у цій папці.</Alert>
          ) : null}

          {state.preview.modifiableCount === 0 ? (
            <Alert severity='warning'>Немає доступних палітр для цієї дії.</Alert>
          ) : null}

          {state.preview.skippedCount > 0 ? (
            <Alert severity='warning'>Частина палітр недоступна для зміни й буде пропущена.</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          onClick={() => {
            if ((state.kind === 'assign' || state.kind === 'rename') && nextFolderPathError) {
              setNameTouched(true);
            }
            onConfirm();
          }}
          variant='contained'
          color={state.kind === 'delete' ? 'error' : state.kind === 'archive' ? 'warning' : 'primary'}
          disabled={submitting || Boolean(nextFolderPathError) || state.preview.modifiableCount === 0}
          startIcon={submitting ? <CircularProgress size={16} color='inherit' /> : null}
        >
          {getConfirmLabel(state)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
