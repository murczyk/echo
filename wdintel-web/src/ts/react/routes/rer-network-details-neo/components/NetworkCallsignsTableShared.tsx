import { Box, Chip, Stack } from '@mui/material';

import type {
  NetworkCallsignCatalogRowView,
  NetworkCallsignRowView,
  NetworkCallsignStatusFilter,
} from '../network-callsigns';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../../components/mui-customized/table/custom-styles';
import { buildDefaultColumnOrder } from '../../../components/mui-customized/table/get-default-table-options';

export const NETWORK_STATUS_FILTER_LABELS: Record<NetworkCallsignStatusFilter, string> = {
  All: 'Всі',
  Verified: 'Верифіковано',
  Developing: 'В дорозвідці',
  Catalog: 'Каталог',
  Unknown: 'Невідомо',
};

export const NETWORK_STATUS_FILTER_ORDER: NetworkCallsignStatusFilter[] = ['All', 'Verified', 'Developing', 'Catalog', 'Unknown'];

export const NETWORK_COLUMNS_VISIBILITY = {
  callsign: true,
  status: true,
  position: true,
  unitName: true,
  lastDatetime: true,
  messageCount: true,
  comment: true,
  sourceName: true,
};

export const NETWORK_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['callsign', 'status', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'sourceName'],
  withRowNumbers: true,
  withRowActions: true,
});

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

export const CATALOG_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['callsign', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'dateBoundAt', 'sourceName'],
  withRowNumbers: true,
  withRowActions: true,
});

export function formatCountLabel(value: number) {
  return value.toLocaleString('uk-UA');
}

export function CountChipLabel({ label, count, selected = false }: { label: string; count: number; selected?: boolean }) {
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
        {formatCountLabel(count)}
      </Box>
    </Stack>
  );
}

export function renderStatusChip(statusLabel: string) {
  if (statusLabel === 'Верифіковано') {
    return <Chip size="small" label={statusLabel} sx={{ height: 24, fontSize: '0.78rem', fontWeight: 700, bgcolor: 'success.main', color: 'success.contrastText', '& .MuiChip-label': { px: 0.9 } }} />;
  }

  if (statusLabel === 'В дорозвідці') {
    return <Chip size="small" label={statusLabel} sx={{ height: 24, fontSize: '0.78rem', fontWeight: 700, bgcolor: 'warning.main', color: 'warning.contrastText', '& .MuiChip-label': { px: 0.9 } }} />;
  }

  if (statusLabel === 'Каталог') {
    return <Chip size="small" label={statusLabel} sx={{ height: 24, fontSize: '0.78rem', fontWeight: 700, bgcolor: 'info.main', color: 'info.contrastText', '& .MuiChip-label': { px: 0.9 } }} />;
  }

  return <Chip size="small" variant="outlined" label={statusLabel} sx={{ height: 24, fontSize: '0.78rem', fontWeight: 700, '& .MuiChip-label': { px: 0.9 } }} />;
}

export function buildNetworkLoadingRows(): NetworkCallsignRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    callsign: '',
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
