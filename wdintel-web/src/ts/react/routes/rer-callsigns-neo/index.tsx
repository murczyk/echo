import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
} from '@mui/material';

import { BulkDeleteConfirmDialog } from '../../components/BulkDeleteConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { AddCallsignsDrawer } from './components/AddCallsignsDrawer';
import { CallsignsFilters } from './components/CallsignsFilters';
import { CallsignsTable } from './components/CallsignsTable';
import { DeleteCallsignDialog } from './components/DeleteCallsignDialog';
import { EditCallsignDialog } from './components/EditCallsignDialog';
import { UnitStatsSidebar } from './components/UnitStatsSidebar';
import { useRerCallsignsNeoPage } from './use-rer-callsigns-neo-page';

export function RerCallsignsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useRerCallsignsNeoPage({ authUserRoles });
  const hasActiveFilters =
    page.filters.filterCallsign.trim() !== '' ||
    page.filters.filterPosition.trim() !== '' ||
    page.filters.filterComment.trim() !== '' ||
    page.filters.filterUnit.trim() !== '' ||
    page.filters.filterDeveloping !== 'OnlyNonDeveloping' ||
    !page.filters.isIgnoringDateFilter;

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack
        spacing={2.5}
        useFlexGap
        sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}
      >
        <PageHeader
          className="px-4"
          title="позивні"
          actions={
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
          }
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
            selectedUnitFilter={page.filters.filterUnit}
          />

          <Stack spacing={2} useFlexGap sx={{ flex: 1, minWidth: 0, minHeight: { xs: 'auto', lg: 0 }, height: { lg: '100%' } }}>
            <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 } }}>
              <Paper
                variant="outlined"
                sx={{
                  height: { xs: 'auto', lg: '100%' },
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
                  <CallsignsFilters
                    filters={page.filters}
                    disabled={page.loading || page.addSubmitting || page.editSubmitting || page.deleteSubmitting}
                    sidebarOpen={page.sidebarOpen}
                    selectedCount={page.selectedCallsignIds.length}
                    canExport={page.permissions.canExport}
                    downloadInProgress={page.downloadInProgress}
                    onFiltersChange={page.onFiltersChange}
                    onClearFilters={page.onClearFilters}
                    onClearSelectedCallsigns={page.clearSelectedCallsigns}
                    onToggleSidebar={() => page.setSidebarOpen((prev: boolean) => !prev)}
                    onDownloadCsv={page.onDownloadCsv}
                    onDownloadXlsx={page.onDownloadXlsx}
                  />
                </Box>
                <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 } }}>
                  <CallsignsTable
                    embedded
                    rows={page.rows}
                    loading={page.loading}
                    refreshing={page.refreshing}
                    loadingMore={page.loadingMore}
                    hasActiveFilters={hasActiveFilters}
                    inFlightDeleteId={page.deleteInFlightId}
                    bulkDeleteInFlight={page.bulkDeleteInFlight}
                    selectedCallsignIds={page.selectedCallsignIds}
                    sort={page.sort}
                    onSort={page.onSort}
                    onClearFilters={page.onClearFilters}
                    onSetCallsignSelected={page.setCallsignSelected}
                    onSetAllCallsignsSelected={page.setAllCallsignsSelected}
                    onEdit={page.onOpenEdit}
                    onDelete={page.onRequestDelete}
                  />
                </Box>
              </Paper>
            </Box>

            {page.showLoadMore ? (
              <Stack direction="row" justifyContent="center" sx={{ mb: { xs: 3, lg: 0 } }}>
                <Button
                  variant="outlined"
                  onClick={page.onLoadMore}
                  disabled={page.loadingMore || page.loading}
                  startIcon={page.loadingMore ? <CircularProgress color="inherit" size={16} /> : null}
                >
                  {page.loadingMore ? 'Завантаження…' : 'Завантажити ще'}
                </Button>
              </Stack>
            ) : null}
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
        rows={page.addRows}
        submitting={page.addSubmitting}
        disabled={false}
        validationError={page.addValidationError}
        onAddUnitIdChange={page.setAddUnitId}
        onAddSourceIdChange={page.setAddSourceId}
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
