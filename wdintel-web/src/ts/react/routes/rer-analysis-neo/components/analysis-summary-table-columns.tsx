import EditIcon from '@mui/icons-material/Edit';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import MapIcon from '@mui/icons-material/Map';
import { Box, Typography } from '@mui/material';
import { MRT_ColumnDef, type MRT_SortingState } from 'material-react-table';

import { CUSTOM_STYLES } from '../../../components/mui-customized/table/custom-styles';
import { buildDefaultColumnOrder } from '../../../components/mui-customized/table/get-default-table-options';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';
import { CallsignChipsCell, CompactListCell } from './analysis-summary-table-cells';

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_VISIBILITY = {
  rowActions: true,
  freq: true,
  count: true,
  coordinateLabels: true,
  callsignSearchText: true,
  unitSearchText: true,
  locationSearchText: true,
};

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: [
    'rowActions',
    'freq',
    'count',
    'coordinateLabels',
    'callsignSearchText',
    'unitSearchText',
    'locationSearchText',
  ],
  withRowNumbers: true,
});

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_SORTING = [
  { id: 'count', desc: true },
] satisfies MRT_SortingState;

const rowActionsDisplayColumnDef = CUSTOM_STYLES.displayColumnDefOptions[
  'mrt-row-actions'
] as Partial<MRT_ColumnDef<AnalysisSummaryTableRowView>>;

export function buildAnalysisSummaryTableColumns({
  onRenameUnit,
  onSelectFreq,
  onShowFreqOnMap,
}: {
  onRenameUnit: (row: AnalysisSummaryTableRowView) => void;
  onSelectFreq: (freq: string) => void;
  onShowFreqOnMap: (freq: string) => void;
}): MRT_ColumnDef<AnalysisSummaryTableRowView>[] {
  return [
    {
      ...rowActionsDisplayColumnDef,
      header: 'Дії',
      id: 'rowActions',
      size: 48,
      minSize: 48,
      maxSize: 48,
      enableResizing: false,
      grow: false,
      enableColumnActions: false,
      enableHiding: false,
      enableSorting: false,
      Cell: ({ row }) => (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <MrtRowActions>
            <MrtRowActionButton
              label="У фільтр"
              onClick={() => onSelectFreq(row.original.freq)}
              icon={<FilterAltIcon fontSize="small" />}
            />
            <MrtRowActionButton
              label="На мапі"
              onClick={() => onShowFreqOnMap(row.original.freq)}
              icon={<MapIcon fontSize="small" />}
            />
            <MrtRowActionButton
              label="Редагувати підрозділ"
              onClick={() => onRenameUnit(row.original)}
              disabled={row.original.editableUnits.length === 0}
              icon={<EditIcon fontSize="small" />}
              opensModal
            />
          </MrtRowActions>
        </Box>
      ),
    },
    {
      header: 'Частота',
      accessorKey: 'freq',
      id: 'freq',
      size: 128,
      grow: false,
      enableSorting: true,
      Cell: ({ row }) => (
        <Typography
          variant="body2"
          noWrap
          sx={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {row.original.freq}
        </Typography>
      ),
    },
    {
      header: 'К-сть',
      accessorKey: 'count',
      id: 'count',
      size: 72,
      grow: false,
      enableSorting: true,
      muiTableHeadCellProps: { align: 'right' },
      muiTableBodyCellProps: { align: 'right' },
    },
    {
      header: 'Координати',
      accessorFn: (row) => row.coordinateLabels.join(' '),
      id: 'coordinateLabels',
      size: 144,
      Cell: ({ row }) => <CompactListCell items={row.original.coordinateLabels} maxVisible={2} />,
    },
    {
      header: 'Позивні',
      accessorFn: (row) => row.callsignChips.map((entry) => entry.callsign).join(' '),
      id: 'callsignSearchText',
      size: 248,
      Cell: ({ row }) => <CallsignChipsCell callsigns={row.original.callsignChips} />,
    },
    {
      header: 'Підрозділи',
      accessorFn: (row) => row.unitLabels.join(' '),
      id: 'unitSearchText',
      size: 224,
      Cell: ({ row }) => <CompactListCell items={row.original.unitLabels} maxVisible={2} />,
    },
    {
      header: 'Локації',
      accessorFn: (row) => row.locationLabels.join(' '),
      id: 'locationSearchText',
      size: 208,
      Cell: ({ row }) => <CompactListCell items={row.original.locationLabels} maxVisible={2} />,
    },
  ];
}
