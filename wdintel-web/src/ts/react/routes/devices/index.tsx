import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useMemo } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { buildDefaultColumnOrder } from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import type { ActiveFilterDescriptor } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions/components/active-filters-utils';
import { DEFAULT_DEVICES_SORTING, type DeviceLookupOption } from './helpers';
import { DeviceUpsertDrawer } from './components/DeviceUpsertDrawer';
import { DevicesTable } from './components/DevicesTable';
import { DevicesToolbarFilters } from './components/DevicesToolbarFilters';
import { useDevicesPage } from './use-devices-page';

const columnOrder = buildDefaultColumnOrder({
  dataColumnIds: ['name', 'createdBy', 'unit', 'updatedAt', 'lifecycle'],
  withRowNumbers: true,
  withRowActions: true,
});

const defaultColumnVisibility = {
  name: true,
  createdBy: true,
  unit: true,
  updatedAt: true,
  lifecycle: false,
};

function optionLabels(options: DeviceLookupOption[], ids: number[]) {
  const byId = new Map(options.map((option) => [option.id, option.label]));
  return ids.map((id) => byId.get(id) ?? `#${id}`);
}

function DevicesPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useDevicesPage({ authUserRoles });
  const tableStateContext = useTableStateContext();

  const additionalActiveFilters = useMemo<ActiveFilterDescriptor[]>(() => {
    const filters: ActiveFilterDescriptor[] = [];

    if (page.filters.deletedFilter !== 'active') {
      filters.push({
        id: 'deleted',
        label: 'Стан',
        value: page.filters.deletedFilter,
        valuePreview: page.filters.deletedFilter === 'deleted' ? 'Видалені' : 'Всі',
        isGlobalFilter: false,
      });
    }

    if (page.filters.aorIds.length > 0) {
      const labels = optionLabels(page.aorOptions, page.filters.aorIds);
      filters.push({
        id: 'aor',
        label: 'Райони',
        value: page.filters.aorIds,
        valuePreview: labels.join(', '),
        isGlobalFilter: false,
      });
    }

    if (page.filters.unitIds.length > 0) {
      const labels = optionLabels(page.unitOptions, page.filters.unitIds);
      filters.push({
        id: 'unit',
        label: 'Підрозділи',
        value: page.filters.unitIds,
        valuePreview: labels.join(', '),
        isGlobalFilter: false,
      });
    }

    if (page.filters.createdBy.trim() !== '') {
      filters.push({
        id: 'createdBy',
        label: 'Створив',
        value: page.filters.createdBy,
        valuePreview: page.filters.createdBy.trim(),
        isGlobalFilter: false,
      });
    }

    return filters;
  }, [page.aorOptions, page.filters, page.unitOptions]);

  function clearAdditionalActiveFilter(filterId: string) {
    switch (filterId) {
      case 'deleted':
        page.setDeletedFilter('active');
        break;
      case 'aor':
        page.setAorIds([]);
        break;
      case 'unit':
        page.setUnitIds([]);
        break;
      case 'createdBy':
        page.setCreatedBy('');
        break;
    }
  }

  if (!page.permissions.canRead) {
    return <PageErrorState message="Немає доступу до пристроїв." minHeight="100%" />;
  }

  return (
    <Box sx={{ minHeight: 0, height: '100%', overflow: 'hidden' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: 0, height: '100%', overflow: 'hidden' }}>
        <TablePageToolbar
          title="Пристрої"
          titleInfo={
            <Typography variant="body2" color="text.secondary">
              {page.total > 0 ? `Знайдено: ${page.total}` : null}
            </Typography>
          }
          withGlobalTextFilter
          filter={
            <DevicesToolbarFilters
              filters={page.filters}
              aorOptions={page.aorOptions}
              unitOptions={page.unitOptions}
              disabled={page.loading}
              onDeletedFilterChange={page.setDeletedFilter}
              onAorIdsChange={page.setAorIds}
              onUnitIdsChange={page.setUnitIds}
              onCreatedByChange={page.setCreatedBy}
            />
          }
          actions={
            <>
              <Button
                variant="outlined"
                onClick={() => void page.reload()}
                disabled={page.loading || page.refreshing || page.loadingMore}
                startIcon={page.refreshing ? <CircularProgress size={16} /> : <RefreshIcon />}
              >
                Оновити
              </Button>
              {page.permissions.canEdit ? (
                <Button
                  variant="contained"
                  onClick={page.openCreateDialog}
                  disabled={page.creating || page.loading}
                  startIcon={page.creating ? <CircularProgress size={16} /> : <AddIcon />}
                >
                  Створити пристрій
                </Button>
              ) : null}
            </>
          }
          additionalActiveFilters={additionalActiveFilters}
          onClearAdditionalActiveFilter={clearAdditionalActiveFilter}
          onClearAdditionalActiveFilters={page.clearFilters}
          rowNumberAppearanceControl
        />

        {page.status ? (
          <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert>
        ) : null}

        <DeviceUpsertDrawer
          open={page.createDialogOpen}
          mode="create"
          form={page.createForm}
          saving={page.creating}
          error={page.createError}
          serverFieldErrors={page.createServerFieldErrors}
          referenceLoading={
            page.loading && page.aorOptions.length === 0 && page.unitOptions.length === 0
          }
          aorOptions={page.aorOptions}
          unitOptions={page.unitOptions}
          onClose={page.closeCreateDialog}
          onChange={page.setCreateForm}
          onSave={(form) => void page.submitCreateDialog(form)}
        />

        <ConfirmDangerDialog
          open={page.deleteDialogDevice !== null}
          onClose={page.closeDeleteDialog}
          onConfirm={() => void page.confirmDeleteRow()}
          title="Видалити пристрій"
          description={`Ви дійсно хочете видалити пристрій «${page.deleteDialogDevice?.name ?? ''}»?`}
          submitting={page.mutatingDeviceId !== null}
          disabled={page.deleteDialogDevice === null}
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
            mutatingDeviceId={page.mutatingDeviceId}
            showLifecycle={page.filters.deletedFilter !== 'active'}
            hasFilters={page.hasFilters}
            tableStateContext={tableStateContext}
            onDelete={page.deleteRow}
            onRestore={page.restoreRow}
            onLoadMore={page.loadMore}
            onClearFilters={page.clearFilters}
            onTableInitialized={tableStateContext.onTableInitialized}
            columnOrder={columnOrder}
          />
        )}
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
    >
      <DevicesPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
