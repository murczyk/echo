import { Box, Button, Stack, Typography } from '@mui/material';
import { useMemo } from 'react';

import type { NetworkCallsign, Source } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import {
  CountChipLabel,
  NETWORK_STATUS_FILTER_LABELS,
  NETWORK_STATUS_FILTER_ORDER,
} from './NetworkCallsignsTableShared';
import type {
  NetworkCallsignCatalogGroupView,
  NetworkCallsignInterceptedView,
  NetworkCallsignRowView,
  NetworkCallsignSectionMode,
  NetworkCallsignStatusFilter,
} from '../network-callsigns';
import { buildNetworkCallsignRowViews, flattenCatalogCallsignRows } from '../network-callsigns';
import { NetworkCallsignsCatalogTable } from './NetworkCallsignsCatalogTable';
import { NetworkCallsignsInterceptedPanel } from './NetworkCallsignsInterceptedPanel';
import { NetworkCallsignsNetworkTable } from './NetworkCallsignsNetworkTable';

export type Props = {
  sources: Source[];
  networkCallsigns: NetworkCallsign[];
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
  loading: boolean;
  loadingError: string | null;
  canManage: boolean;
  sectionMode: NetworkCallsignSectionMode;
  onSectionModeChange: (next: NetworkCallsignSectionMode) => void;
  statusFilter: NetworkCallsignStatusFilter;
  onStatusFilterChange: (next: NetworkCallsignStatusFilter) => void;
  interceptedExpanded: boolean;
  onToggleInterceptedExpanded: () => void;
  onOpenCreateDrawer: () => void;
  onOpenEditDrawer: (row: NetworkCallsignRowView) => void;
  onOpenDeleteDialog: (row: NetworkCallsignRowView) => void;
  onToggleMainRadioStation: (row: NetworkCallsignRowView) => void;
  onAddKnownCallsign: (knownCallsignId: number) => void;
  onAddInterceptedToDeveloping: (callsign: string) => void;
  onAddInterceptedToNetwork: (callsign: string) => void;
  onReload: () => void;
  inFlightCreateCallsigns: string[];
  inFlightAddIds: number[];
  inFlightUpdateIds: number[];
  inFlightDeleteIds: number[];
};

