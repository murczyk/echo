import AddIcon from '@mui/icons-material/Add';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { createFilterOptions } from '@mui/material/Autocomplete';
import { memo, type Ref } from 'react';

import type { EncryptionKeyData } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { NEO_AUTOCOMPLETE_SLOT_PROPS } from './dropdownProps';

const keyAutocompleteFilterOptions = createFilterOptions<EncryptionKeyData>({
  stringify: (option) =>
    [option.description, option.key]
      .filter((value): value is string => Boolean(value && value.trim() !== ''))
      .join(' '),
  limit: 10,
});

const compactAutocompleteSx = (theme: any, hasSelectedKeys: boolean) => ({
  '& .MuiAutocomplete-root': {
    minWidth: 0,
  },
  '& .MuiOutlinedInput-root': {
    height: hasSelectedKeys ? 'auto' : 40,
    minHeight: 40,
    alignItems: 'center',
    padding: '0 46px 0 14px !important',
    fontSize: '0.875rem',
    lineHeight: 1.4,
    '&.Mui-disabled': {
      backgroundColor: theme.palette.mode === 'light' ? theme.palette.action.disabledBackground : 'transparent',
      '& .MuiOutlinedInput-notchedOutline': {
        borderColor: theme.palette.mode === 'light' ? theme.palette.grey[400] : theme.palette.action.disabled,
      },
    },
  },
  '& .MuiAutocomplete-inputRoot': {
    alignItems: 'center',
    flexWrap: 'wrap',
    rowGap: hasSelectedKeys ? 0.5 : 0,
  },
  '& .MuiAutocomplete-input': {
    minWidth: 0,
    height: 40,
    lineHeight: '20px',
    padding: '0 !important',
    margin: 0,
    boxSizing: 'border-box',
    fontSize: '0.875rem',
    fontWeight: 400,
  },
  '& .MuiAutocomplete-input::placeholder': {
    opacity: 1,
    color: theme.palette.mode === 'light' ? theme.palette.grey[700] : theme.palette.text.secondary,
    fontWeight: 400,
  },
  '& .MuiAutocomplete-tag': {
    margin: '2px 4px 2px 0',
    maxWidth: '100%',
  },
  '& .MuiAutocomplete-endAdornment': {
    top: '50%',
    right: 10,
    transform: 'translateY(-50%)',
  },
});

type Props = {
  canManageKeys: boolean;
  saving: boolean;
  networkId: number | null;
  keysLoading: boolean;
  keysError: string | null;
  keys: EncryptionKeyData[];
  selectedKeys: EncryptionKeyData[];
  onSelectedKeysChange: (_event: unknown, next: EncryptionKeyData[]) => void;
  onAddNewKey: () => void;
  addNewKeyButtonRef?: Ref<HTMLButtonElement>;
  formatKeyLabel: (key: EncryptionKeyData) => string;
};

function NetworkFreqKeysSectionComponent({
  canManageKeys,
  saving,
  networkId,
  keysLoading,
  keysError,
  keys,
  selectedKeys,
  onSelectedKeysChange,
  onAddNewKey,
  addNewKeyButtonRef,
  formatKeyLabel,
}: Props) {
  const hasSelectedKeys = selectedKeys.length > 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
          Ключі
        </Typography>
        {canManageKeys ? (
          <Button ref={addNewKeyButtonRef} size="small" startIcon={<AddIcon />} onClick={onAddNewKey} disabled={saving || networkId === null}>
            Додати новий ключ
          </Button>
        ) : null}
      </Box>

      {canManageKeys ? (
        keysLoading ? (
          <Stack spacing={1}>
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="text" width="68%" />
            <Skeleton variant="text" width="44%" />
          </Stack>
        ) : (
          <>
            <Autocomplete<EncryptionKeyData, true, false, false>
              multiple
              disableCloseOnSelect
              filterSelectedOptions
              fullWidth
              options={keys}
              value={selectedKeys}
              loading={keysLoading}
              disabled={saving || networkId === null}
              filterOptions={keyAutocompleteFilterOptions}
              getOptionLabel={formatKeyLabel}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={onSelectedKeysChange}
              noOptionsText="Немає доступних ключів"
              slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
              sx={(theme) => compactAutocompleteSx(theme, hasSelectedKeys)}
              renderInput={(params) => (
                <TextField {...params} placeholder="Пошук і вибір ключів" size="small" />
              )}
            />
          </>
        )
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, minHeight: 56, alignItems: 'center' }}>
          {selectedKeys.length > 0 ? (
            selectedKeys.map((key) => <Chip key={key.id ?? formatKeyLabel(key)} size="small" label={formatKeyLabel(key)} />)
          ) : (
            <Typography variant="body2" color="text.secondary">
              Ключі доступні лише адміністраторам
            </Typography>
          )}
        </Box>
      )}

      {keysError ? <PowerAlert severity="warning">{keysError}</PowerAlert> : null}
    </Box>
  );
}

export const NetworkFreqKeysSection = memo(NetworkFreqKeysSectionComponent);
