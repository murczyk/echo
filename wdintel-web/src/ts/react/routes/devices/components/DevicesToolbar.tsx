import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { MRT_TableInstance } from 'material-react-table';
import type { Dispatch, SetStateAction } from 'react';

import { GlobalFilterTextField } from '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import type { ActiveFilterDescriptor } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions/components/active-filters-utils';
import type { DeviceArchivedFilterValue, DevicesFilterState } from '../helpers';

type Props = {
  loading: boolean;
  globalFilter: string;
  onChangeGlobalFilter: (value: string | ((prev: string) => string)) => void;
  filters: Pick<DevicesFilterState, 'archivedFilter'>;
  setFilters: Dispatch<SetStateAction<DevicesFilterState>>;
  additionalActiveFilters: ActiveFilterDescriptor[];
  onClearAdditionalActiveFilter: (filterId: string) => void;
  onClearAdditionalActiveFilters: () => void;
  table: MRT_TableInstance<any>;
};

function setStatus(
  setFilters: Dispatch<SetStateAction<DevicesFilterState>>,
  archivedFilter: DeviceArchivedFilterValue,
) {
  setFilters((current) => ({ ...current, archivedFilter }));
}

export function DevicesToolbar({
  loading,
  globalFilter,
  onChangeGlobalFilter,
  filters,
  setFilters,
  additionalActiveFilters,
  onClearAdditionalActiveFilter,
  onClearAdditionalActiveFilters,
  table,
}: Props) {
  return (
    <div className="flex min-w-0 flex-col gap-echo-md echo-lg:flex-row echo-lg:flex-wrap echo-lg:items-center">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-echo-md">
        <div className="w-full min-w-56 max-w-[360px] flex-1">
          <GlobalFilterTextField
            className="!min-w-0 !w-full"
            globalFilter={globalFilter}
            setGlobalFilter={onChangeGlobalFilter}
            disabled={loading}
          />
        </div>
        <ToggleButtonGroup
          exclusive
          size="small"
          color="primary"
          value={filters.archivedFilter}
          aria-label="Стан пристроїв"
          onChange={(_, value: DeviceArchivedFilterValue | null) => {
            if (value !== null) setStatus(setFilters, value);
          }}
          sx={{
            flexShrink: 0,
            borderRadius: 1,
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              px: 1.75,
              py: 0.875,
              fontSize: '0.875rem',
              fontWeight: 600,
              lineHeight: 1.25,
              borderRadius: 0,
            },
            '& .MuiToggleButtonGroup-firstButton': {
              borderTopLeftRadius: 8,
              borderBottomLeftRadius: 8,
            },
            '& .MuiToggleButtonGroup-lastButton': {
              borderTopRightRadius: 8,
              borderBottomRightRadius: 8,
            },
          }}
        >
          <ToggleButton value="all">Усі</ToggleButton>
          <ToggleButton value="active">Активні</ToggleButton>
          <ToggleButton value="archived">Архів</ToggleButton>
        </ToggleButtonGroup>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-echo-sm echo-lg:ml-auto">
        <InternalTableActions
          table={table}
          columnsVisibilityDisabled={loading}
          filtersDisabled={loading}
          additionalActiveFilters={additionalActiveFilters}
          onClearAdditionalActiveFilter={onClearAdditionalActiveFilter}
          onClearAdditionalActiveFilters={onClearAdditionalActiveFilters}
          rowNumberAppearanceControl
          fullScreenEnabled={false}
          fullScreenDisabled={loading}
        />
      </div>
    </div>
  );
}
