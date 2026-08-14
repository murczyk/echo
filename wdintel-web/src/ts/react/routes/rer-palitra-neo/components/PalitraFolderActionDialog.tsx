import { useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Autocomplete,
  Box,
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

import { formatFolderActionPreviewLines, validateFolderPath } from '../helpers';
import type { FolderActionDialogState, FolderActionKind } from '../types';
import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  state: FolderActionDialogState | null;
  folderOptions: string[];
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onNextFolderPathChange: (value: string) => void;
  disableRestoreFocus?: boolean;
};

const FOLDER_ACTION_DIALOG_TITLES: Record<FolderActionKind, string> = {
  assign: 'Перемістити палітри в папку',
  rename: 'Перейменувати папку',
  archive: 'Архівувати всі палітри в папці',
  delete: 'Видалити всі палітри в папці',
};

const FOLDER_ACTION_CONFIRM_LABELS: Record<FolderActionKind, string> = {
  assign: 'Перемістити',
  rename: 'Зберегти',
  archive: 'Архівувати',
  delete: 'Видалити',
};

const FOLDER_ACTION_CONFIRM_COLORS: Record<FolderActionKind, 'primary' | 'warning' | 'error'> = {
  assign: 'primary',
  rename: 'primary',
  archive: 'warning',
  delete: 'error',
};

function getDialogTitle(state: FolderActionDialogState): string {
  return FOLDER_ACTION_DIALOG_TITLES[state.kind];
}

function getConfirmLabel(state: FolderActionDialogState): string {
  return FOLDER_ACTION_CONFIRM_LABELS[state.kind];
}

function sanitizeFolderInput(value: string): string {
  // Flat UI only: replace slash so users cannot type nested folder paths here.
  return value.replaceAll('/', ' ');
}

function getDescription(state: FolderActionDialogState): string {
  const descriptions: Record<FolderActionKind, string> = {
    assign: 'Створіть нову папку або оберіть з існуючих.',
    rename: 'Введіть нову назву папки.',
    archive: 'В архів буде перенесено всі доступні палітри в цій папці.',
    delete: 'Буде видалено всі доступні палітри в цій папці.',
  };
  return descriptions[state.kind];
}

