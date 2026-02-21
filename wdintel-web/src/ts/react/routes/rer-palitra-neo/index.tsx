import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack } from '@mui/material';

import { PageHeader } from '../../components/PageHeader';
import { CreatePalitraDrawer } from './components/CreatePalitraDrawer';
import { EditPalitraDrawer } from './components/EditPalitraDrawer';
import { PalitraTable } from './components/PalitraTable';
import { useRerPalitraNeoPage } from './use-rer-palitra-neo-page';

export function RerPalitraNeoPage() {
  const page = useRerPalitraNeoPage();

  return (
    <Box className="w-full">
      <Stack spacing={3}>
        <PageHeader
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
              <Button variant="contained" onClick={page.openCreate} disabled={page.createInFlight}>
                Додати палітру
              </Button>
            </Stack>
          }
        />

        {page.error ? <Alert severity="error">{page.error.text}</Alert> : null}

        <PalitraTable
          loading={page.loading}
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
          onOpenEdit={page.openEdit}
          onRequestUploadPoints={page.requestUploadPoints}
          onDelete={page.requestDelete}
        />
      </Stack>

      <Dialog open={page.deleteDialogOpen} onClose={page.cancelDelete} TransitionProps={{ onExited: page.onDeleteDialogExited }}>
        <DialogTitle>Підтвердження видалення</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {`Видалити палітру "${page.deleteDialogPalitra?.name ?? ''}"?`}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3, pt: 1.5 }}>
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
