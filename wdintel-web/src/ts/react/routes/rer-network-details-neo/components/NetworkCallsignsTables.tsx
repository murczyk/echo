import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { Box, Button, IconButton, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import { useMemo, useState } from 'react';

import type { NetworkCallsign, Source } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import type {
  NetworkCallsignCatalogGroupView,
  NetworkCallsignInterceptedView,
  NetworkCallsignRowView,
  NetworkCallsignSectionMode,
  NetworkCallsignMarkerMode,
  NetworkCallsignStatusFilter,
} from '../network-callsigns';
import {
  buildNetworkCallsignRowViews,
  filterCatalogCallsignGroups,
  filterInterceptedCallsigns,
  filterNetworkCallsignRows,
  flattenCatalogCallsignRows,
  normalizeCallsignDisplay,
} from '../network-callsigns';
import { NetworkCallsignsCatalogTable } from './NetworkCallsignsCatalogTable';
import { NetworkCallsignsInterceptedPanel } from './NetworkCallsignsInterceptedPanel';
import { NetworkCallsignsNetworkTable } from './NetworkCallsignsNetworkTable';
import { formatCountLabel } from './NetworkCallsignsTableShared';

const SECTION_IDS = {
  network: 'network-callsigns-network',
  catalog: 'network-callsigns-catalog',
  intercepted: 'network-callsigns-intercepted',
} as const;

function scrollToSection(sectionId: string) {
  document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatSectionCount(count: number, totalCount: number, searchActive: boolean): string {
  if (!searchActive) return formatCountLabel(count);
  return `${formatCountLabel(count)}/${formatCountLabel(totalCount)}`;
}

const NETWORK_SECTION_TABLE_HEIGHT = {
  xs: 500,
  md: 'min(600px, 64vh)',
} as const;

const CATALOG_SECTION_TABLE_HEIGHT = {
  xs: 520,
  md: 'min(620px, 70vh)',
} as const;

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
  onSetMarkerMode: (row: NetworkCallsignRowView, markerMode: NetworkCallsignMarkerMode) => void;
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
  onSetMarkerMode,
  onAddKnownCallsign,
  onAddInterceptedToDeveloping,
  onAddInterceptedToNetwork,
  onReload,
  inFlightCreateCallsigns,
  inFlightAddIds,
  inFlightUpdateIds,
  inFlightDeleteIds,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const networkRows = useMemo(
    () => buildNetworkCallsignRowViews(networkCallsigns, new Map(sources.map((source) => [source.id, source] as const))),
    [networkCallsigns, sources],
  );
  const catalogRows = useMemo(() => flattenCatalogCallsignRows(catalogCallsignGroups), [catalogCallsignGroups]);
  const normalizedSearchQuery = normalizeCallsignDisplay(searchQuery);
  const searchActive = normalizedSearchQuery !== '';
  const filteredNetworkRows = useMemo(() => filterNetworkCallsignRows(networkRows, searchQuery), [networkRows, searchQuery]);
  const filteredCatalogGroups = useMemo(() => filterCatalogCallsignGroups(catalogCallsignGroups, searchQuery), [catalogCallsignGroups, searchQuery]);
  const filteredCatalogRows = useMemo(() => flattenCatalogCallsignRows(filteredCatalogGroups), [filteredCatalogGroups]);
  const filteredInterceptedRows = useMemo(() => filterInterceptedCallsigns(unknownInterceptedCallsigns, searchQuery), [searchQuery, unknownInterceptedCallsigns]);
  const sectionCounts = {
    network: {
      filtered: filteredNetworkRows.length,
      total: networkRows.length,
    },
    catalog: {
      filtered: filteredCatalogRows.length,
      total: catalogRows.length,
    },
    intercepted: {
      filtered: filteredInterceptedRows.length,
      total: unknownInterceptedCallsigns.length,
    },
  } as const;

  const handleNavigateToSection = (nextSection: NetworkCallsignSectionMode) => {
    onSectionModeChange(nextSection);
    scrollToSection(SECTION_IDS[nextSection]);
  };

  const clearSearch = () => setSearchQuery('');

  return (
    <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap' }}>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0, flex: '0 1 auto' }}>
          <TextField
            label="Пошук"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            size="small"
            placeholder="Пошук"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || searchQuery === '') return;
              event.preventDefault();
              event.stopPropagation();
              clearSearch();
            }}
            InputProps={{
              endAdornment: searchQuery !== '' ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    aria-label="Очистити пошук"
                    onClick={clearSearch}
                    edge="end"
                  >
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
            sx={{ width: { xs: '100%', sm: 320, md: 360 }, flex: '0 0 auto' }}
          />
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
            <PowerChip
              label="Позивні мережі"
              selected={sectionMode === 'network'}
              onClick={() => handleNavigateToSection('network')}
              interactive
              fontSize="0.75rem"
              fontWeight={600}
              labelPaddingX={0.9}
              labelPaddingY={0.1}
              sx={{ height: 30 }}
            />
            <PowerChip
              label="Співпадіння з каталогом"
              selected={sectionMode === 'catalog'}
              onClick={() => handleNavigateToSection('catalog')}
              interactive
              fontSize="0.75rem"
              fontWeight={600}
              labelPaddingX={0.9}
              labelPaddingY={0.1}
              sx={{ height: 30 }}
            />
            <PowerChip
              label="Присутні в перехопленнях"
              selected={sectionMode === 'intercepted'}
              onClick={() => handleNavigateToSection('intercepted')}
              interactive
              fontSize="0.75rem"
              fontWeight={600}
              labelPaddingX={0.9}
              labelPaddingY={0.1}
              sx={{ height: 30 }}
            />
          </Stack>
        </Stack>
        {canManage ? (
          <Button variant="contained" onClick={onOpenCreateDrawer} disabled={loading}>
            Додати
          </Button>
        ) : null}
      </Box>

      {loadingError && networkCallsigns.length === 0 && catalogCallsignGroups.length === 0 && unknownInterceptedCallsigns.length === 0 ? (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <PowerAlert severity="error">{loadingError}</PowerAlert>
          <Button size="small" onClick={onReload}>
            Спробувати ще раз
          </Button>
        </Stack>
      ) : null}

      <Stack spacing={2.5} sx={{ minHeight: 0, width: '100%' }}>
        <Stack id={SECTION_IDS.network} spacing={1.5} sx={{ scrollMarginTop: 16 }}>
          <Box sx={{ height: NETWORK_SECTION_TABLE_HEIGHT, minHeight: 420, maxHeight: 640, display: 'flex' }}>
            <NetworkCallsignsNetworkTable
              title="Позивні мережі"
              rows={filteredNetworkRows}
              loading={loading}
              loadingError={loadingError}
              canManage={canManage}
              statusFilter={statusFilter}
              onStatusFilterChange={onStatusFilterChange}
              onOpenEditDrawer={onOpenEditDrawer}
              onOpenDeleteDialog={onOpenDeleteDialog}
              onSetMarkerMode={onSetMarkerMode}
              onReload={onReload}
              inFlightUpdateIds={inFlightUpdateIds}
              inFlightDeleteIds={inFlightDeleteIds}
            />
          </Box>
        </Stack>

        <Stack id={SECTION_IDS.catalog} spacing={1.5} sx={{ scrollMarginTop: 16 }}>
          <Box sx={{ height: CATALOG_SECTION_TABLE_HEIGHT, minHeight: 420, maxHeight: 720, display: 'flex' }}>
            <NetworkCallsignsCatalogTable
              title="Співпадіння з каталогом"
              countLabel={formatSectionCount(sectionCounts.catalog.filtered, sectionCounts.catalog.total, searchActive)}
              rows={filteredCatalogRows}
              loading={loading}
              loadingError={loadingError}
              canManage={canManage}
              onAddKnownCallsign={onAddKnownCallsign}
              onReload={onReload}
              inFlightAddIds={inFlightAddIds}
            />
          </Box>
        </Stack>

        <Stack id={SECTION_IDS.intercepted} spacing={1.5} sx={{ scrollMarginTop: 16 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ gap: 2, flexWrap: 'wrap' }}>
            <Stack direction="row" spacing={1.25} alignItems="baseline" sx={{ flexWrap: 'wrap' }}>
              <Typography variant="h6">Присутні в перехопленнях</Typography>
              <Typography variant="body2" color="text.secondary">
                {formatSectionCount(sectionCounts.intercepted.filtered, sectionCounts.intercepted.total, searchActive)}
              </Typography>
            </Stack>
          </Stack>
          {loadingError && unknownInterceptedCallsigns.length > 0 ? <PowerAlert severity="error">{loadingError}</PowerAlert> : null}
          <Box sx={{ pb: 2 }}>
            <NetworkCallsignsInterceptedPanel
              rows={filteredInterceptedRows}
              canManage={canManage}
              expanded={interceptedExpanded}
              loading={loading}
              mutationBusy={inFlightCreateCallsigns.length > 0}
              onToggleExpanded={onToggleInterceptedExpanded}
              onAddToDeveloping={onAddInterceptedToDeveloping}
              onAddToNetwork={onAddInterceptedToNetwork}
              inFlightCreateCallsigns={inFlightCreateCallsigns}
            />
          </Box>
        </Stack>
      </Stack>
    </Stack>
  );
}
