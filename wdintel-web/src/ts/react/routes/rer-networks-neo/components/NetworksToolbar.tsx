import { Box, Stack } from '@mui/material';
import type { MRT_TableInstance } from 'material-react-table';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { GlobalFilterTextField } from '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { PowerChip } from '../../../components/PowerChip';
import type { NetworksFilterState } from '../helpers';

function StatusChipLabel({
  color,
  label,
  counter,
}: {
  color: string;
  label: string;
  counter: ReactNode;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ minWidth: 0 }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        useFlexGap
        sx={{ minWidth: 0, whiteSpace: 'nowrap' }}
      >
        <Box component="span" sx={{ minWidth: 0 }}>
          {label}
        </Box>
        <Box component="span" sx={{ minWidth: 0, color: 'text.primary', fontWeight: 700 }}>
          {counter}
        </Box>
      </Stack>
    </Stack>
  );
}

type Props = {
  loading: boolean;
  globalFilter: string;
  onChangeGlobalFilter: (value: string | ((prev: string) => string)) => void;
  filters: Pick<NetworksFilterState, 'status' | 'unitText' | 'showOnlyInvestigating'>;
  setFilters: Dispatch<SetStateAction<NetworksFilterState>>;
  statusCounts: { active: number; inactive: number; archived: number } | null;
  additionalActiveFilters: Array<{
    id: string;
    label: string;
    value: string;
    valuePreview: string;
    isGlobalFilter: boolean;
  }>;
  onClearAdditionalActiveFilter: (filterId: string) => void;
  onClearAdditionalActiveFilters: () => void;
  table: MRT_TableInstance<any>;
};

export function NetworksToolbar({
  loading,
  globalFilter,
  onChangeGlobalFilter,
  filters,
  setFilters,
  statusCounts,
  additionalActiveFilters,
  onClearAdditionalActiveFilter,
  onClearAdditionalActiveFilters,
  table,
}: Props) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minWidth: 0,
        flexWrap: 'wrap',
      }}
    >
      <GlobalFilterTextField
        globalFilter={globalFilter}
        setGlobalFilter={onChangeGlobalFilter}
        disabled={loading}
      />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
        <PowerChip
          selected={filters.status === 'all'}
          onClick={() => setFilters((current) => ({ ...current, status: 'all' }))}
          label="Всі"
          interactive
          fontWeight={700}
        />
        <PowerChip
          selected={filters.status === 'active'}
          onClick={() => setFilters((current) => ({ ...current, status: 'active' }))}
          label={
            <StatusChipLabel
              color="#54c06c"
              label="Активні"
              counter={statusCounts?.active ?? '—'}
            />
          }
          interactive
          fontWeight={700}
        />
        <PowerChip
          selected={filters.status === 'inactive'}
          onClick={() => setFilters((current) => ({ ...current, status: 'inactive' }))}
          label={
            <StatusChipLabel
              color="#bfbfbf"
              label="Неактивні"
              counter={statusCounts?.inactive ?? '—'}
            />
          }
          interactive
          fontWeight={700}
        />
        <PowerChip
          selected={filters.status === 'deleted'}
          onClick={() => setFilters((current) => ({ ...current, status: 'deleted' }))}
          label={
            <StatusChipLabel
              color="#6b6b6b"
              label="Архівні"
              counter={statusCounts?.archived ?? '—'}
            />
          }
          interactive
          fontWeight={700}
        />
      </Stack>
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center' }}>
        <InternalTableActions
          table={table}
          columnsVisibilityDisabled={loading}
          filtersDisabled={loading}
          additionalActiveFilters={additionalActiveFilters}
          onClearAdditionalActiveFilter={onClearAdditionalActiveFilter}
          onClearAdditionalActiveFilters={onClearAdditionalActiveFilters}
          fullScreenEnabled={false}
          fullScreenDisabled={loading}
        />
      </Box>
    </Box>
  );
}
