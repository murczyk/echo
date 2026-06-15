import ExpandMoreOutlinedIcon from '@mui/icons-material/ExpandMoreOutlined';
import {
  Autocomplete,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { memo, useEffect, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';

import type { NetworkStatus } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { SearchableMultiOptionAutocomplete } from '../../../components/SearchableMultiOptionAutocomplete';
import { ELLIPSIS } from '../../../utils/misc';
import { NetworkFreqActivityPeriodControl } from './NetworkFreqActivityPeriodControl';
import { NEO_AUTOCOMPLETE_SLOT_PROPS, NEO_SELECT_MENU_PROPS } from './dropdownProps';
import type { NetworkEditLookupOption as LookupOption } from './network-edit-autocomplete';
import { networkEditLookupFilterOptions } from './network-edit-autocomplete';
import {
  getNetworkUpsertValidationError,
  type NetworkUpsertForm,
  type NetworkUpsertValidationError,
} from '../use-rer-network-details-neo-page.shared';

const LOADING_TEXT = `Завантаження${ELLIPSIS}`;
const REFERENCE_LOADING_TEXT = `Завантажуємо довідники${ELLIPSIS}`;

type Props = {
  open: boolean;
  mode: 'create' | 'edit';
  form: NetworkUpsertForm | null;
  saving: boolean;
  error: string | null;
  referenceLoading: boolean;
  aorOptions: LookupOption[];
  unitOptions: LookupOption[];
  postOptions: LookupOption[];
  modulationOptions: LookupOption[];
  onClose: () => void;
  onChange: (next: NetworkUpsertForm | null) => void;
  onSave: () => void;
  disableRestoreFocus?: boolean;
};

type UpsertField = keyof Pick<NetworkUpsertValidationError, 'name' | 'location' | 'aorIds' | 'freq' | 'modulationId' | 'activeFrom'>;

function buildSelectedOptions(options: LookupOption[], selectedIds: number[]): LookupOption[] {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  return selectedIds.map((id) => optionsById.get(id) ?? { id, label: `#${id}` });
}

function DrawerSection({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
      <ButtonBase
        onClick={onToggle}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          px: 1.75,
          py: 1.25,
          textAlign: 'left',
          bgcolor: 'background.paper',
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <ExpandMoreOutlinedIcon
          sx={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
          }}
        />
      </ButtonBase>
      {expanded ? <Box sx={{ p: 1.75 }}>{children}</Box> : null}
    </Box>
  );
}

function NetworkEditDrawerComponent({
  open,
  mode,
  form,
  saving,
  error,
  referenceLoading,
  aorOptions,
  unitOptions,
  postOptions,
  modulationOptions,
  onClose,
  onChange,
  onSave,
  disableRestoreFocus = false,
}: Props) {
  const titleId = 'network-edit-drawer-title';
  const validation = getNetworkUpsertValidationError(form, { includeFrequency: mode === 'create' });
  const formBlocked = saving || referenceLoading;
  const canSave = form !== null && !formBlocked && validation === null;
  const saveLabel = mode === 'create' ? 'Створити' : 'Зберегти';
  const drawerTitle = mode === 'create' ? 'Створити радіомережу' : 'Редагувати радіомережу';
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<UpsertField, true>>>({});
  const [operationalExpanded, setOperationalExpanded] = useState(false);
  const [technicalExpanded, setTechnicalExpanded] = useState(false);

  useEffect(() => {
    setSubmitted(false);
    setTouched({});
    setOperationalExpanded(false);
    setTechnicalExpanded(false);
  }, [mode, open]);

  const selectedAors = useMemo(() => (form ? buildSelectedOptions(aorOptions, form.aorIds) : []), [aorOptions, form]);
  const selectedPosts = useMemo(() => (form ? buildSelectedOptions(postOptions, form.postIds) : []), [form, postOptions]);
  const selectedModulation = useMemo(() => {
    if (!form || form.modulationId === null) {
      return null;
    }

    return modulationOptions.find((modulation) => modulation.id === form.modulationId) ?? null;
  }, [form, modulationOptions]);

  const showFieldError = (field: UpsertField) => submitted || touched[field] === true;
  const fieldError = (field: UpsertField): string | undefined => {
    if (!showFieldError(field)) return undefined;
    return validation?.[field] ?? undefined;
  };
  const markTouched = (field: UpsertField) => {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  };

  const handleAutocompleteChange = (key: 'aorIds' | 'postIds') => (_event: SyntheticEvent, next: LookupOption[]) => {
    if (!form) return;
    onChange({ ...form, [key]: next.map((option) => option.id) });
  };

  const handleStatusChange = (value: string) => {
    if (!form) return;
    onChange({ ...form, status: value as NetworkStatus });
  };

  const handleKindChange = (value: string) => {
    if (!form) return;
    onChange({ ...form, kind: value as NetworkUpsertForm['kind'] });
  };

  const handleModulationChange = (_event: SyntheticEvent, next: LookupOption | null) => {
    if (!form) return;
    onChange({ ...form, modulationId: next?.id ?? null });
  };

  const handleSave = () => {
    if (!form || validation !== null) {
      setSubmitted(true);
      setTouched({
        name: true,
        location: true,
        aorIds: true,
        freq: true,
        modulationId: true,
        activeFrom: true,
      });
      return;
    }

    onSave();
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      ModalProps={{
        disableRestoreFocus,
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 720 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6" id={titleId}>
          {drawerTitle}
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {referenceLoading ? <PowerAlert severity="info">{REFERENCE_LOADING_TEXT}</PowerAlert> : null}

          {form ? (
            <>
              <Autocomplete<LookupOption, true, false, false>
                multiple
                disableCloseOnSelect
                filterSelectedOptions
                fullWidth
                size="small"
                options={aorOptions}
                value={selectedAors}
                loading={referenceLoading}
                disabled={formBlocked}
                loadingText={LOADING_TEXT}
                noOptionsText={referenceLoading ? LOADING_TEXT : 'Немає варіантів'}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={handleAutocompleteChange('aorIds')}
                filterOptions={networkEditLookupFilterOptions}
                slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Смуги"
                    size="small"
                    required
                    onBlur={() => markTouched('aorIds')}
                    error={fieldError('aorIds') !== undefined}
                    helperText={fieldError('aorIds')}
                  />
                )}
              />

              <TextField
                label="Назва"
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
                onBlur={() => markTouched('name')}
                disabled={formBlocked}
                fullWidth
                size="small"
                required
                error={fieldError('name') !== undefined}
                helperText={fieldError('name')}
              />

              <SearchableMultiOptionAutocomplete
                label="Підрозділи"
                options={unitOptions}
                valueIds={form.unitIds}
                onValueIdsChange={(unitIds) => {
                  if (!form) return;
                  onChange({ ...form, unitIds });
                }}
                getOptionLabel={(option) => option.label}
                disabled={formBlocked}
                loading={referenceLoading}
                loadingText={LOADING_TEXT}
                noOptionsText={referenceLoading ? LOADING_TEXT : 'Немає варіантів'}
                slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
              />

              <TextField
                label="Район функціонування/розгортання"
                value={form.location}
                onChange={(event) => onChange({ ...form, location: event.target.value })}
                onBlur={() => markTouched('location')}
                disabled={formBlocked}
                fullWidth
                size="small"
                required
                error={fieldError('location') !== undefined}
                helperText={fieldError('location')}
              />

              <DrawerSection
                title="Оперативні параметри"
                expanded={operationalExpanded}
                onToggle={() => setOperationalExpanded((current) => !current)}
              >
                <Stack spacing={2}>
                  <TextField
                    label="Призначення"
                    value={form.purpose}
                    onChange={(event) => onChange({ ...form, purpose: event.target.value })}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                  />

                  <TextField
                    label="Режим роботи радіомережі"
                    value={form.operationMode}
                    onChange={(event) => onChange({ ...form, operationMode: event.target.value })}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                  />

                  <TextField
                    label="Характер роботи"
                    value={form.operationType}
                    onChange={(event) => onChange({ ...form, operationType: event.target.value })}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                  />

                  <TextField
                    label="Період функціонування"
                    value={form.operationPeriod}
                    onChange={(event) => onChange({ ...form, operationPeriod: event.target.value })}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                  />

                  <Autocomplete<LookupOption, true, false, false>
                    multiple
                    disableCloseOnSelect
                    filterSelectedOptions
                    fullWidth
                    size="small"
                    options={postOptions}
                    value={selectedPosts}
                    loading={referenceLoading}
                    disabled={formBlocked}
                    loadingText={LOADING_TEXT}
                    noOptionsText={referenceLoading ? LOADING_TEXT : 'Немає варіантів'}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, value) => option.id === value.id}
                    onChange={handleAutocompleteChange('postIds')}
                    filterOptions={networkEditLookupFilterOptions}
                    slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                    renderInput={(params) => <TextField {...params} label="Пости" size="small" />}
                  />

                  <TextField
                    label="Радіостанція"
                    value={form.radioStation}
                    onChange={(event) => onChange({ ...form, radioStation: event.target.value })}
                    disabled={formBlocked}
                    fullWidth
                    size="small"
                  />

                  {mode === 'edit' ? (
                    <FormControl fullWidth size="small" disabled={formBlocked}>
                      <InputLabel id="network-edit-status-label">Статус</InputLabel>
                      <Select
                        labelId="network-edit-status-label"
                        label="Статус"
                        value={form.status}
                        onChange={(event) => handleStatusChange(String(event.target.value))}
                        MenuProps={NEO_SELECT_MENU_PROPS}
                      >
                        <MenuItem value="NetworkActive">Активна</MenuItem>
                        <MenuItem value="NetworkInactive">Неактивна</MenuItem>
                      </Select>
                    </FormControl>
                  ) : null}
                </Stack>
              </DrawerSection>

              {mode === 'create' ? (
                <>
                  <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.75 }}>
                    <Stack spacing={2}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                        Перша частота *
                      </Typography>

                      <TextField
                        label="Частота"
                        value={form.freq}
                        onChange={(event) => onChange({ ...form, freq: event.target.value })}
                        onBlur={() => markTouched('freq')}
                        disabled={formBlocked}
                        fullWidth
                        size="small"
                        required
                        error={fieldError('freq') !== undefined}
                        helperText={fieldError('freq')}
                      />

                      <FormControl fullWidth size="small" disabled={formBlocked}>
                        <InputLabel id="network-upsert-kind-label">Тип</InputLabel>
                        <Select
                          labelId="network-upsert-kind-label"
                          label="Тип"
                          value={form.kind}
                          onChange={(event) => handleKindChange(String(event.target.value))}
                          MenuProps={NEO_SELECT_MENU_PROPS}
                        >
                          <MenuItem value="DMR">DMR</MenuItem>
                          <MenuItem value="DMRe">DMRe</MenuItem>
                          <MenuItem value="NFM">NFM</MenuItem>
                        </Select>
                      </FormControl>

                      <Autocomplete<LookupOption, false, false, false>
                        fullWidth
                        size="small"
                        options={modulationOptions}
                        value={selectedModulation}
                        loading={referenceLoading}
                        disabled={formBlocked}
                        loadingText={LOADING_TEXT}
                        noOptionsText={referenceLoading ? LOADING_TEXT : 'Немає варіантів'}
                        getOptionLabel={(option) => option.label}
                        isOptionEqualToValue={(option, value) => option.id === value.id}
                        onChange={handleModulationChange}
                        filterOptions={networkEditLookupFilterOptions}
                        slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Модуляція"
                            size="small"
                            required
                            onBlur={() => markTouched('modulationId')}
                            error={fieldError('modulationId') !== undefined}
                            helperText={fieldError('modulationId')}
                          />
                        )}
                      />

                      <NetworkFreqActivityPeriodControl
                        activeFrom={form.activeFrom}
                        activeTo={form.activeTo}
                        onActiveFromChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
                        onActiveToChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
                        disabled={formBlocked}
                        required
                        activeFromError={fieldError('activeFrom') !== undefined}
                        activeFromHelperText={fieldError('activeFrom')}
                      />
                    </Stack>
                  </Box>

                  <DrawerSection
                    title="Технічні дані"
                    expanded={technicalExpanded}
                    onToggle={() => setTechnicalExpanded((current) => !current)}
                  >
                    <PowerAlert severity="info">
                      Технічні дані першої частоти додаються після створення мережі.
                    </PowerAlert>
                  </DrawerSection>
                </>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Box>

      <Box
        sx={{
          p: 2.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
        }}
      >
        <Button onClick={onClose} disabled={saving}>
          Скасувати
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={!canSave}>
          {saving ? <CircularProgress size={16} color="inherit" /> : saveLabel}
        </Button>
      </Box>
    </Drawer>
  );
}

export const NetworkEditDrawer = memo(NetworkEditDrawerComponent);
export const NetworkUpsertDrawer = NetworkEditDrawer;
