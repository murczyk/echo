import { Typography } from '@mui/material';
import { MRT_ColumnDef, type MRT_SortingState } from 'material-react-table';

import { buildDefaultColumnOrder } from '../../../components/mui-customized/table/get-default-table-options';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';
import { CallsignChipsCell, CompactListCell } from './analysis-summary-table-cells';

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_VISIBILITY = {
  freq: true,
  count: true,
  coordinateLabels: true,
  callsignSearchText: true,
  unitSearchText: true,
  locationSearchText: true,
};

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['freq', 'count', 'coordinateLabels', 'callsignSearchText', 'unitSearchText', 'locationSearchText'],
  withRowNumbers: true,
  withRowActions: true,
});

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_SORTING = [{ id: 'count', desc: true }] satisfies MRT_SortingState;

export function buildAnalysisSummaryTableColumns(): MRT_ColumnDef<AnalysisSummaryTableRowView>[] {
  return [
    {
      header: 'Частота',
      accessorKey: 'freq',
      id: 'freq',
      size: 150,
      grow: false,
      enableSorting: true,
      Cell: ({ row }) => (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {row.original.freq}
        </Typography>
      ),
    },
    {
      header: 'К-сть',
      accessorKey: 'count',
      id: 'count',
      size: 84,
      grow: false,
      enableSorting: true,
      muiTableHeadCellProps: { align: 'right' },
      muiTableBodyCellProps: { align: 'right' },
    },
    {
      header: 'Координати',
      accessorFn: (row) => row.coordinateLabels.join(' '),
      id: 'coordinateLabels',
      size: 180,
      Cell: ({ row }) => <CompactListCell items={row.original.coordinateLabels} />,
    },
    {
      header: 'Позивні',
      accessorFn: (row) => row.callsignChips.map((entry) => entry.callsign).join(' '),
      id: 'callsignSearchText',
      size: 320,
      Cell: ({ row }) => <CallsignChipsCell callsigns={row.original.callsignChips} />,
    },
    {
      header: 'Підрозділи',
      accessorFn: (row) => row.unitLabels.join(' '),
      id: 'unitSearchText',
      size: 320,
      Cell: ({ row }) => <CompactListCell items={row.original.unitLabels} maxVisible={4} />,
    },
    {
      header: 'Локації',
      accessorFn: (row) => row.locationLabels.join(' '),
      id: 'locationSearchText',
      size: 220,
      Cell: ({ row }) => <CompactListCell items={row.original.locationLabels} />,
    },
  ];
}
