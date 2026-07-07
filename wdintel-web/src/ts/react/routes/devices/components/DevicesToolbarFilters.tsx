import {
  Autocomplete,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';

import type { DeviceDeletedFilterValue, DeviceLookupOption, DevicesFilterState } from '../helpers';

type Props = {
  filters: DevicesFilterState;
  aorOptions: DeviceLookupOption[];
  unitOptions: DeviceLookupOption[];
  disabled?: boolean;
  onDeletedFilterChange: (value: DeviceDeletedFilterValue) => void;
  onAorIdsChange: (value: number[]) => void;
  onUnitIdsChange: (value: number[]) => void;
  onCreatedByChange: (value: string) => void;
};

function selectedOptions(options: DeviceLookupOption[], ids: number[]) {
  const selected = new Set(ids);
  return options.filter((option) => selected.has(option.id));
}

export function DevicesToolbarFilters({
  filters,
  aorOptions,
  unitOptions,
  disabled = false,
  onDeletedFilterChange,
  onAorIdsChange,
  onUnitIdsChange,
  onCreatedByChange,
}: Props) {
  return (
    <Stack
      direction={{ xs: 'column', lg: 'row' }}
      spacing={1.5}
      useFlexGap
      sx={{ minWidth: 0, alignItems: { xs: 'stretch', lg: 'center' } }}
    >
      <Stack spacing={0.75} sx={{ minWidth: 210 }}>
        <Typography variant="caption" color="text.secondary">
          Стан
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={filters.deletedFilter}
          disabled={disabled}
          onChange={(_, value: DeviceDeletedFilterValue | null) => {
            if (value !== null) onDeletedFilterChange(value);
          }}
          aria-label="Фільтр стану пристроїв"
        >
          <ToggleButton value="active">Активні</ToggleButton>
          <ToggleButton value="deleted">Видалені</ToggleButton>
          <ToggleButton value="all">Всі</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Autocomplete
        multiple
        size="small"
        options={aorOptions}
        value={selectedOptions(aorOptions, filters.aorIds)}
        disabled={disabled}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        onChange={(_, value) => onAorIdsChange(value.map((option) => option.id))}
        sx={{ minWidth: { xs: '100%', lg: 240 } }}
        renderInput={(params) => <TextField {...params} label="Райони" placeholder="AOR" />}
      />

      <Autocomplete
        multiple
        size="small"
        options={unitOptions}
        value={selectedOptions(unitOptions, filters.unitIds)}
        disabled={disabled}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        onChange={(_, value) => onUnitIdsChange(value.map((option) => option.id))}
        sx={{ minWidth: { xs: '100%', lg: 260 } }}
        renderInput={(params) => (
          <TextField {...params} label="Підрозділи" placeholder="Підрозділ" />
        )}
      />

      <TextField
        size="small"
        label="Створив"
        value={filters.createdBy}
        disabled={disabled}
        onChange={(event) => onCreatedByChange(event.target.value)}
        sx={{ minWidth: { xs: '100%', lg: 180 } }}
      />
    </Stack>
  );
}
