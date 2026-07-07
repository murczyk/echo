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
  type DeviceCustomFieldDraftError,
  type DeviceFileDraftError,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from '../device-form';
import { DeviceCustomFieldsEditor } from './DeviceCustomFieldsEditor';
import { DeviceFileRowsEditor } from './DeviceFileRowsEditor';

const EMPTY_CUSTOM_FIELD_ROW_ERRORS: Record<string, DeviceCustomFieldDraftError> = {};
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

type TouchedField = 'name' | 'externalUrl';

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
    const local = field === 'name' ? validation?.name : validation?.externalUrl;
    if (showFieldError(field) && local !== undefined) return local;
    return field === 'name' ? serverFieldErrors.name : serverFieldErrors.externalUrl;
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
    setTouched({ name: true, externalUrl: true });
    if (validation !== null) return;
    onSave(form);
  };

  const showCollectionErrors = submitted && validation !== null;
  const customFieldRows = showCollectionErrors
    ? (validation?.customFieldRows ?? EMPTY_CUSTOM_FIELD_ROW_ERRORS)
    : EMPTY_CUSTOM_FIELD_ROW_ERRORS;
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

              <Divider />
              {showCollectionErrors && validation?.customFields ? (
                <PowerAlert severity="error">{validation.customFields}</PowerAlert>
              ) : null}
              {serverFieldErrors.customFields ? (
                <PowerAlert severity="error">{serverFieldErrors.customFields}</PowerAlert>
              ) : null}
              <DeviceCustomFieldsEditor
                rows={form.customFields}
                errors={customFieldRows}
                disabled={formBlocked}
                onChange={(customFields) => patchForm({ customFields })}
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
