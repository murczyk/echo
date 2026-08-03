import AddIcon from '@mui/icons-material/Add';
import { Box, CircularProgress, Stack, Typography, useMediaQuery } from '@mui/material';
import { useMemo } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { buildDefaultColumnOrder } from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import type { ActiveFilterDescriptor } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions/components/active-filters-utils';
import { UnitStatsSidebar } from '../rer-callsigns-neo/components/UnitStatsSidebar';
import { DEFAULT_DEVICES_SORTING, sanitizeDevicesColumnFilters } from './helpers';
import { DeviceUpsertDrawer } from './components/DeviceUpsertDrawer';
import { DevicesTable } from './components/DevicesTable';
import { DevicesToolbar } from './components/DevicesToolbar';
import { useDevicesPage } from './use-devices-page';

const columnOrder = buildDefaultColumnOrder({
  dataColumnIds: ['name', 'aors', 'unit', 'createdBy', 'createdAt', 'updatedAt', 'lifecycle'],
  withRowNumbers: true,
  withRowActions: true,
});

const defaultColumnVisibility = {
  name: true,
  aors: true,
  unit: true,
  updatedAt: true,
  createdBy: true,
  createdAt: true,
  lifecycle: true,
};

function DevicesPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useDevicesPage({ authUserRoles });
  const tableStateContext = useTableStateContext();
  const isDesktopLayout = useMediaQuery((theme) => theme.breakpoints.up('lg'));

  const additionalActiveFilters = useMemo<ActiveFilterDescriptor[]>(() => {
    const filters: ActiveFilterDescriptor[] = [];

    if (page.filters.archivedFilter !== 'active') {
      filters.push({
        id: 'archived',
        label: 'Стан',
        value: page.filters.archivedFilter,
        valuePreview: page.filters.archivedFilter === 'archived' ? 'Архівні' : 'Всі',
        isGlobalFilter: false,
      });
    }

    if (page.selectedSidebarUnitFilter) {
      filters.push({
        id: 'unit',
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
      });
    }

    return filters;
  }, [page.filters.archivedFilter, page.selectedSidebarUnitFilter]);

  function clearAdditionalActiveFilter(filterId: string) {
    switch (filterId) {
      case 'archived':
        page.setArchivedFilter('active');
        break;
      case 'unit':
        page.onClearUnitFilter();
        break;
    }
  }

  function clearAdditionalActiveFilters() {
    page.setArchivedFilter('active');
    page.onClearUnitFilter();
  }

  if (!page.permissions.canRead) {
    return <PageErrorState message="Немає доступу до пристроїв." minHeight="100%" />;
  }

  return (
    <Box sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}>
      <Stack
        spacing={3}
        useFlexGap
        sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}
      >
        <TablePageToolbar
          title="Пристрої"
          titleInfo={
            <Typography variant="body2" color="text.secondary">
              {page.total > 0 ? `Знайдено: ${page.total}` : null}
            </Typography>
          }
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
            page.permissions.canCreate ? (
              <PowerButton
                variant="contained"
                onClick={page.openCreateDialog}
                disabled={page.creating || page.loading}
                startIcon={page.creating ? <CircularProgress size={16} /> : <AddIcon />}
              >
                Створити пристрій
              </PowerButton>
            ) : null
          }
        />

        {page.status ? (
          <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert>
        ) : null}
        {page.sidebarError ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton size="small" onClick={() => void page.reloadSidebar()}>
                Повторити
              </PowerButton>
            }
          >
            {page.sidebarError}
          </PowerAlert>
        ) : null}

        <DeviceUpsertDrawer
          open={page.createDialogOpen}
          mode="create"
          fieldPermissions={page.permissions.fieldPermissions}
          form={page.createForm}
          saving={page.creating}
          error={page.createError}
          serverFieldErrors={page.createServerFieldErrors}
          referenceLoading={false}
          aorOptions={page.aorOptions}
          unitOptions={page.unitOptions}
          onClose={page.closeCreateDialog}
          onChange={page.setCreateForm}
          onSave={(form) => void page.submitCreateDialog(form)}
        />

        <DeviceUpsertDrawer
          open={page.editDialogOpen}
          mode="edit"
          fieldPermissions={page.permissions.fieldPermissions}
          form={page.editForm}
          saving={page.editSubmitting}
          error={page.editError}
          serverFieldErrors={page.editServerFieldErrors}
          referenceLoading={page.lookupsLoading}
          aorOptions={page.aorOptions}
          unitOptions={page.unitOptions}
          hasChanges={page.editHasChanges}
          onClose={page.closeEditDialog}
          onChange={page.setEditForm}
          onSave={(form) => void page.submitEditDialog(form)}
        />

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
                  loading={page.sidebarLoading}
                  onPickUnitFilter={page.onPickUnitFilter}
                  showInvestigatingFilter={false}
                  selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
                  countLabel="Пристроїв"
                />
              </Box>
            ) : null
          ) : (
            <UnitStatsSidebar
              stats={page.unitStatsView}
              open={page.sidebarOpen}
              isDesktopLayout={isDesktopLayout}
              loading={page.sidebarLoading}
              onPickUnitFilter={page.onPickUnitFilter}
              showInvestigatingFilter={false}
              onToggleOpen={() => page.setSidebarOpen((prev: boolean) => !prev)}
              selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
              countLabel="Пристроїв"
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
            <DevicesToolbar
              loading={page.loading}
              globalFilter={tableStateContext.globalFilter}
              onChangeGlobalFilter={tableStateContext.onChangeGlobalFilter}
              filters={page.filters}
              setFilters={page.setFilters}
              statusCounts={page.statusCounts}
              additionalActiveFilters={additionalActiveFilters}
              onClearAdditionalActiveFilter={clearAdditionalActiveFilter}
              onClearAdditionalActiveFilters={clearAdditionalActiveFilters}
              table={tableStateContext.tableInstance as never}
            />

            {page.initialLoadFailed ? (
              <PageErrorState
                message={page.status?.text ?? 'Помилка завантаження пристроїв.'}
                actionLabel="Спробувати ще раз"
                onAction={() => void page.reload()}
                minHeight="100%"
              />
            ) : (
              <DevicesTable
                rows={page.rows}
                loading={page.loading}
                refreshing={page.refreshing}
                loadingMore={page.loadingMore}
                hasMore={page.hasMore}
                total={page.total}
                canEdit={page.permissions.canEdit}
                mutatingDeviceId={page.busyDeviceId}
                hasFilters={page.hasFilters}
                tableStateContext={tableStateContext}
                onEdit={page.openEditRow}
                onLoadMore={page.loadMore}
                onClearFilters={page.clearFilters}
                onTableInitialized={tableStateContext.onTableInitialized}
                columnOrder={columnOrder}
              />
            )}
          </Stack>
        </Stack>
      </Stack>
    </Box>
  );
}

export function DevicesPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  return (
    <TableStateProvider
      tableId="devices"
      defaultColumnVisibility={defaultColumnVisibility}
      defaultColumnOrder={columnOrder}
      defaultSorting={DEFAULT_DEVICES_SORTING}
      sanitizeColumnFilters={sanitizeDevicesColumnFilters}
    >
      <DevicesPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
