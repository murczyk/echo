import React from 'react';
import { Autocomplete, Box, Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
  /** Render as a nested subsection (no own section header/divider) inside a parent wrapper. */
  embedded?: boolean;
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

export function DmrSection({ showAdvanced, busy, recentValues, embedded }: Props) {
  const {
    control,
    watch,
    formState: { errors },
  } = useFormContext<MessageFormData>();
  const { fields, append, remove } = useFieldArray({ control, name: 'dmr' });
  const metadata = watch('dmr');
  const hasMetadata = metadata.some((item) => Object.values(item).some((value) => value?.trim()));

  // Standalone usage (embedded=false) is a fallback: it shows existing DMR data
  // (e.g. when editing an imported message) while advanced fields are collapsed, so
  // the data isn't hidden from the user. Once advanced fields expand, the embedded
  // instance inside AdvancedFieldsSection takes over and this one hides to avoid a
  // duplicate "DMR метадані" block. Embedded instances are only ever mounted while
  // advanced fields are already expanded, so they always render.
  if (!embedded && (!hasMetadata || showAdvanced)) return null;

  const addButton = (
    <Button size="small" onClick={() => append({ ...EMPTY_DMR_METADATA })} disabled={busy}>
      Додати запис
    </Button>
  );

  const content =
    fields.length === 0 ? (
      <Typography variant="body2" color="text.secondary">
        Немає DMR метаданих
      </Typography>
    ) : (
      fields.map((field, index) => (
        <Box
          key={field.id}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            p: 1.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              Запис {index + 1}
            </Typography>
            <IconButton
              aria-label={`Видалити DMR запис ${index + 1}`}
              onClick={() => remove(index)}
              disabled={busy}
              size="small"
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 2,
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
          </Box>
        </Box>
      ))
    );

  if (embedded) {
    return (
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2" color="text.secondary">
            DMR метадані
          </Typography>
          {addButton}
        </Box>
        {content}
      </Stack>
    );
  }

  return (
    <FormSectionWrapper title="DMR метадані" action={addButton}>
      {content}
    </FormSectionWrapper>
  );
}
