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
import { memo } from 'react';

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
  formatKeyLabel,
}: Props) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Typography variant="subtitle2">Ключі</Typography>
        {canManageKeys ? (
          <Button size="small" startIcon={<AddIcon />} onClick={onAddNewKey} disabled={saving || networkId === null}>
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
              renderInput={(params) => (
                <TextField {...params} placeholder="Пошук і вибір ключів" />
              )}
            />
            <Typography variant="caption" color="text.secondary">
              Можна додати кілька ключів до однієї частоти.
            </Typography>
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
