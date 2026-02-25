import AddIcon from '@mui/icons-material/Add';
import { Alert, Box, Button, CircularProgress, Stack } from '@mui/material';

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

  return (
    <Box className="w-full" sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Stack spacing={2.5} useFlexGap sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <PageHeader
          title="позивні"
          actions={
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={page.onOpenAddDrawer}
              disabled={page.addSubmitting}
            >
              Додати позивні
            </Button>
          }
        />

        {page.status ? <Alert severity={page.status.kind}>{page.status.text}</Alert> : null}

        <CallsignsFilters
          filters={page.filters}
          disabled={page.loading || page.addSubmitting || page.editSubmitting || page.deleteSubmitting || page.refreshing}
          sidebarOpen={page.sidebarOpen}
          canExport={page.permissions.canExport}
          downloadInProgress={page.downloadInProgress}
          onFiltersChange={page.onFiltersChange}
          onRefresh={page.onRefresh}
          onClearFilters={page.onClearFilters}
          onToggleSidebar={() => page.setSidebarOpen((prev: boolean) => !prev)}
          onDownloadCsv={page.onDownloadCsv}
          onDownloadXlsx={page.onDownloadXlsx}
        />

        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={2}
          sx={{
            flex: 1,
            minHeight: 0,
            alignItems: { xs: 'flex-start', lg: 'stretch' },
          }}
        >
          <UnitStatsSidebar
            stats={page.unitStatsView}
            open={page.sidebarOpen}
            loading={page.refreshing && page.unitStatsView.length === 0}
            onPickUnitFilter={page.onPickUnitFilter}
          />

          <Stack spacing={2} useFlexGap sx={{ flex: 1, minWidth: 0, minHeight: 0, height: { lg: '100%' } }}>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <CallsignsTable
                rows={page.rows}
                loading={page.loading}
                loadingMore={page.loadingMore}
                sort={page.sort}
                onSort={page.onSort}
                onEdit={page.onOpenEdit}
                onDelete={page.onRequestDelete}
              />
            </Box>

            {page.showLoadMore ? (
              <Stack direction="row" justifyContent="center">
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
    </Box>
  );
}
