import { Box } from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useMemo } from 'react';

import { getSharedFilterTextFieldProps } from '../../../components/mui-customized/table/get-default-table-options';
import { NO_AOR_FILTER_VALUE, type NetworkRowView } from '../helpers';
import { AorCell, ActivityBars, FrequencyCell, LastActivityCell, LocationCell, NetworkCell } from './NetworkCells';

function formatAorActiveFilterValue(value: unknown, aorOptions: Array<{ id: number; name: string }>): string {
  if (!Array.isArray(value)) {
    return 'Порожньо';
  }

  const labels = value
    .map((item) => {
      const raw = String(item).trim();
      if (raw === '') {
        return '';
      }

      if (raw === NO_AOR_FILTER_VALUE) {
        return '—';
      }

      const aorId = Number.parseInt(raw, 10);
      if (!Number.isFinite(aorId)) {
        return raw;
      }

      return aorOptions.find((aor) => aor.id === aorId)?.name ?? `#${aorId}`;
    })
    .filter((label) => label !== '');

  return labels.length === 0 ? 'Порожньо' : labels.join(', ');
}

type Props = {
  aorFilterOptions: Array<{ label: string; value: string }>;
  aorOptions: Array<{ id: number; name: string }>;
  onFrequencyHoverEnter: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onFrequencyHoverLeave: () => void;
  onLocationHoverEnter: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onLocationHoverLeave: () => void;
};

export function useNetworksTableColumns({
  aorFilterOptions,
  aorOptions,
  onFrequencyHoverEnter,
  onFrequencyHoverLeave,
  onLocationHoverEnter,
  onLocationHoverLeave,
}: Props): MRT_ColumnDef<NetworkRowView>[] {
  return useMemo(
    () => [
      {
        id: 'network',
        header: 'Мережа',
        accessorFn: (row) => row.network.name,
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => <NetworkCell network={row.original} />,
      },
      {
        id: 'aors',
        header: 'Смуги',
        accessorFn: (row) => (row.network.aorIds.length === 0 ? [NO_AOR_FILTER_VALUE] : row.network.aorIds.map(String)),
        enableColumnFilter: true,
        enableSorting: true,
        meta: {
          activeFilterValueFormatter: (value: unknown) => formatAorActiveFilterValue(value, aorOptions),
        },
        Cell: ({ row }) => <AorCell labels={row.original.aorLabels} />,
        filterVariant: 'multi-select',
        filterSelectOptions: aorFilterOptions,
        filterFn: 'arrIncludesSome',
        muiFilterTextFieldProps: () => {
          const shared = getSharedFilterTextFieldProps('multi-select');
          const selectSlotProps = (shared.slotProps?.select ?? {}) as any;
          return {
            ...shared,
            slotProps: {
              ...shared.slotProps,
              select: {
                ...selectSlotProps,
                MenuProps: {
                  ...(selectSlotProps.MenuProps ?? {}),
                  PaperProps: {
                    ...(selectSlotProps.MenuProps?.PaperProps ?? {}),
                    sx: {
                      maxHeight: 320,
                      '& .MuiMenuItem-root': {
                        minHeight: 32,
                        py: 0.25,
                      },
                      '& .MuiCheckbox-root': {
                        p: 0.25,
                        mr: 0.5,
                        transform: 'scale(0.85)',
                      },
                    },
                  },
                },
              },
            },
          };
        },
      },
      {
        id: 'freqs',
        header: 'Частоти',
        accessorFn: (row) => row.activeFrequencies.map((freq) => freq.freq).join(' ') + row.inactiveFrequencies.map((freq) => freq.freq).join(' '),
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => (
          <FrequencyCell row={row.original} onPointerEnterAnchor={onFrequencyHoverEnter} onPointerLeaveAnchor={onFrequencyHoverLeave} />
        ),
      },
      {
        id: 'location',
        header: 'Район',
        accessorFn: (row) => row.network.location,
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => <LocationCell row={row.original} onPointerEnterAnchor={onLocationHoverEnter} onPointerLeaveAnchor={onLocationHoverLeave} />,
      },
      {
        id: 'activity',
        header: 'Активність',
        accessorFn: (row) => row.activityBars.reduce((sum, item) => sum + item.value, 0),
        enableColumnFilter: false,
        enableSorting: true,
        Cell: ({ row }) => (
          <Box>
            {row.original.activityBars.some((bar) => bar.value > 0) ? <ActivityBars bars={row.original.activityBars} /> : <Box sx={{ color: 'text.secondary' }}>Не активна останні 10 днів</Box>}
          </Box>
        ),
      },
      {
        id: 'lastActivity',
        header: 'Остання активність',
        accessorFn: (row) => row.lastActivityLabel,
        enableColumnFilter: false,
        enableSorting: true,
        Cell: ({ row }) => <LastActivityCell label={row.original.lastActivityLabel} detail={row.original.lastActivityDetail} tooltip={row.original.lastActivityTooltip} />,
      },
    ],
    [aorFilterOptions, aorOptions, onFrequencyHoverEnter, onFrequencyHoverLeave, onLocationHoverEnter, onLocationHoverLeave],
  );
}
