import { Alert, Box, Button, Stack } from '@mui/material';

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
              <Button variant="contained" onClick={page.openCreate}>
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
          onDelete={page.handleDelete}
        />
      </Stack>

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
        onSetKmzColorOptions={(updater) => page.setKmzColorOptions((prev) => updater(prev))}
        onSetSelectedColorFromKmz={page.setSelectedColorFromKmz}
        onSetCreateForm={(updater) => page.setCreateForm((prev) => updater(prev))}
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
        onSetEditForm={(updater) => page.setEditForm((prev) => updater(prev))}
        onSave={page.handleEditSave}
      />
    </Box>
  );
}
