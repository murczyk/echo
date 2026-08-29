import { Box } from '@mui/material';
import { useMemo } from 'react';

import {
  type AppMrtColumnDef,
  getSharedFilterTextFieldProps,
  mrtItemsCell,
  mrtCustomCell,
} from '../../../components/mui-customized/table/get-default-table-options';
import { NO_AOR_FILTER_VALUE, type NetworkRowView } from '../helpers';
import {
  FrequencyCell,
  LastActivityCell,
  LocationCell,
  NetworkCell,
  NetworkActivityCell,
} from './NetworkCells';

function formatAorActiveFilterValue(
  value: unknown,
  aorOptions: Array<{ id: number; name: string }>,
): string {
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
}: Props): AppMrtColumnDef<NetworkRowView>[] {
  return useMemo(
    () => [
      {
        id: 'network',
        header: 'Мережа',
        accessorFn: (row) => row.network.name,
        enableColumnFilter: true,
        enableSorting: true,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => <NetworkCell network={row.original} />),
      },
      {
        id: 'aors',
        header: 'Смуги',
        accessorFn: (row) =>
          row.network.aorIds.length === 0 ? [NO_AOR_FILTER_VALUE] : row.network.aorIds.map(String),
        enableColumnFilter: true,
        enableSorting: true,
        meta: {
          overflowMode: 'items',
          activeFilterValueFormatter: (value: unknown) =>
            formatAorActiveFilterValue(value, aorOptions),
        },
        Cell: mrtItemsCell<NetworkRowView, string>({
          items: ({ row }) => row.original.aorLabels,
          renderItem: (label) => <Box component="span">{label}</Box>,
          measurementScope: 'networks:aors',
          disclosureLayout: 'list',
          getItemKey: (label) => label,
          getItemText: (label) => label,
        }),
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
        accessorFn: (row) =>
          row.activeFrequencies.map((freq) => freq.freq).join(' ') +
          row.inactiveFrequencies.map((freq) => freq.freq).join(' '),
        enableColumnFilter: true,
        enableSorting: true,
        meta: { overflowMode: 'custom', overflowOwner: 'domain-hover' },
        Cell: mrtCustomCell(({ row }) => (
          <FrequencyCell
            row={row.original}
            onPointerEnterAnchor={onFrequencyHoverEnter}
            onPointerLeaveAnchor={onFrequencyHoverLeave}
          />
        )),
      },
      {
        id: 'location',
        header: 'Район',
        accessorFn: (row) => row.network.location,
        enableColumnFilter: true,
        enableSorting: true,
        meta: { overflowMode: 'custom', overflowOwner: 'domain-hover' },
        Cell: mrtCustomCell(({ row }) => (
          <LocationCell
            row={row.original}
            onPointerEnterAnchor={onLocationHoverEnter}
            onPointerLeaveAnchor={onLocationHoverLeave}
          />
        )),
      },
      {
        id: 'activity',
        header: 'Активність',
        accessorFn: (row) => row.activityBars.reduce((sum, item) => sum + item.value, 0),
        enableColumnFilter: false,
        enableSorting: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Box>
            <NetworkActivityCell
              activityLoadState={row.original.activityLoadState}
              activityBars={row.original.activityBars}
            />
          </Box>
        ),
      },
      {
        id: 'lastActivity',
        header: 'Остання активність',
        accessorFn: (row) => row.lastActivityLabel,
        enableColumnFilter: false,
        enableSorting: true,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => (
          <LastActivityCell
            label={row.original.lastActivityLabel}
            detail={row.original.lastActivityDetail}
            tooltip={row.original.lastActivityTooltip}
          />
        )),
      },
    ],
    [
      aorFilterOptions,
      aorOptions,
      onFrequencyHoverEnter,
      onFrequencyHoverLeave,
      onLocationHoverEnter,
      onLocationHoverLeave,
    ],
  );
}
