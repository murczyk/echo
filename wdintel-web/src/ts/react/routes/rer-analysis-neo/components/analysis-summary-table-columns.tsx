import EditIcon from '@mui/icons-material/Edit';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import MapIcon from '@mui/icons-material/Map';
import { Box } from '@mui/material';
import { type MRT_ColumnDef, type MRT_SortingState } from 'material-react-table';

import { CUSTOM_STYLES } from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  type AppMrtColumnDef,
  mrtItemsCell,
  mrtTextCell,
} from '../../../components/mui-customized/table/get-default-table-options';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { AnalysisSummaryTableRowView } from './analysis-summary-table-rows';
import { callsignOverflowRenderer, CompactListCell } from './analysis-summary-table-cells';

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
const { columns: _rowActionColumns, ...rowActionsDisplayColumnProps } = rowActionsDisplayColumnDef;

export function buildAnalysisSummaryTableColumns({
  onRenameUnit,
  onSelectFreq,
  onShowFreqOnMap,
}: {
  onRenameUnit: (row: AnalysisSummaryTableRowView) => void;
  onSelectFreq: (freq: string) => void;
  onShowFreqOnMap: (freq: string) => void;
}): AppMrtColumnDef<AnalysisSummaryTableRowView>[] {
  return [
    {
      ...rowActionsDisplayColumnProps,
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
      meta: { overflowMode: 'none' },
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
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell<AnalysisSummaryTableRowView>({
        displayValue: ({ row }) => row.original.freq,
        fullValue: ({ row }) => row.original.freq,
        displaySx: { fontWeight: 600 },
      }),
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
      meta: { overflowMode: 'items' },
      Cell: mrtItemsCell<AnalysisSummaryTableRowView, string>({
        items: ({ row }) => row.original.coordinateLabels,
        getItemText: (item) => item,
        renderItem: (item) => <Box component="span">{item}</Box>,
        measurementScope: 'analysis-summary:coordinates',
        disclosureLayout: 'list',
      }),
    },
    {
      header: 'Позивні',
      accessorFn: (row) => row.callsignChips.map((entry) => entry.callsign).join(' '),
      id: 'callsignSearchText',
      size: 248,
      meta: { overflowMode: 'items' },
      Cell: mrtItemsCell<
        AnalysisSummaryTableRowView,
        AnalysisSummaryTableRowView['callsignChips'][number]
      >({
        items: ({ row }) => row.original.callsignChips,
        ...callsignOverflowRenderer,
      }),
    },
    {
      header: 'Підрозділи',
      accessorFn: (row) => row.unitLabels.join(' '),
      id: 'unitSearchText',
      size: 224,
      meta: { overflowMode: 'items' },
      Cell: mrtItemsCell<AnalysisSummaryTableRowView, string>({
        items: ({ row }) => row.original.unitLabels,
        getItemText: (item) => item,
        renderItem: (item) => <Box component="span">{item}</Box>,
        measurementScope: 'analysis-summary:units',
        disclosureLayout: 'list',
      }),
    },
    {
      header: 'Локації',
      accessorFn: (row) => row.locationLabels.join(' '),
      id: 'locationSearchText',
      size: 208,
      meta: { overflowMode: 'items' },
      Cell: mrtItemsCell<AnalysisSummaryTableRowView, string>({
        items: ({ row }) => row.original.locationLabels,
        getItemText: (item) => item,
        renderItem: (item) => <Box component="span">{item}</Box>,
        measurementScope: 'analysis-summary:locations',
        disclosureLayout: 'list',
      }),
    },
  ];
}
