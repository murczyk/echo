import { Box, Stack, Typography, useMediaQuery } from '@mui/material';
import { useMemo } from 'react';

import { hasRole } from '../../utils/roles';
import { PageErrorState } from '../../components/PageErrorState';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
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
import { DeviceSidebarFilters } from './components/DeviceSidebarFilters';
import { UnitStatsSidebar } from '../rer-callsigns-neo/components/UnitStatsSidebar';
import {
  DEFAULT_DEVICES_SORTING,
  isCustomFieldColumnId,
  sanitizeDevicesColumnFilters,
  sanitizeDevicesSorting,
} from './helpers';
import { DeviceUpsertDrawer } from './components/DeviceUpsertDrawer';
import { DevicesTable } from './components/DevicesTable';
import { DevicesToolbar } from './components/DevicesToolbar';
import { useDevicesPage } from './use-devices-page';
import { useDeviceMobileLayout } from './use-device-mobile-layout';

const columnOrder = buildDefaultColumnOrder({
  dataColumnIds: [
    'name',
    'description',
    'rating',
    'aors',
    'unit',
    'createdBy',
    'createdAt',
    'activity',
    'size',
    'tags',
  ],
  withRowNumbers: true,
  withRowActions: true,
});

const defaultColumnVisibility = {
  name: true,
  description: false,
  aors: true,
  unit: true,
  activity: true,
  size: true,
  createdBy: true,
  createdAt: true,
  rating: true,
  tags: true,
};

function DevicesPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useDevicesPage({ authUserRoles });
  const mobile = useDeviceMobileLayout();
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

    for (const [id, label, values] of [
      [
        'aors',
        'Смуги',
        page.filters.aorIds.map(
          (id) => page.filterOptions.aors.find((aor) => aor.id === id)?.name ?? `#${id}`,
        ),
      ],
      [
        'createdBy',
        'Створив',
        page.filters.createdBy.map(
          (login) =>
            page.filterOptions.creators
              .find((creator) => creator.login === login)
              ?.displayName?.trim() || login,
        ),
      ],
      ['tags', 'Теги', page.filters.tags],
    ] as const) {
      if (values.length)
        filters.push({
          id,
          label,
          value: [...values],
          valuePreview: values.join(', '),
          isGlobalFilter: false,
        });
    }
    return filters;
  }, [page.filters, page.filterOptions, page.selectedSidebarUnitFilter]);

  function clearAdditionalActiveFilter(filterId: string) {
    switch (filterId) {
      case 'archived':
        page.setArchivedFilter('active');
        break;
      case 'unit':
        page.onClearUnitFilter();
        break;
      case 'aors':
        page.setSidebarFilters({ ...page.filters, aorIds: [] });
        break;
      case 'createdBy':
        page.setSidebarFilters({ ...page.filters, createdBy: [] });
        break;
      case 'tags':
        page.setSidebarFilters({ ...page.filters, tags: [] });
        break;
    }
  }

  function clearAdditionalActiveFilters() {
    page.clearAdditionalFilters();
  }

  const sidebarFilters = (
    <DeviceSidebarFilters
      filters={page.filters}
      options={page.filterOptions}
      loading={page.sidebarLoading}
      onChange={page.setSidebarFilters}
    />
  );

  if (!page.permissions.canRead) {
    return <PageErrorState message="Немає доступу до пристроїв." minHeight="100%" />;
  }

  return (
    <Box sx={{ minHeight: 0, height: '100%', overflow: 'hidden' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: 0, height: '100%', overflow: 'hidden' }}>
        {mobile ? (
          <header className="flex shrink-0 items-center justify-between gap-echo-sm">
            <h1 className="m-0 text-[24px]! font-semibold!">Пристрої</h1>
          </header>
        ) : (
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
          />
        )}

        {page.status ? (
          <PowerAlert
            severity={page.status.kind}
            autoHideDuration={page.status.retry ? null : undefined}
            action={
              page.status.retry && page.rows.length > 0 ? (
                <PowerButton
                  size="small"
                  onClick={() =>
                    void (page.status?.retry === 'append' ? page.loadMore() : page.reload())
                  }
                >
                  Повторити
                </PowerButton>
              ) : undefined
            }
          >
            {page.status.text}
          </PowerAlert>
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
          open={page.editDialogOpen}
          mode="edit"
          deviceId={page.editDeviceId}
          canRebuildStats={hasRole(authUserRoles, 'Admin')}
          onStatsRebuilt={() => {
            void page.reload();
            void page.reloadSidebar();
          }}
          archived={page.editArchived}
          onArchive={() => {
            if (page.editDeviceId) page.requestArchive(page.editDeviceId);
          }}
          fieldPermissions={page.permissions.fieldPermissions}
          form={page.editForm}
          saving={page.editSubmitting}
          error={page.editError}
          serverFieldErrors={page.editServerFieldErrors}
          referenceLoading={page.lookupsLoading}
          aorOptions={page.aorOptions}
          unitOptions={page.unitOptions}
          hasChanges={page.editHasChanges}
          nameRequired={page.editNameRequired}
          onClose={page.closeEditDialog}
          onChange={page.setEditForm}
          onSave={(form) => void page.submitEditDialog(form)}
        />
        <ConfirmDangerDialog
          open={page.archiveCandidateId !== null}
          title={page.restoring ? 'Розархівувати пристрій?' : 'Архівувати пристрій?'}
          description={`Пристрій: ${page.rows.find((row) => row.id === page.archiveCandidateId)?.name ?? 'Без назви'}. ${page.restoring ? 'Пристрій стане активним. Редагування та нова синхронізація знову будуть доступні.' : 'Архівований пристрій залишиться доступним для перегляду. Редагування та нова синхронізація будуть недоступні. Незбережені зміни форми буде втрачено.'}`}
          confirmLabel={page.restoring ? 'Розархівувати' : 'Архівувати'}
          submitting={page.archiving}
          onClose={page.closeArchiveConfirmation}
          onConfirm={() => void page.confirmArchive()}
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
                  additionalFilters={sidebarFilters}
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
              additionalFilters={sidebarFilters}
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
                startOffset={page.startOffset}
                scrollResetKey={page.scrollResetKey}
                autoLoadBlocked={page.status?.kind === 'error'}
                canEdit={page.permissions.canEdit}
                canRate={page.permissions.canRate}
                onRate={(deviceId, rating) => void page.rateDevice(deviceId, rating)}
                mutatingDeviceId={page.busyDeviceId}
                hasFilters={page.hasFilters}
                tableStateContext={tableStateContext}
                onEdit={page.openEditRow}
                onLoadMore={page.loadMore}
                onClearFilters={page.clearFilters}
                onTableInitialized={tableStateContext.onTableInitialized}
                columnOrder={columnOrder}
                customFieldKeys={page.filterOptions.customFieldKeys}
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
      isDynamicColumnId={isCustomFieldColumnId}
      defaultSorting={DEFAULT_DEVICES_SORTING}
      persistSorting
      sanitizeSorting={sanitizeDevicesSorting}
      sanitizeColumnFilters={sanitizeDevicesColumnFilters}
    >
      <DevicesPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
