import React from 'react';
import { Autocomplete, Box, Button, IconButton, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
};

type DmrFieldName =
  'cc' | 'sender_id' | 'sender_name' | 'call_group_id' | 'call_group_name' | 'hash_id';

const EMPTY_DMR_METADATA: MessageFormData['dmr'][number] = {
  cc: '',
  sender_id: '',
  sender_name: '',
  call_group_id: '',
  call_group_name: '',
  hash_id: '',
};

const DMR_FIELDS: Array<{
  name: DmrFieldName;
  label: string;
  recentKey: string;
  type?: 'number';
}> = [
  { name: 'cc', label: 'Колірний код (CC)', recentKey: 'network_cc', type: 'number' },
  { name: 'sender_id', label: 'ID відправника', recentKey: 'dmr_sender_id' },
  { name: 'sender_name', label: "Ім'я відправника", recentKey: 'dmr_sender_name' },
  { name: 'call_group_id', label: 'ID групи виклику', recentKey: 'dmr_call_group_id' },
  {
    name: 'call_group_name',
    label: "Ім'я групи виклику",
    recentKey: 'dmr_call_group_name',
  },
  { name: 'hash_id', label: 'Hash ID', recentKey: 'dmr_hash_id' },
];

export function DmrSection({ showAdvanced, busy, recentValues }: Props) {
  const {
    control,
    watch,
    formState: { errors },
  } = useFormContext<MessageFormData>();
  const { fields, append, remove } = useFieldArray({ control, name: 'dmr' });
  const metadata = watch('dmr');
  const hasMetadata = metadata.some((item) => Object.values(item).some((value) => value?.trim()));

  if (!showAdvanced && !hasMetadata) return null;

  return (
    <FormSectionWrapper
      title="DMR метадані"
      action={
        <Button size="small" onClick={() => append({ ...EMPTY_DMR_METADATA })} disabled={busy}>
          Додати запис
        </Button>
      }
    >
      {fields.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Немає DMR метаданих
        </Typography>
      ) : (
        fields.map((field, index) => (
          <Box
            key={field.id}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 2,
              p: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              position: 'relative',
            }}
          >
            {DMR_FIELDS.map((definition) => (
              <Controller
                key={definition.name}
                name={`dmr.${index}.${definition.name}` as const}
                control={control}
                render={({ field: input }) => (
                  <Autocomplete
                    freeSolo
                    forcePopupIcon
                    options={recentValues?.[definition.recentKey] || []}
                    value={input.value ?? ''}
                    disabled={busy}
                    onInputChange={(_, value, reason) => {
                      if (reason === 'input') input.onChange(value);
                    }}
                    onChange={(_, value) => input.onChange(value || '')}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={definition.label}
                        size="small"
                        type={definition.type}
                        fullWidth
                        error={Boolean(errors.dmr?.[index]?.[definition.name])}
                        helperText={errors.dmr?.[index]?.[definition.name]?.message}
                        disabled={busy}
                      />
                    )}
                  />
                )}
              />
            ))}
            <IconButton
              aria-label={`Видалити DMR запис ${index + 1}`}
              onClick={() => remove(index)}
              disabled={busy}
              size="small"
              sx={{ position: 'absolute', top: 4, right: 4 }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Box>
        ))
      )}
    </FormSectionWrapper>
  );
}