export function NetworkDetailsCallsignsPanel({
  sources,
  networkCallsigns,
  catalogCallsignGroups,
  unknownInterceptedCallsigns,
  loading,
  loadingError,
  canManage,
  sectionMode,
  onSectionModeChange,
  statusFilter,
  onStatusFilterChange,
  interceptedExpanded,
  onToggleInterceptedExpanded,
  onOpenCreateDrawer,
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onToggleMainRadioStation,
  onAddKnownCallsign,
  onAddInterceptedToDeveloping,
  onAddInterceptedToNetwork,
  onReload,
  inFlightCreateCallsigns,
  inFlightAddIds,
  inFlightUpdateIds,
  inFlightDeleteIds,
}: Props) {
  const sectionCounts = useMemo(() => ({
    network: networkCallsigns.length,
    catalog: flattenCatalogCallsignRows(catalogCallsignGroups).length,
    intercepted: unknownInterceptedCallsigns.length,
  }), [catalogCallsignGroups, networkCallsigns.length, unknownInterceptedCallsigns.length]);

  const networkRows = useMemo(
    () => buildNetworkCallsignRowViews(networkCallsigns, new Map(sources.map((source) => [source.id, source] as const))),
    [networkCallsigns, sources],
  );
  const catalogRows = useMemo(() => flattenCatalogCallsignRows(catalogCallsignGroups), [catalogCallsignGroups]);
  const interceptedShouldFillAvailableHeight = interceptedExpanded && unknownInterceptedCallsigns.length > 8;
  const contentAreaFlex = sectionMode === 'intercepted' ? (interceptedShouldFillAvailableHeight ? 1 : '0 0 auto') : 1;

  const tabNav = (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
      <Typography variant="body1" color="text.secondary">
        Перейти:
      </Typography>
      <PowerChip
        label={<CountChipLabel label="Позивні мережі" count={sectionCounts.network} selected={sectionMode === 'network'} />}
        selected={sectionMode === 'network'}
        onClick={() => onSectionModeChange('network')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.9}
        labelPaddingY={0.1}
        sx={{ height: 30 }}
      />
      <PowerChip
        label={<CountChipLabel label="Каталог" count={sectionCounts.catalog} selected={sectionMode === 'catalog'} />}
        selected={sectionMode === 'catalog'}
        onClick={() => onSectionModeChange('catalog')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.9}
        labelPaddingY={0.1}
        sx={{ height: 30 }}
      />
      <PowerChip
        label={<CountChipLabel label="Перехоплення" count={sectionCounts.intercepted} selected={sectionMode === 'intercepted'} />}
        selected={sectionMode === 'intercepted'}
        onClick={() => onSectionModeChange('intercepted')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.9}
        labelPaddingY={0.1}
        sx={{ height: 30 }}
      />
    </Stack>
  );

  const content = sectionMode === 'network' ? (
    <NetworkCallsignsNetworkTable
      rows={networkRows}
      loading={loading}
      loadingError={loadingError}
      canManage={canManage}
      statusFilter={statusFilter}
      onStatusFilterChange={onStatusFilterChange}
      onOpenEditDrawer={onOpenEditDrawer}
      onOpenDeleteDialog={onOpenDeleteDialog}
      onToggleMainRadioStation={onToggleMainRadioStation}
      onReload={onReload}
      inFlightUpdateIds={inFlightUpdateIds}
      inFlightDeleteIds={inFlightDeleteIds}
    />
  ) : sectionMode === 'catalog' ? (
    <NetworkCallsignsCatalogTable
      rows={catalogRows}
      loading={loading}
      loadingError={loadingError}
      canManage={canManage}
      onAddKnownCallsign={onAddKnownCallsign}
      onReload={onReload}
      inFlightAddIds={inFlightAddIds}
    />
  ) : (
    <Stack spacing={2} sx={{ minHeight: 0, flex: sectionMode === 'intercepted' ? (interceptedShouldFillAvailableHeight ? 1 : '0 0 auto') : 1 }}>
      {loadingError && unknownInterceptedCallsigns.length > 0 ? <PowerAlert severity="error">{loadingError}</PowerAlert> : null}
      <NetworkCallsignsInterceptedPanel
        rows={unknownInterceptedCallsigns}
        canManage={canManage}
        expanded={interceptedExpanded}
        loading={loading}
        mutationBusy={inFlightCreateCallsigns.length > 0}
        onToggleExpanded={onToggleInterceptedExpanded}
        onAddToDeveloping={onAddInterceptedToDeveloping}
        onAddToNetwork={onAddInterceptedToNetwork}
        inFlightCreateCallsigns={inFlightCreateCallsigns}
      />
    </Stack>
  );

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: sectionMode === 'intercepted' ? (interceptedShouldFillAvailableHeight ? 1 : '0 0 auto') : 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Stack spacing={2} sx={{ minHeight: 0, flex: contentAreaFlex }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ gap: 2, flexWrap: 'wrap' }}>
          {tabNav}
          {canManage && sectionMode === 'network' ? (
            <Button variant="contained" onClick={onOpenCreateDrawer} disabled={loading}>
              Додати
            </Button>
          ) : null}
        </Stack>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="h6">
            {sectionMode === 'network'
              ? 'Позивні мережі'
              : sectionMode === 'catalog'
                ? 'Співпадіння з каталогом'
                : 'Присутні в перехопленнях'}
          </Typography>
        </Box>
        {loadingError && networkCallsigns.length === 0 && catalogCallsignGroups.length === 0 && unknownInterceptedCallsigns.length === 0 ? (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <PowerAlert severity="error">{loadingError}</PowerAlert>
            <Button size="small" onClick={onReload}>
              Спробувати ще раз
            </Button>
          </Stack>
        ) : null}
        <Box sx={{ flex: contentAreaFlex, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {content}
        </Box>
      </Stack>
    </Box>
  );
}