export function PalitraFolderActionDialog({
  state,
  folderOptions,
  submitting,
  onClose,
  onConfirm,
  onNextFolderPathChange,
  disableRestoreFocus = false,
}: Props) {
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    setNameTouched(false);
  }, [state]);

  const normalizedFolderOptions = useMemo(
    () => [...folderOptions].sort((left, right) => left.localeCompare(right, 'uk')),
    [folderOptions],
  );
  const assignFolderOptions = useMemo(
    // Assign flow supports only flat folder names; slash-based legacy paths are intentionally
    // excluded here because validateFolderPath forbids '/' for new/target folder values.
    () => normalizedFolderOptions.filter((path) => !path.includes('/')),
    [normalizedFolderOptions],
  );
  const assignFolderOptionSet = useMemo(() => new Set(assignFolderOptions), [assignFolderOptions]);

  if (!state) return null;

  const nextFolderPathError =
    state.kind === 'assign' || state.kind === 'rename'
      ? validateFolderPath(state.nextFolderPath)
      : null;
  const showNameError = nameTouched && Boolean(nextFolderPathError);
  const previewLines = formatFolderActionPreviewLines(state);
  const hasFolderOptions = assignFolderOptions.length > 0;
  const assignMetaLines =
    state.kind === 'assign'
      ? previewLines.filter((line) => !line.startsWith('Обрано палітр:'))
      : previewLines;

  return (
    <Dialog
      open
      onClose={submitting ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      disableRestoreFocus={disableRestoreFocus}
    >
      <DialogTitle>{getDialogTitle(state)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <DialogContentText>{getDescription(state)}</DialogContentText>

          {state.kind === 'assign' ? (
            <Stack spacing={1.75}>
              <Autocomplete
                freeSolo
                selectOnFocus
                clearOnBlur={false}
                handleHomeEndKeys
                autoHighlight
                options={assignFolderOptions}
                value={null}
                inputValue={state.nextFolderPath}
                onInputChange={(_event, value, reason) => {
                  if (reason === 'reset' && assignFolderOptionSet.has(value)) {
                    onNextFolderPathChange(value);
                    return;
                  }
                  onNextFolderPathChange(sanitizeFolderInput(value));
                }}
                onChange={(_event, value) => {
                  const nextValue = typeof value === 'string' ? value : (value ?? '');
                  onNextFolderPathChange(
                    assignFolderOptionSet.has(nextValue)
                      ? nextValue
                      : sanitizeFolderInput(nextValue),
                  );
                  setNameTouched(true);
                }}
                noOptionsText="Немає збігів. Буде створено нову папку з цією назвою."
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Папка"
                    onBlur={() => setNameTouched(true)}
                    error={showNameError}
                    helperText={
                      showNameError
                        ? nextFolderPathError
                        : hasFolderOptions
                          ? 'Введіть назву або оберіть зі списку'
                          : 'Введіть назву папки'
                    }
                    autoFocus
                    slotProps={{
                      htmlInput: {
                        ...params.inputProps,
                        autoComplete: 'new-password',
                      },
                    }}
                    sx={{
                      '& .MuiInputBase-root': {
                        minHeight: 56,
                      },
                      '& .MuiInputLabel-root': {
                        transform: 'translate(14px, 16px) scale(1)',
                      },
                      '& .MuiInputLabel-shrink': {
                        transform: 'translate(14px, -9px) scale(0.75)',
                      },
                      '& .MuiInputBase-input': {
                        paddingTop: 16.5,
                        paddingBottom: 16.5,
                      },
                      '& input:-webkit-autofill, & input:-webkit-autofill:hover, & input:-webkit-autofill:focus':
                        {
                          WebkitTextFillColor: 'var(--bs-body-color)',
                          WebkitBoxShadow: '0 0 0 100px var(--bs-body-bg) inset',
                          transition: 'background-color 9999s ease-out 0s',
                          caretColor: 'var(--bs-body-color)',
                        },
                    }}
                  />
                )}
              />
            </Stack>
          ) : null}

          {state.kind === 'rename' ? (
            <TextField
              label="Нова назва папки"
              value={state.nextFolderPath}
              onChange={(event) => onNextFolderPathChange(sanitizeFolderInput(event.target.value))}
              onBlur={() => setNameTouched(true)}
              error={showNameError}
              helperText={
                showNameError ? nextFolderPathError : 'Поточна назва: ' + state.folderPath
              }
              autoFocus
            />
          ) : null}

          {state.kind === 'assign' && state.targetPalitraNames.length > 0 ? (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                Обрані палітри: {state.preview.requestedCount}
              </Typography>
              <Box
                sx={{
                  maxHeight: 200,
                  overflowY: 'auto',
                  border: (theme) => '1px solid ' + theme.palette.divider,
                  borderRadius: 1,
                  px: 1.5,
                  py: 1,
                }}
              >
                <Stack spacing={0.75}>
                  {state.targetPalitraNames.map((name, index) => (
                    <Typography key={name + '-' + String(index)} variant="body2">
                      {name}
                    </Typography>
                  ))}
                </Stack>
              </Box>
            </Stack>
          ) : null}

          <Stack spacing={1}>
            {assignMetaLines.map((line) => (
              <Typography key={line} variant="body2">
                {line}
              </Typography>
            ))}
          </Stack>

          {state.kind !== 'assign' ? (
            <PowerAlert severity="info">
              Дія застосовується до всіх доступних палітр у цій папці, включаючи архівні.
            </PowerAlert>
          ) : null}

          {state.kind === 'delete' ? (
            <PowerAlert severity="error">
              Ця дія видалить палітри, що зараз лежать у папці.
            </PowerAlert>
          ) : null}

          {state.kind === 'assign' && state.preview.unchangedCount > 0 ? (
            <PowerAlert severity="info">Частина вибраних палітр уже лежить у цій папці.</PowerAlert>
          ) : null}

          {state.preview.modifiableCount === 0 ? (
            <PowerAlert severity="warning">Немає доступних палітр для цієї дії.</PowerAlert>
          ) : null}

          {state.preview.skippedCount > 0 ? (
            <PowerAlert severity="warning">
              Частина палітр недоступна для зміни й буде пропущена.
            </PowerAlert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
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
          variant="contained"
          color={FOLDER_ACTION_CONFIRM_COLORS[state.kind]}
          disabled={
            submitting || Boolean(nextFolderPathError) || state.preview.modifiableCount === 0
          }
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {getConfirmLabel(state)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
