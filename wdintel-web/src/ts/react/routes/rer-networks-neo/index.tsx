import { Box, Stack, useMediaQuery } from '@mui/material';
import type { MRT_SortingState } from 'material-react-table';
import { useCallback, useEffect, useMemo } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

import { TablePageToolbar } from '../../components/TablePageToolbar';
import { PowerAlert } from '../../components/PowerAlert';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { buildDefaultColumnOrder } from '../../components/mui-customized/table/get-default-table-options';
import { UnitStatsSidebar } from '../rer-callsigns-neo/components/UnitStatsSidebar';
import { NetworksTable } from './components/NetworksTable';
import { NetworkDialogs } from './components/NetworkDialogs';
import {
  NetworkHoverPopovers,
  FREQUENCY_HOVER_POPPER_MODIFIERS,
  FREQUENCY_HOVER_POPPER_PLACEMENT,
  useHoverPopoverState,
} from './components/NetworkHoverPopovers';
import { NetworkPageHeaderActions } from './components/NetworksPageHeader';
import { NetworksToolbar } from './components/NetworksToolbar';
import { useRerNetworksNeoPage } from './use-rer-networks-neo-page';
import { resolveAorFilterSelectOptions, sanitizeNetworkColumnFilters } from './helpers';
import { getLocationParts } from './components/NetworkCells';

const DEFAULT_NETWORKS_SORTING: MRT_SortingState = [{ id: 'network', desc: false }];
const columnOrder = buildDefaultColumnOrder({
  dataColumnIds: ['network', 'aors', 'freqs', 'location', 'activity', 'lastActivity'],
  withRowNumbers: true,
  withRowActions: true,
});

export {
  FREQUENCY_HOVER_POPPER_MODIFIERS,
  FREQUENCY_HOVER_POPPER_PLACEMENT,
  getLocationParts,
  useHoverPopoverState,
};

function RerNetworksNeoPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useRerNetworksNeoPage({ authUserRoles });
  const tableStateContext = useTableStateContext();
  const isDesktopLayout = useMediaQuery((theme) => theme.breakpoints.up('lg'));
  const aorFilterOptions = useMemo(
    () => resolveAorFilterSelectOptions(page.aorOptions),
    [page.aorOptions],
  );
  const safeColumnFilters = useMemo(
    () => sanitizeNetworkColumnFilters(tableStateContext.columnFilters),
    [tableStateContext.columnFilters],
  );
  const {
    hoverPopover,
    onHoverAnchorPointerEnter,
    onHoverLocationPointerEnter,
    onHoverAnchorPointerLeave,
    onHoverPopperPointerEnter,
    onHoverPopperPointerLeave,
    closeHoverPopover,
  } = useHoverPopoverState();

  const onToggleReportsMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      page.setReportsMenuAnchorEl((current) =>
        current === event.currentTarget ? null : event.currentTarget,
      );
    },
    [page.setReportsMenuAnchorEl],
  );

  const additionalActiveFilters = useMemo(
    () => [
      ...(page.selectedSidebarUnitFilter
        ? [
            {
              id: 'page-unit',
              label: 'Підрозділ',
              value:
                page.selectedSidebarUnitFilter.kind === 'leaf'
                  ? page.selectedSidebarUnitFilter.unitName
                  : page.selectedSidebarUnitFilter.label,
              valuePreview:
                page.selectedSidebarUnitFilter.kind === 'leaf'
                  ? page.selectedSidebarUnitFilter.unitName
                  : page.selectedSidebarUnitFilter.label,
              isGlobalFilter: false,
            },
          ]
        : page.filters.unitText.trim()
          ? [
              {
                id: 'page-unit',
                label: 'Підрозділ',
                value: page.filters.unitText.trim(),
                valuePreview: page.filters.unitText.trim(),
                isGlobalFilter: false,
              },
            ]
          : []),
      ...(page.filters.showOnlyInvestigating
        ? [
            {
              id: 'page-investigating',
              label: 'Статус',
              value: 'В дорозвідці',
              valuePreview: 'В дорозвідці',
              isGlobalFilter: false,
            },
          ]
        : []),
      ...(page.filters.status !== 'all'
        ? [
            {
              id: 'page-status',
              label: 'Статус',
              value: page.filters.status,
              valuePreview:
                page.filters.status === 'active'
                  ? 'Активні'
                  : page.filters.status === 'inactive'
                    ? 'Неактивні'
                    : 'Архівні',
              isGlobalFilter: false,
            },
          ]
        : []),
    ],
    [
      page.filters.status,
      page.filters.unitText,
      page.filters.showOnlyInvestigating,
      page.selectedSidebarUnitFilter,
    ],
  );

  useEffect(() => {
    closeHoverPopover();
  }, [
    closeHoverPopover,
    page.loading,
    page.loadingMore,
    page.refreshing,
    tableStateContext.columnFilters,
    tableStateContext.globalFilter,
    tableStateContext.sorting,
  ]);

  const handleTablePointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-network-hover-anchor="true"], [data-network-hover-popper="true"]'))
        return;
      if (hoverPopover !== null) {
        closeHoverPopover();
      }
    },
    [closeHoverPopover, hoverPopover],
  );

  return (
    <Box sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}>
      <Stack
        spacing={3}
        useFlexGap
        sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}
      >
        <TablePageToolbar
          title="Мережі"
          titleLeadingActions={
            !isDesktopLayout ? null : (
              <SidePanelToggleButton
                side="left"
                active={page.sidebarOpen}
                label={page.sidebarOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
                onClick={() => page.setSidebarOpen((prev: boolean) => !prev)}
              />
            )
          }
          titleLeadingGap={2}
          internalActionsHidden
          actions={
            <NetworkPageHeaderActions
              canEdit={page.permissions.canEdit}
              canExport={page.permissions.canExport}
              reportsMenuAnchorEl={page.reportsMenuAnchorEl}
              loading={
                page.loading ||
                page.refreshing ||
                page.loadingMore ||
                page.downloadInFlight !== null
              }
              onCreate={page.openCreateDialog}
              onOpenReportsMenu={onToggleReportsMenu}
            />
          }
        />

        {page.status ? (
          <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert>
        ) : null}

        <Stack
          direction={isDesktopLayout ? 'row' : 'column'}
          spacing={2}
          useFlexGap
          sx={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}
        >
          {isDesktopLayout ? (
            page.sidebarOpen ? (
              <Box
                sx={{ display: 'flex', alignItems: 'stretch', gap: 0, flexShrink: 0, minHeight: 0 }}
              >
                <UnitStatsSidebar
                  stats={page.unitStatsView}
                  open={page.sidebarOpen}
                  isDesktopLayout={isDesktopLayout}
                  loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
                  onPickUnitFilter={page.onPickUnitFilter}
                  onToggleInvestigating={page.onToggleInvestigating}
                  showInvestigatingFilter
                  isInvestigating={page.filters.showOnlyInvestigating}
                  selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
                />
              </Box>
            ) : null
          ) : (
            <UnitStatsSidebar
              stats={page.unitStatsView}
              open={page.sidebarOpen}
              isDesktopLayout={isDesktopLayout}
              loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
              onPickUnitFilter={page.onPickUnitFilter}
              onToggleInvestigating={page.onToggleInvestigating}
              showInvestigatingFilter
              isInvestigating={page.filters.showOnlyInvestigating}
              onToggleOpen={() => page.setSidebarOpen((prev: boolean) => !prev)}
              selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
            />
          )}

          <Stack
            spacing={2}
            useFlexGap
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <NetworksToolbar
              loading={page.loading}
              globalFilter={tableStateContext.globalFilter}
              onChangeGlobalFilter={tableStateContext.onChangeGlobalFilter}
              filters={page.filters}
              setFilters={page.setFilters}
              statusCounts={page.statusCounts}
              additionalActiveFilters={additionalActiveFilters}
              onClearAdditionalActiveFilter={(filterId) => {
                if (filterId === 'page-unit') {
                  page.onClearUnitFilter();
                }
                if (filterId === 'page-investigating') {
                  page.onClearInvestigatingFilter();
                }
                if (filterId === 'page-status') {
                  page.setFilters((current) => ({ ...current, status: 'all' }));
                }
              }}
              onClearAdditionalActiveFilters={() => {
                page.onClearUnitFilter();
                page.onClearInvestigatingFilter();
                page.setFilters((current) => ({ ...current, status: 'all' }));
              }}
              table={tableStateContext.tableInstance as never}
            />

            <NetworksTable
              rows={page.rows}
              loading={page.loading}
              refreshing={page.refreshing}
              loadingMore={page.loadingMore}
              noMoreToLoad={page.noMoreToLoad}
              permissions={page.permissions}
              tableStateContext={tableStateContext}
              aorFilterOptions={aorFilterOptions}
              aorOptions={page.aorOptions}
              onFrequencyHoverEnter={onHoverAnchorPointerEnter}
              onFrequencyHoverLeave={onHoverAnchorPointerLeave}
              onLocationHoverEnter={onHoverLocationPointerEnter}
              onLocationHoverLeave={onHoverAnchorPointerLeave}
              onOpenReportDialog={page.openReportDialog}
              onOpenEditDialog={page.openEditDialog}
              onOpenDeleteDialog={page.openDeleteDialog}
              onLoadMoreNetworks={page.loadMoreNetworks}
              onPointerMoveCapture={handleTablePointerMoveCapture}
              onTableInitialized={tableStateContext.onTableInitialized}
              columnOrder={columnOrder}
            />
          </Stack>
        </Stack>
      </Stack>

      <NetworkHoverPopovers
        hoverPopover={hoverPopover}
        onClose={closeHoverPopover}
        onPointerEnter={onHoverPopperPointerEnter}
        onPointerLeave={onHoverPopperPointerLeave}
      />

      <NetworkDialogs page={page} />
    </Box>
  );
}

export function RerNetworksNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  return (
    <TableStateProvider
      tableId="rer-networks-neo"
      defaultColumnOrder={columnOrder}
      defaultColumnVisibility={{}}
      defaultEnableColumnOrdering={false}
      defaultSorting={DEFAULT_NETWORKS_SORTING}
      sanitizeColumnFilters={sanitizeNetworkColumnFilters}
    >
      <RerNetworksNeoPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
