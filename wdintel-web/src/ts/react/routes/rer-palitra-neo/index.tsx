import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material';

import { BulkDeleteConfirmDialog } from '../../components/BulkDeleteConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { CreatePalitraDrawer } from './components/CreatePalitraDrawer';
import { EditPalitraDrawer } from './components/EditPalitraDrawer';
import { PalitraTable } from './components/PalitraTable';
import { useRerPalitraNeoPage } from './use-rer-palitra-neo-page';

export function RerPalitraNeoPage() {
  const page = useRerPalitraNeoPage();

  return (
    <Box className="w-full" sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Stack spacing={3} useFlexGap sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <PageHeader
          className="px-4"
          title="палітри"
          actions={
            <Stack direction="row" spacing={2}>
              <Button
                component="a"
                href="/alpinequest-kmz"
                target="_blank"
                rel="noopener noreferrer"
                variant="outlined"
              >
                AlpineQuest конвертер
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={page.requestBulkDelete}
                disabled={page.selectedPalitraIds.length === 0 || page.bulkDeleteInFlight || page.inFlightDeleteId !== null}
              >
                Видалити палітри
              </Button>
              <Button variant="contained" onClick={page.openCreate} disabled={page.createInFlight}>
                Додати палітру
              </Button>
            </Stack>
          }
        />

        {page.error ? <Alert severity="error">{page.error.text}</Alert> : null}

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PalitraTable
            loading={page.loading}
            denseTable={page.denseTable}
            palitras={page.sortedPalitras}
            sortColumn={page.sortColumn}
            sortDirection={page.sortDirection}
            onSortColumn={page.onSortColumn}
            user={page.user}
            myScope={page.myScope}
            organisms={page.organisms}
            aors={page.aors}
            inFlightDeleteId={page.inFlightDeleteId}
            inFlightUploadId={page.inFlightUploadId}
            selectedPalitraIds={page.selectedPalitraIds}
            onOpenEdit={page.openEdit}
            onRequestUploadPoints={page.requestUploadPoints}
            onDelete={page.requestDelete}
            onSetPalitraSelected={page.setPalitraSelected}
            onSetAllPalitrasSelected={page.setAllPalitrasSelected}
            onClearSelectedPalitras={page.clearSelectedPalitras}
            onDenseTableChange={page.setDenseTable}
          />
        </Box>
      </Stack>

      <Dialog
        open={page.deleteDialogOpen}
        onClose={page.cancelDelete}
        disableRestoreFocus
        TransitionProps={{ onExited: page.onDeleteDialogExited }}
      >
        <DialogTitle>Підтвердження видалення</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {`Видалити палітру "${page.deleteDialogPalitra?.name ?? ''}"?`}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3, pt: 3 }}>
          <Button onClick={page.cancelDelete} disabled={page.inFlightDeleteId !== null}>
            Скасувати
          </Button>
          <Button
            onClick={page.confirmDelete}
            color="error"
            variant="contained"
            disabled={page.inFlightDeleteId !== null}
            startIcon={page.inFlightDeleteId !== null ? <CircularProgress color="inherit" size={16} /> : null}
          >
            Видалити
          </Button>
        </DialogActions>
      </Dialog>

      <BulkDeleteConfirmDialog
        open={page.bulkDeleteDialogOpen}
        onClose={page.cancelBulkDelete}
        onConfirm={page.confirmBulkDelete}
        onExited={page.onBulkDeleteDialogExited}
        summaryText={`Видалити палітр: ${page.bulkDeleteDialogPalitras.length}?`}
        items={page.bulkDeleteDialogPalitras.map((palitra) => ({
          id: palitra.id,
          primary: palitra.name,
          secondary: palitra.author ?? undefined,
        }))}
        submitting={page.bulkDeleteInFlight}
        disabled={page.inFlightDeleteId !== null}
      />

      <input
        ref={page.uploadPointsInputRef}
        type="file"
        accept="application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,.kmz,.kml"
        style={{ display: 'none' }}
        onChange={page.handleUploadPointsSelected}
      />

      <input
        ref={page.uploadKmzInputRef}
        type="file"
        accept="application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,.kmz,.kml"
        style={{ display: 'none' }}
        onChange={page.handleKmzSelected}
      />

      <CreatePalitraDrawer
        open={page.createOpen}
        onClose={page.resetCreateFlow}
        onExited={page.onCreateDrawerExited}
        createInFlight={page.createInFlight}
        kmzAnalyzing={page.kmzAnalyzing}
        kmzFile={page.kmzFile}
        kmzAnalysis={page.kmzAnalysis}
        kmzColorOptions={page.kmzColorOptions}
        selectedColorFromKmz={page.selectedColorFromKmz}
        createMode={page.createMode}
        createForm={page.createForm}
        user={page.user}
        myScope={page.myScope}
        organisms={page.organisms}
        aors={page.aors}
        allLogins={page.allLogins}
        availableAccessTypes={page.availableAccessTypes}
        onRequestAnalyzeKmz={page.requestAnalyzeKmz}
        onSetKmzColorOptions={page.updateKmzColorOptions}
        onSetSelectedColorFromKmz={page.setSelectedColorFromKmz}
        onSetCreateMode={page.setCreateMode}
        onSetCreateForm={page.updateCreateForm}
        onCreate={page.handleCreate}
      />

      <EditPalitraDrawer
        open={page.editForm !== null}
        onClose={page.closeEdit}
        editInFlight={page.editInFlight}
        editPalitraId={page.editPalitraId}
        editForm={page.editForm}
        user={page.user}
        myScope={page.myScope}
        organisms={page.organisms}
        aors={page.aors}
        allLogins={page.allLogins}
        availableAccessTypes={page.availableAccessTypes}
        onSetEditForm={page.updateEditForm}
        onSave={page.handleEditSave}
      />
    </Box>
  );
}
