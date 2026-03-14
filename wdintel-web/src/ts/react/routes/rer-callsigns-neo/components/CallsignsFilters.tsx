import { Stack, Switch, TextField, Typography } from '@mui/material';

import { GlobalFilterTextField } from '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import type { CallsignsFilterState } from '../types';

type SharedProps = {
  filters: CallsignsFilterState;
  filtersDisabled?: boolean;
  onFiltersChange: (updater: (prev: CallsignsFilterState) => CallsignsFilterState) => void;
};

type Props = SharedProps & {
  isDesktopLayout: boolean;
};

export function CallsignsFiltersTopRow({
  filters,
  filtersDisabled = false,
  onFiltersChange,
}: SharedProps) {
  const globalFilter = filters.filterText;

  const globalFilterField = (
    <GlobalFilterTextField
      className="!w-full sm:!w-[320px] sm:!max-w-full"
      globalFilter={globalFilter}
      disabled={filtersDisabled}
      setGlobalFilter={(value) => onFiltersChange((prev) => ({ ...prev, filterText: value }))}
    />
  );

  const dateToggle = (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ width: 'fit-content', pr: 1 }}
    >
      <Switch
        checked={!filters.isIgnoringDateFilter}
        onChange={(event) => onFiltersChange((prev) => ({ ...prev, isIgnoringDateFilter: !event.target.checked }))}
        disabled={filtersDisabled}
        inputProps={{ 'aria-label': 'Фільтр за датою' }}
      />
      <Typography
        component="button"
        type="button"
        onClick={() =>
          onFiltersChange((prev) => ({
            ...prev,
            isIgnoringDateFilter: !prev.isIgnoringDateFilter,
          }))
        }
        disabled={filtersDisabled}
        sx={{
          whiteSpace: 'nowrap',
          background: 'none',
          border: 0,
          p: 0,
          m: 0,
          color: 'inherit',
          font: 'inherit',
          cursor: filtersDisabled ? 'default' : 'pointer',
        }}
      >
        Фільтр за датою
      </Typography>
    </Stack>
  );

  return (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
      {globalFilterField}
      {dateToggle}
    </Stack>
  );
}

export function CallsignsDateInputs({
  filters,
  filtersDisabled = false,
  onFiltersChange,
}: Props) {
  if (filters.isIgnoringDateFilter) return null;

  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      useFlexGap
      sx={{ minWidth: 0, flexWrap: 'nowrap' }}
    >
      <TextField
        label="Від"
        type="datetime-local"
        size="small"
        value={filters.fromDateTimeLocal}
        onChange={(event) => onFiltersChange((prev) => ({ ...prev, fromDateTimeLocal: event.target.value }))}
        disabled={filtersDisabled}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <TextField
        label="До"
        type="datetime-local"
        size="small"
        value={filters.toDateTimeLocal}
        onChange={(event) => onFiltersChange((prev) => ({ ...prev, toDateTimeLocal: event.target.value }))}
        disabled={filtersDisabled}
        slotProps={{ inputLabel: { shrink: true } }}
      />
    </Stack>
  );
}

export function CallsignsFilters({
  isDesktopLayout,
  filters,
  filtersDisabled = false,
  onFiltersChange,
}: Props) {
  return (
    <Stack
      direction="column"
      spacing={1.5}
      alignItems="stretch"
      useFlexGap
      sx={{ flex: '1 1 auto', minWidth: 0 }}
    >
      <CallsignsFiltersTopRow
        filters={filters}
        filtersDisabled={filtersDisabled}
        onFiltersChange={onFiltersChange}
      />
      <CallsignsDateInputs
        isDesktopLayout={isDesktopLayout}
        filters={filters}
        filtersDisabled={filtersDisabled}
        onFiltersChange={onFiltersChange}
      />
    </Stack>
  );
}
