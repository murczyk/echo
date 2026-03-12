import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';

import { BulkDeleteConfirmDialog } from '../../components/BulkDeleteConfirmDialog';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableToolbarControls } from '../../components/TableToolbarControls';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { AddCallsignsDrawer } from './components/AddCallsignsDrawer';
import { CallsignsFilters } from './components/CallsignsFilters';
import {
  CallsignsTable,
  DEFAULT_CALLSIGNS_TABLE_COLUMN_ORDER,
  DEFAULT_CALLSIGNS_TABLE_COLUMN_VISIBILITY,
} from './components/CallsignsTable';
import { DeleteCallsignDialog } from './components/DeleteCallsignDialog';
import { EditCallsignDialog } from './components/EditCallsignDialog';
import { UnitStatsSidebar } from './components/UnitStatsSidebar';
import { getExportPermissionFromRoles } from './helpers';
import { useRerCallsignsNeoPage } from './use-rer-callsigns-neo-page';

function RerCallsignsNeoPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useRerCallsignsNeoPage({ authUserRoles });
  const shellPermissions = getExportPermissionFromRoles(authUserRoles);
  const controlsDisabled =
    page.loading || page.refreshing || page.loadingMore || page.addSubmitting || page.editSubmitting || page.deleteSubmitting;
  const showExportButtons = page.permissions.canExport || (page.loading && shellPermissions.canExport);
  const hasActiveFilters =
    page.filters.filterText.trim() !== '' ||
    page.filters.filterDeveloping !== 'OnlyNonDeveloping' ||
    !page.filters.isIgnoringDateFilter;

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack
        spacing={3}
        useFlexGap
        sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}
      >
        <TablePageToolbar
          title="Позивні"
          internalActionsHidden
          actions={page.permissions.canEdit ? (
            <Stack direction="row" spacing={2}>
              <Button
                variant="outlined"
                color="error"
                onClick={page.requestBulkDelete}
                disabled={
                  page.selectedCallsignIds.length === 0 || page.bulkDeleteInFlight || page.deleteInFlightId !== null
                }
              >
                Видалити позивні
              </Button>
              <Button
                variant="contained"
                onClick={page.onOpenAddDrawer}
                disabled={page.addSubmitting || page.bulkDeleteInFlight}
              >
                Додати позивні
              </Button>
            </Stack>
          ) : undefined}
        />

        {page.status ? <Alert severity={page.status.kind}>{page.status.text}</Alert> : null}

        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={2}
          sx={{
            flex: 1,
            minHeight: { xs: 'auto', lg: 0 },
            alignItems: 'stretch',
          }}
        >
          <UnitStatsSidebar
            stats={page.unitStatsView}
            open={page.sidebarOpen}
            loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
            onPickUnitFilter={page.onPickUnitFilter}
            selectedUnitFilter={page.selectedSidebarUnitName ?? undefined}
          />

          <Stack spacing={2} useFlexGap sx={{ flex: 1, minWidth: 0, minHeight: { xs: 'auto', lg: 0 } }}>
            <TableToolbarControls
              filter={
                <CallsignsFilters
                  filters={page.filters}
                  filtersDisabled={controlsDisabled}
                  onFiltersChange={page.onFiltersChange}
                />
              }
              trailingActionsBeforeInternal={
                <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap>
                  <Button
                    startIcon={page.sidebarOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                    onClick={() => page.setSidebarOpen((prev: boolean) => !prev)}
                    variant="outlined"
                    aria-pressed={page.sidebarOpen}
                    sx={{ whiteSpace: 'nowrap' }}
                  >
                    {page.sidebarOpen ? 'Сховати підрозділи' : 'Показати підрозділи'}
                  </Button>
                  {showExportButtons ? (
                    <>
                      <Button
                        startIcon={page.downloadInProgress === 'csv' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
                        onClick={page.onDownloadCsv}
                        disabled={controlsDisabled || page.downloadInProgress !== null}
                        variant="outlined"
                      >
                        {page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
                      </Button>
                      <Button
                        startIcon={page.downloadInProgress === 'xlsx' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
                        onClick={page.onDownloadXlsx}
                        disabled={controlsDisabled || page.downloadInProgress !== null}
                        variant="outlined"
                      >
                        {page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
                      </Button>
                    </>
                  ) : null}
                </Stack>
              }
              trailingActions={
                <InternalTableActions
                  densityDisabled={page.loading}
                  columnsVisibilityDisabled={page.loading}
                  filtersHidden
                />
              }
            />
            <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 } }}>
              <CallsignsTable
                canEdit={page.permissions.canEdit}
                rows={page.rows}
                loading={page.loading}
                refreshing={page.refreshing}
                loadingMore={page.loadingMore}
                showLoadMore={page.showLoadMore}
                hasActiveFilters={hasActiveFilters}
                inFlightDeleteId={page.deleteInFlightId}
                bulkDeleteInFlight={page.bulkDeleteInFlight}
                selectedCallsignIds={page.selectedCallsignIds}
                sort={page.sort}
                statusFilter={page.filters.filterDeveloping}
                onSort={page.onSort}
                onStatusFilterChange={(filterDeveloping) => page.onFiltersChange((prev) => ({ ...prev, filterDeveloping }))}
                onClearFilters={page.onClearFilters}
                onSetSelectedCallsignIds={page.setSelectedCallsignIds}
                onLoadMore={page.onLoadMore}
                onEdit={page.onOpenEdit}
                onDelete={page.onRequestDelete}
              />
            </Box>
          </Stack>
        </Stack>
      </Stack>

      <AddCallsignsDrawer
        open={page.addDrawerOpen}
        onClose={page.onCloseAddDrawer}
        units={page.units}
        sources={page.sources}
        addUnitId={page.addUnitId}
        addSourceId={page.addSourceId}
        addCallsignAdditionalSourceIds={page.addCallsignAdditionalSourceIds}
        rows={page.addRows}
        submitting={page.addSubmitting}
        disabled={!page.permissions.canEdit}
        validationError={page.addValidationError}
        duplicateHints={page.addPotentialDuplicates}
        onAddUnitIdChange={page.setAddUnitId}
        onAddSourceIdChange={page.setAddSourceId}
        onAddCallsignAdditionalSourceIdsChange={page.setAddCallsignAdditionalSourceIds}
        onRowChange={page.onRowChange}
        onAppendRow={page.onAppendRow}
        onRemoveRow={page.onRemoveRow}
        onClearRows={page.onClearRows}
        onApplyPastedRows={page.onApplyPastedRows}
        onSubmit={page.onSubmitAdd}
      />

      <EditCallsignDialog
        open={page.editForm !== null}
        form={page.editForm}
        units={page.units}
        sources={page.sources}
        submitting={page.editSubmitting}
        error={page.editValidationError}
        onClose={page.onCloseEdit}
        onChange={page.setEditForm}
        onSave={page.onSaveEdit}
      />

      <DeleteCallsignDialog
        target={page.deleteTarget}
        submitting={page.deleteSubmitting}
        onCancel={page.onCancelDelete}
        onConfirm={page.onConfirmDelete}
      />

      <BulkDeleteConfirmDialog
        open={page.bulkDeleteDialogOpen}
        onClose={page.cancelBulkDelete}
        onConfirm={page.confirmBulkDelete}
        onExited={page.onBulkDeleteDialogExited}
        summaryText={`Видалити позивних: ${page.bulkDeleteDialogCallsigns.length}?`}
        items={page.bulkDeleteDialogCallsigns.map((callsign) => ({
          id: callsign.id,
          primary: callsign.callsign,
          secondary: callsign.position || undefined,
        }))}
        submitting={page.bulkDeleteInFlight}
        disabled={page.deleteInFlightId !== null}
      />
    </Box>
  );
}

export function RerCallsignsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  return (
    <TableStateProvider
      tableId="rer-callsigns-neo"
      defaultColumnVisibility={DEFAULT_CALLSIGNS_TABLE_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_CALLSIGNS_TABLE_COLUMN_ORDER}
    >
      <RerCallsignsNeoPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
