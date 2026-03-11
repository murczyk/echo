import {
  FormControlLabel,
  Stack,
  Switch,
  TextField,
} from '@mui/material';

import { GlobalFilterTextField } from '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import type { CallsignsFilterState } from '../types';

type Props = {
  filters: CallsignsFilterState;
  filtersDisabled?: boolean;
  onFiltersChange: (updater: (prev: CallsignsFilterState) => CallsignsFilterState) => void;
};

export function CallsignsFilters({
  filters,
  filtersDisabled = false,
  onFiltersChange,
}: Props) {
  const globalFilter = filters.filterText;

  const globalFilterField = (
    <GlobalFilterTextField
      className="!w-full sm:!w-[320px] sm:!max-w-full"
      globalFilter={globalFilter}
      disabled={filtersDisabled}
      setGlobalFilter={(value) => onFiltersChange((prev) => ({ ...prev, filterText: value }))}
    />
  );

  const dateControls = (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} useFlexGap>
      <FormControlLabel
        control={
          <Switch
            checked={!filters.isIgnoringDateFilter}
            onChange={(event) => onFiltersChange((prev) => ({ ...prev, isIgnoringDateFilter: !event.target.checked }))}
            disabled={filtersDisabled}
          />
        }
        label="Фільтр за датою"
        sx={{
          ml: 0,
          mr: 0,
        }}
      />
      {!filters.isIgnoringDateFilter ? (
        <>
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
        </>
      ) : null}
    </Stack>
  );

  return (
    <Stack direction={{ xs: 'column', xl: 'row' }} spacing={1.5} alignItems={{ xl: 'center' }} useFlexGap sx={{ flex: '1 1 auto', minWidth: 0 }}>
      {globalFilterField}
      {dateControls}
    </Stack>
  );
}
