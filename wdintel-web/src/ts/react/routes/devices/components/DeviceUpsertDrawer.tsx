import { DeviceAudioForwardingFields } from './DeviceAudioForwardingFields';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';
import ArchiveIcon from '@mui/icons-material/Archive';
import UnarchiveIcon from '@mui/icons-material/Unarchive';
import { DeviceStatsRebuildAction } from './DeviceStatsRebuildAction';
import { DeviceMetadataFields } from './DeviceMetadataFields';
import {
  Autocomplete,
  Box,
  CircularProgress,
  Divider,
  Drawer,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import type { DeviceLookupOption } from '../helpers';
import {
  validateDeviceUpsertForm,
  DEVICE_NAME_MAX_CHARS,
  type DeviceCustomFieldDraftError,
  type DeviceFieldPermissions,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from '../device-form';
import { DeviceCustomFieldsEditor } from './DeviceCustomFieldsEditor';
import { useDeviceMobileLayout } from '../use-device-mobile-layout';

const EMPTY_CUSTOM_FIELD_ROW_ERRORS: Record<string, DeviceCustomFieldDraftError> = {};

type Props = {
  open: boolean;
  deviceId?: string;
  archived?: boolean;
  canRebuildStats?: boolean;
  onStatsRebuilt?: () => void;
  mode: 'create' | 'edit';
  fieldPermissions: DeviceFieldPermissions;
  form: DeviceUpsertForm | null;
  saving: boolean;
  error: string | null;
  serverFieldErrors: DeviceServerFieldErrors;
  referenceLoading: boolean;
  aorOptions: DeviceLookupOption[];
  unitOptions: DeviceLookupOption[];
  hasChanges?: boolean;
  nameRequired?: boolean;
  onClose: () => void;
  onChange: (form: DeviceUpsertForm | null) => void;
  onSave: (form: DeviceUpsertForm) => void;
  onArchive?: () => void;
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
  deviceId,
  archived = false,
  canRebuildStats = false,
  onStatsRebuilt,
  mode,
  fieldPermissions,
  form,
  saving,
  error,
  serverFieldErrors,
  referenceLoading,
  aorOptions,
  unitOptions,
  hasChanges = true,
  nameRequired = true,
  onClose,
  onChange,
  onSave,
  onArchive,
}: Props) {
  const mobile = useDeviceMobileLayout();
  const titleId = 'device-upsert-drawer-title';
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<TouchedField, true>>>({});
  const validation = useMemo(
    () => validateDeviceUpsertForm(form, fieldPermissions, nameRequired),
    [fieldPermissions, form, nameRequired],
  );
  const formBlocked =
    archived || saving || (mode === 'edit' && fieldPermissions.analyticalData && referenceLoading);
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
    setTouched({ name: true, externalUrl: true });
    if (validation !== null) return;
    onSave(form);
  };

  const showCollectionErrors = submitted && validation !== null;
  const customFieldRows = showCollectionErrors
    ? (validation?.customFieldRows ?? EMPTY_CUSTOM_FIELD_ROW_ERRORS)
    : EMPTY_CUSTOM_FIELD_ROW_ERRORS;
  const noEditChanges = mode === 'edit' && !archived && form !== null && !hasChanges;

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
              <PowerIconButton
                size="small"
                onClick={onClose}
                disabled={saving}
                className={mobile ? '!size-echo-control-lg' : undefined}
                aria-label="Закрити форму"
              >
                <CloseIcon fontSize="small" />
              </PowerIconButton>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {fieldPermissions.analyticalData && referenceLoading ? (
            <PowerAlert severity="info">Завантажуємо довідники…</PowerAlert>
          ) : null}
          {archived ? (
            <PowerAlert severity="info">
              Архівований пристрій. Для редагування розархівуйте його.
            </PowerAlert>
          ) : null}
          {noEditChanges ? (
            <PowerAlert severity="info">Немає змін для збереження.</PowerAlert>
          ) : null}
          {fieldPermissions.analyticalData && serverFieldErrors.aorIds ? (
            <PowerAlert severity="error">{serverFieldErrors.aorIds}</PowerAlert>
          ) : null}
          {fieldPermissions.analyticalData && serverFieldErrors.unitId ? (
            <PowerAlert severity="error">{serverFieldErrors.unitId}</PowerAlert>
          ) : null}

          {form ? (
            <>
              {open && mode === 'edit' ? (
                <DeviceMetadataFields
                  form={form}
                  permissions={fieldPermissions}
                  disabled={formBlocked}
                  errors={{ ...serverFieldErrors, ...(submitted ? (validation ?? {}) : {}) }}
                  onChange={patchForm}
                />
              ) : null}
              {fieldPermissions.sourceData ? (
                <>
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
                </>
              ) : null}

              {fieldPermissions.sourceData && fieldPermissions.analyticalData ? <Divider /> : null}

              {open && mode === 'edit' && deviceId && fieldPermissions.analyticalData ? (
                <DeviceAudioForwardingFields
                  key={deviceId}
                  deviceId={deviceId}
                  disabled={formBlocked}
                  value={form.audioForwarding}
                  onChange={(audioForwarding) => patchForm({ audioForwarding })}
                />
              ) : null}

              {fieldPermissions.analyticalData ? (
                <>
                  <TextField
                    label="Назва"
                    required={nameRequired}
                    value={form.name}
                    onChange={(event) => patchForm({ name: event.target.value })}
                    onBlur={() => setTouched((current) => ({ ...current, name: true }))}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                    inputProps={{ maxLength: DEVICE_NAME_MAX_CHARS }}
                    error={fieldError('name') !== undefined}
                    helperText={
                      fieldError('name') ??
                      (nameRequired ? 'Обов’язкова назва пристрою.' : undefined)
                    }
                  />

                  {mode === 'edit' ? (
                    <>
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
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {open && mode === 'edit' && deviceId && canRebuildStats ? (
            <DeviceStatsRebuildAction
              key={deviceId}
              deviceId={deviceId}
              disabled={saving}
              onRebuilt={onStatsRebuilt}
            />
          ) : null}
        </Stack>
      </Box>

      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider' }}>
        <Stack direction={mobile ? 'column' : 'row'} spacing={1} justifyContent="flex-end">
          {mode === 'edit' && fieldPermissions.analyticalData && onArchive ? (
            <PowerButton
              color={archived ? 'primary' : 'error'}
              startIcon={archived ? <UnarchiveIcon /> : <ArchiveIcon />}
              onClick={onArchive}
              disabled={saving}
            >
              {archived ? 'Розархівувати' : 'Архівувати'}
            </PowerButton>
          ) : null}
          <PowerButton
            className={mobile ? '!min-h-echo-control-lg flex-1' : undefined}
            onClick={onClose}
            disabled={saving}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            className={mobile ? '!min-h-echo-control-lg flex-1' : undefined}
            onClick={handleSave}
            disabled={!canTrySave}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
          >
            {saving ? 'Збереження…' : saveLabel}
          </PowerButton>
        </Stack>
      </Box>
    </Drawer>
  );
}
