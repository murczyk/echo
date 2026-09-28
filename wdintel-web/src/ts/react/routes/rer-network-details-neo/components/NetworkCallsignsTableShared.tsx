import { Box, Stack } from '@mui/material';
import type { MRT_ColumnOrderState, MRT_SortingState } from 'material-react-table';

import type {
  NetworkCallsignCatalogRowView,
  NetworkCallsignRowView,
  NetworkCallsignStatusFilter,
} from '../network-callsigns.types';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../../components/mui-customized/table/custom-styles';
import { buildDefaultColumnOrder } from '../../../components/mui-customized/table/get-default-table-options';
import { NO_DATA_LABEL } from '../../../utils/misc';

export const NETWORK_STATUS_FILTER_LABELS: Record<NetworkCallsignStatusFilter, string> = {
  All: 'Всі',
  Developing: 'В дорозвідці',
  Catalog: 'Каталог',
  Unknown: 'Невідомо',
};

export const NETWORK_STATUS_FILTER_ORDER: NetworkCallsignStatusFilter[] = [
  'All',
  'Developing',
  'Catalog',
  'Unknown',
];

export const NETWORK_COLUMNS_VISIBILITY = {
  callsign: true,
  fullName: true,
  position: true,
  unitName: true,
  lastDatetime: true,
  messageCount: true,
  comment: true,
  sourceName: true,
};

export const NETWORK_CALLSIGN_COLUMN_SIZES = {
  callsign: 170,
  fullName: 200,
  position: 150,
  unitName: 220,
  lastDatetime: 150,
  messageCount: 100,
  comment: 240,
  sourceName: 150,
} as const;

export const CATALOG_COLUMNS_VISIBILITY = {
  callsign: true,
  position: true,
  unitName: true,
  lastDatetime: true,
  messageCount: true,
  comment: true,
  dateBoundAt: true,
  sourceName: true,
};

export const NETWORK_CALLSIGN_SOURCE_COLUMN_SIZE = 150;

export const NETWORK_CALLSIGN_SORTABLE_COLUMN_IDS = new Set([
  'callsign',
  'position',
  'unitName',
  'lastDatetime',
  'messageCount',
  'dateBoundAt',
  'sourceName',
]);

const UK_COLLATOR = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

type CallsignSortableRow = {
  callsign: string;
  position: string;
  unitName: string;
  lastDatetime: number | null;
  messageCount: number;
  sourceName: string;
  dateBoundAt?: number | null;
};

function compareText(left: string, right: string): number {
  return UK_COLLATOR.compare(left, right);
}

function compareNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}

export function compareCallsignRowsBySorting(
  left: CallsignSortableRow,
  right: CallsignSortableRow,
  sorting: { id: string; desc: boolean },
): number {
  let result = 0;

  switch (sorting.id) {
    case 'callsign':
      result = compareText(left.callsign, right.callsign);
      break;
    case 'position':
      result = compareText(left.position, right.position);
      break;
    case 'unitName':
      result = compareText(left.unitName, right.unitName);
      break;
    case 'lastDatetime':
      result = compareNullableNumber(left.lastDatetime, right.lastDatetime);
      break;
    case 'messageCount':
      result = left.messageCount - right.messageCount;
      break;
    case 'dateBoundAt':
      result = compareNullableNumber(left.dateBoundAt, right.dateBoundAt);
      break;
    case 'sourceName':
      result = compareText(left.sourceName, right.sourceName);
      break;
    default:
      result = compareText(left.callsign, right.callsign);
      break;
  }

  return sorting.desc ? -result : result;
}

export function getPrimaryCallsignSortingItem(
  sorting: MRT_SortingState,
): { id: string; desc: boolean } | null {
  const primary = sorting.find((item) => NETWORK_CALLSIGN_SORTABLE_COLUMN_IDS.has(item.id));
  return primary ?? null;
}

export function formatCountLabel(value: number) {
  return value.toLocaleString('uk-UA');
}

export function buildNetworkColumnOrder({
  dataColumnIds,
}: {
  dataColumnIds: string[];
}): MRT_ColumnOrderState {
  return buildDefaultColumnOrder({
    dataColumnIds,
    withRowNumbers: true,
    withRowActions: true,
  });
}

export function CountChipLabel({
  label,
  count,
  totalCount,
  selected = false,
}: {
  label: string;
  count: number | null;
  totalCount?: number | null;
  selected?: boolean;
}) {
  const countLabel =
    count === null
      ? NO_DATA_LABEL
      : totalCount === null || totalCount === undefined
        ? formatCountLabel(count)
        : `${formatCountLabel(count)}/${formatCountLabel(totalCount)}`;
  return (
    <Stack direction="row" spacing={0.4} alignItems="center" sx={{ lineHeight: 1 }}>
      <Box component="span" sx={{ lineHeight: 1 }}>
        {label}
      </Box>
      <Box
        component="span"
        sx={(theme) => ({
          fontSize: '0.84rem',
          fontWeight: selected ? 700 : 600,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: 0,
          color: 'inherit',
          opacity: selected ? 0.95 : theme.palette.mode === 'dark' ? 0.92 : 0.88,
          transform: 'translateY(-0.04em)',
        })}
      >
        {countLabel}
      </Box>
    </Stack>
  );
}

export function buildNetworkLoadingRows(): NetworkCallsignRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    callsign: '',
    fullName: '',
    status: 'unknown',
    statusLabel: '',
    position: '',
    unitId: null,
    unitName: '',
    lastDatetime: null,
    messageCount: 0,
    comment: '',
    sourceName: '',
    knownCallsignId: null,
    active: true,
    developing: false,
    mainRadioStation: false,
    unitDeveloping: false,
    sourceId: null,
    radioFreq: null,
    networkId: 0,
    commandControl: false,
  }));
}

export function buildCatalogLoadingRows(): NetworkCallsignCatalogRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    knownCallsignId: -(index + 1),
    callsign: '',
    position: '',
    unitName: '',
    lastDatetime: null,
    messageCount: 0,
    comment: '',
    dateBoundAt: 0,
    sourceName: '',
    networkCallsign: '',
    freqs: null,
  }));
}
