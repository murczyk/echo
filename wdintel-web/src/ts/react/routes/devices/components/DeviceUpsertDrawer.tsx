import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import type { DeviceLookupOption } from '../helpers';
import {
  validateDeviceUpsertForm,
  DEVICE_HOSTNAME_MAX_CHARS,
  DEVICE_SSH_PORT_MAX,
  DEVICE_SSH_PORT_MIN,
  type DeviceTagDraftError,
  type DeviceFileDraftError,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from '../device-form';
import { DeviceTagsEditor } from './DeviceTagsEditor';
import { DeviceFileRowsEditor } from './DeviceFileRowsEditor';

const EMPTY_TAG_ROW_ERRORS: Record<string, DeviceTagDraftError> = {};
const EMPTY_FILE_ROW_ERRORS: Record<string, DeviceFileDraftError> = {};

type Props = {
  open: boolean;
  mode: 'create' | 'edit';
  form: DeviceUpsertForm | null;
  saving: boolean;
  error: string | null;
  serverFieldErrors: DeviceServerFieldErrors;
  referenceLoading: boolean;
  aorOptions: DeviceLookupOption[];
  unitOptions: DeviceLookupOption[];
  hasChanges?: boolean;
  onClose: () => void;
  onChange: (form: DeviceUpsertForm | null) => void;
  onSave: (form: DeviceUpsertForm) => void;
};

type TouchedField = 'name' | 'externalUrl' | 'hostname' | 'sshPort';

function selectedLookupOptions(options: DeviceLookupOption[], ids: number[]): DeviceLookupOption[] {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  return ids.map((id) => optionsById.get(id) ?? { id, label: `#${id}` });
}

function selectedLookupOption(
  options: DeviceLookupOption[],
  id: number | null,
): DeviceLookupOption | null {
  if (id === null) return null;
  return options.find((option) => option.id === id) ?? { id, label: `#${id}` };
}

export function DeviceUpsertDrawer({
  open,
  mode,
  form,
  saving,
  error,
  serverFieldErrors,
  referenceLoading,
  aorOptions,
  unitOptions,
  hasChanges = true,
  onClose,
  onChange,
  onSave,
}: Props) {
  const titleId = 'device-upsert-drawer-title';
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<TouchedField, true>>>({});
  const validation = useMemo(() => validateDeviceUpsertForm(form), [form]);
  const formBlocked = saving || referenceLoading;
  const saveLabel = mode === 'create' ? 'Створити' : 'Зберегти';
  const drawerTitle = mode === 'create' ? 'Створити пристрій' : 'Редагувати пристрій';
  const canTrySave = form !== null && !formBlocked && (mode === 'create' || hasChanges);

  useEffect(() => {
    setSubmitted(false);
    setTouched({});
  }, [mode, open]);

  const selectedAors = useMemo(
    () => selectedLookupOptions(aorOptions, form?.aorIds ?? []),
    [aorOptions, form?.aorIds],
  );
  const selectedUnit = useMemo(
    () => selectedLookupOption(unitOptions, form?.unitId ?? null),
    [unitOptions, form?.unitId],
  );

  const patchForm = (patch: Partial<DeviceUpsertForm>) => {
    if (form === null) return;
    onChange({ ...form, ...patch });
  };

  const showFieldError = (field: TouchedField) => submitted || touched[field] === true;
  const fieldError = (field: TouchedField): string | undefined => {
    const local = validation?.[field];
    if (showFieldError(field) && local !== undefined) return local;
    return serverFieldErrors[field];
  };

  const handleAorChange = (_event: SyntheticEvent, next: DeviceLookupOption[]) => {
    patchForm({ aorIds: next.map((option) => option.id) });
  };

  const handleUnitChange = (_event: SyntheticEvent, next: DeviceLookupOption | null) => {
    patchForm({ unitId: next?.id ?? null });
  };

  const handleSave = () => {
    if (form === null || formBlocked) return;
    setSubmitted(true);
    setTouched({ name: true, externalUrl: true, hostname: true, sshPort: true });
    if (validation !== null) return;
    onSave(form);
  };

  const showCollectionErrors = submitted && validation !== null;
  const tagRows = showCollectionErrors
    ? (validation?.tagRows ?? EMPTY_TAG_ROW_ERRORS)
    : EMPTY_TAG_ROW_ERRORS;
  const fileRows = showCollectionErrors
    ? (validation?.fileRows ?? EMPTY_FILE_ROW_ERRORS)
    : EMPTY_FILE_ROW_ERRORS;
  const noEditChanges = mode === 'edit' && form !== null && !hasChanges;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      ModalProps={{ BackdropProps: { sx: (theme) => pageDrawerBackdropSx(theme) } }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 760 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography variant="h6" id={titleId}>
            {drawerTitle}
          </Typography>
          <Tooltip title="Закрити">
            <span>
              <IconButton
                size="small"
                onClick={onClose}
                disabled={saving}
                aria-label="Закрити форму"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {referenceLoading ? (
            <PowerAlert severity="info">Завантажуємо довідники…</PowerAlert>
          ) : null}
          {noEditChanges ? (
            <PowerAlert severity="info">Немає змін для збереження.</PowerAlert>
          ) : null}
          {serverFieldErrors.aorIds ? (
            <PowerAlert severity="error">{serverFieldErrors.aorIds}</PowerAlert>
          ) : null}
          {serverFieldErrors.unitId ? (
            <PowerAlert severity="error">{serverFieldErrors.unitId}</PowerAlert>
          ) : null}

          {form ? (
            <>
              <TextField
                label="Назва"
                value={form.name}
                onChange={(event) => patchForm({ name: event.target.value })}
                onBlur={() => setTouched((current) => ({ ...current, name: true }))}
                disabled={formBlocked}
                fullWidth
                size="small"
                required
                error={fieldError('name') !== undefined}
                helperText={fieldError('name')}
              />

              <Autocomplete<DeviceLookupOption, true, false, false>
                multiple
                disableCloseOnSelect
                filterSelectedOptions
                fullWidth
                size="small"
                options={aorOptions}
                value={selectedAors}
                loading={referenceLoading}
                disabled={formBlocked}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={handleAorChange}
                renderInput={(params) => (
                  <TextField {...params} label="Смуги" placeholder="Смуга" />
                )}
              />

              <Autocomplete<DeviceLookupOption, false, false, false>
                fullWidth
                size="small"
                options={unitOptions}
                value={selectedUnit}
                loading={referenceLoading}
                disabled={formBlocked}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={handleUnitChange}
                renderInput={(params) => (
                  <TextField {...params} label="Підрозділ" placeholder="Без підрозділу" />
                )}
              />

              <TextField
                label="Зовнішнє посилання"
                value={form.externalUrl}
                onChange={(event) => patchForm({ externalUrl: event.target.value })}
                onBlur={() => setTouched((current) => ({ ...current, externalUrl: true }))}
                disabled={formBlocked}
                fullWidth
                size="small"
                error={fieldError('externalUrl') !== undefined}
                helperText={fieldError('externalUrl') ?? 'HTTP/HTTPS URL або порожнє значення.'}
              />

              <TextField
                label="Хостнейм"
                value={form.hostname}
                onChange={(event) => patchForm({ hostname: event.target.value })}
                onBlur={() => setTouched((current) => ({ ...current, hostname: true }))}
                disabled={formBlocked}
                fullWidth
                size="small"
                inputProps={{ maxLength: DEVICE_HOSTNAME_MAX_CHARS }}
                error={fieldError('hostname') !== undefined}
                helperText={fieldError('hostname') ?? 'Необов’язковий, до 255 символів.'}
              />

              <TextField
                label="SSH-порт"
                type="number"
                value={form.sshPort}
                onChange={(event) => patchForm({ sshPort: event.target.value })}
                onBlur={() => setTouched((current) => ({ ...current, sshPort: true }))}
                disabled={formBlocked}
                fullWidth
                size="small"
                inputProps={{
                  min: DEVICE_SSH_PORT_MIN,
                  max: DEVICE_SSH_PORT_MAX,
                  step: 1,
                }}
                error={fieldError('sshPort') !== undefined}
                helperText={
                  fieldError('sshPort') ??
                  `Ціле число від ${DEVICE_SSH_PORT_MIN} до ${DEVICE_SSH_PORT_MAX} або порожнє значення.`
                }
              />

              <Divider />
              {showCollectionErrors && validation?.tags ? (
                <PowerAlert severity="error">{validation.tags}</PowerAlert>
              ) : null}
              {serverFieldErrors.tags ? (
                <PowerAlert severity="error">{serverFieldErrors.tags}</PowerAlert>
              ) : null}
              <DeviceTagsEditor
                rows={form.tags}
                errors={tagRows}
                disabled={formBlocked}
                onChange={(tags) => patchForm({ tags })}
              />

              <Divider />
              {showCollectionErrors && validation?.files ? (
                <PowerAlert severity="error">{validation.files}</PowerAlert>
              ) : null}
              {serverFieldErrors.files ? (
                <PowerAlert severity="error">{serverFieldErrors.files}</PowerAlert>
              ) : null}
              <DeviceFileRowsEditor
                rows={form.files}
                errors={fileRows}
                disabled={formBlocked}
                title={mode === 'create' ? 'Файли для створення разом із пристроєм' : 'Нові файли'}
                emptyText={
                  mode === 'create'
                    ? 'Можна створити пристрій без файлів.'
                    : 'Існуючі файли не редагуються тут; можна додати тільки нові метадані.'
                }
                onChange={(files) => patchForm({ files })}
              />
            </>
          ) : null}
        </Stack>
      </Box>

      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button onClick={onClose} disabled={saving}>
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!canTrySave}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
          >
            {saving ? 'Збереження…' : saveLabel}
          </Button>
        </Stack>
      </Box>
    </Drawer>
  );
}
