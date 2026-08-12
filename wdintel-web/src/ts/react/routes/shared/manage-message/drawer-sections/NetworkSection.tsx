import React from 'react';
import { Box, TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import { type MessageFormData } from '../manage-message-drawer.schema';
import { getUnitsByIds } from '../../../../services/api/units';
import type { NetworkSearchResult } from '../../../../services/api/direct-submit';

type Props = {
  isEditMode: boolean;
  busy: boolean;
  recentValues: any;
  networkNameOptions: NetworkSearchResult[];
  networkNameLoading: boolean;
  setNetworkNameInput: (val: string) => void;
  networkUnitNamesById: Record<number, string>;
  selectedNetwork: NetworkSearchResult | null;
  setSelectedNetwork: (val: NetworkSearchResult | null) => void;
  freqOptions: string[];
  freqLoading: boolean;
  setFreqInput: (val: string) => void;
  unitLocked: boolean;
  setUnitLocked: (val: boolean) => void;
};

export function NetworkSection({
  isEditMode,
  busy,
  recentValues,
  networkNameOptions,
  networkNameLoading,
  setNetworkNameInput,
  networkUnitNamesById,
  selectedNetwork,
  setSelectedNetwork,
  freqOptions,
  freqLoading,
  setFreqInput,
  unitLocked,
  setUnitLocked,
}: Props) {
  const {
    control,
    trigger,
    setValue,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <FormSectionWrapper title="Мережа та радіо">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
        <Controller
          name="freq"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              noOptionsText="Немає варіантів"
              options={Array.from(new Set([...(recentValues?.freq || []), ...freqOptions]))}
              value={field.value ?? ''}
              loading={freqLoading}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') {
                  setFreqInput(newValue);
                  field.onChange(newValue);
                }
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Частота (МГц)"
                  placeholder="напр. 149.5000"
                  size="small"
                  fullWidth
                  error={!!errors.freq}
                  helperText={errors.freq?.message}
                  disabled={busy}
                />
              )}
            />
          )}
        />

        <Controller
          name="network_name"
          control={control}
          render={({ field }) => {
            const recentNames = (recentValues?.network_name || []) as string[];
            const topOpts: NetworkSearchResult[] = [];
            const otherOpts: NetworkSearchResult[] = [];

            networkNameOptions.forEach((opt) => {
              if (!recentNames.includes(opt.name)) {
                otherOpts.push(opt);
              }
            });

            recentNames.forEach((name) => {
              const matchingReals = networkNameOptions.filter((opt) => opt.name === name);
              if (matchingReals.length > 0) {
                topOpts.push(...matchingReals);
              } else {
                topOpts.push({ id: -1, name, unit_ids: null, freqs: [] } as NetworkSearchResult);
              }
            });

            const allOpts = [
              ...(selectedNetwork ? [selectedNetwork] : []),
              ...topOpts,
              ...otherOpts,
            ];
            const uniqueOpts = Array.from(
              new Map(allOpts.map((item) => [item.id === -1 ? item.name : item.id, item])).values(),
            );
            const optionLabel = (option: string | NetworkSearchResult) => {
              if (typeof option === 'string') return option;
              const unitNames = (option.unit_ids ?? [])
                .map((unitId) => networkUnitNamesById[unitId]?.trim())
                .filter((unitName): unitName is string => Boolean(unitName));
              return [option.name, ...unitNames].filter(Boolean).join(' — ');
            };
            return (
              <Autocomplete
                freeSolo
                forcePopupIcon
                noOptionsText="Немає варіантів"
                options={uniqueOpts}
                getOptionLabel={optionLabel}
                isOptionEqualToValue={(option, value) => {
                  if (typeof option !== 'string' && typeof value !== 'string') {
                    return option.id === value.id;
                  }
                  const optionName = typeof option === 'string' ? option : option.name;
                  const valueName = typeof value === 'string' ? value : value.name;
                  return optionName === valueName;
                }}
                value={selectedNetwork ?? field.value ?? ''}
                inputValue={selectedNetwork ? optionLabel(selectedNetwork) : (field.value ?? '')}
                loading={networkNameLoading}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') {
                    setNetworkNameInput(newValue);
                    field.onChange(newValue);
                    setSelectedNetwork(null);
                    setUnitLocked(false);
                    if (newValue) {
                      setValue('network_signal_name', 'DMR', { shouldValidate: true });
                    }
                  }
                }}
                onChange={async (_, newValue) => {
                  const network = typeof newValue === 'string' ? null : newValue;
                  const name = network ? network.name : newValue || '';
                  field.onChange(name);
                  setSelectedNetwork(network);
                  if (name) {
                    setValue('network_signal_name', 'DMR', { shouldValidate: true });
                  }

                  if (network && network.unit_ids && network.unit_ids.length > 0) {
                    // Autofill and lock unit(s) from the selected network
                    try {
                      const units = await getUnitsByIds(network.unit_ids);
                      if (units.length > 0) {
                        setValue('unit', units.map((u) => u.name).join(', '), {
                          shouldValidate: true,
                        });
                        setUnitLocked(true);
                      } else {
                        setUnitLocked(false);
                      }
                    } catch (e) {
                      console.error('Failed to fetch units for network', e);
                      setUnitLocked(false);
                    }
                  } else {
                    setUnitLocked(false);
                  }
                }}
                renderInput={(params) => (
                  <TextField {...params} label="Мережа" size="small" fullWidth disabled={busy} />
                )}
              />
            );
          }}
        />
      </Box>
    </FormSectionWrapper>
  );
}
