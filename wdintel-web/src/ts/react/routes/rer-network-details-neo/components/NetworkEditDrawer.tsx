import {
  Autocomplete,
  Box,
  Button,
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
import { memo, useMemo, type SyntheticEvent } from 'react';

import type { NetworkStatus } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import type { NetworkEditForm } from '../use-rer-network-details-neo-page.shared';
import { NEO_AUTOCOMPLETE_SLOT_PROPS, NEO_SELECT_MENU_PROPS } from './dropdownProps';
import type { NetworkEditLookupOption as LookupOption } from './network-edit-autocomplete';
import { networkEditLookupFilterOptions } from './network-edit-autocomplete';

type Props = {
  open: boolean;
  form: NetworkEditForm | null;
  saving: boolean;
  error: string | null;
  referenceLoading: boolean;
  aorOptions: LookupOption[];
  unitOptions: LookupOption[];
  postOptions: LookupOption[];
  onClose: () => void;
  onChange: (next: NetworkEditForm | null) => void;
  onSave: () => void;
};

function buildSelectedOptions(options: LookupOption[], selectedIds: number[]): LookupOption[] {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  return selectedIds.map((id) => optionsById.get(id) ?? { id, label: `#${id}` });
}

function NetworkEditDrawerComponent({
  open,
  form,
  saving,
  error,
  referenceLoading,
  aorOptions,
  unitOptions,
  postOptions,
  onClose,
  onChange,
  onSave,
}: Props) {
  const titleId = 'network-edit-drawer-title';
  const formBlocked = saving || referenceLoading;

  const selectedAors = useMemo(() => (form ? buildSelectedOptions(aorOptions, form.aorIds) : []), [aorOptions, form]);
  const selectedUnits = useMemo(() => (form ? buildSelectedOptions(unitOptions, form.unitIds) : []), [form, unitOptions]);
  const selectedPosts = useMemo(() => (form ? buildSelectedOptions(postOptions, form.postIds) : []), [form, postOptions]);

  const handleAutocompleteChange = (key: 'aorIds' | 'unitIds' | 'postIds') => (_event: SyntheticEvent, next: LookupOption[]) => {
    if (!form) return;
    onChange({ ...form, [key]: next.map((option) => option.id) });
  };

  const handleStatusChange = (value: string) => {
    if (!form) return;
    onChange({ ...form, status: value as NetworkStatus });
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 680 },
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
          Редагувати мережу
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {referenceLoading ? <PowerAlert severity="info">Завантажуємо довідники…</PowerAlert> : null}

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
                loadingText="Завантаження..."
                noOptionsText={referenceLoading ? 'Завантаження...' : 'Немає варіантів'}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={handleAutocompleteChange('aorIds')}
                filterOptions={networkEditLookupFilterOptions}
                slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                renderInput={(params) => <TextField {...params} label="Смуги" size="small" />}
              />

              <TextField
                label="Назва"
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
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
                options={unitOptions}
                value={selectedUnits}
                loading={referenceLoading}
                disabled={formBlocked}
                loadingText="Завантаження..."
                noOptionsText={referenceLoading ? 'Завантаження...' : 'Немає варіантів'}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={handleAutocompleteChange('unitIds')}
                filterOptions={networkEditLookupFilterOptions}
                slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                renderInput={(params) => <TextField {...params} label="Підрозділи" size="small" />}
              />

              <TextField
                label="Район функціонування/розгортання"
                value={form.location}
                onChange={(event) => onChange({ ...form, location: event.target.value })}
                disabled={formBlocked}
                fullWidth
                size="small"
              />

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
                loadingText="Завантаження..."
                noOptionsText={referenceLoading ? 'Завантаження...' : 'Немає варіантів'}
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
        <Button onClick={onSave} variant="contained" disabled={formBlocked || !form}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}

export const NetworkEditDrawer = memo(NetworkEditDrawerComponent);
