import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { MRT_SortingState } from 'material-react-table';

import { BulkDeleteConfirmDialog } from '../../components/BulkDeleteConfirmDialog';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { CreatePalitraDrawer } from './components/CreatePalitraDrawer';
import { EditPalitraDrawer } from './components/EditPalitraDrawer';
import { PalitraFolderActionDialog } from './components/PalitraFolderActionDialog';
import {
  DEFAULT_PALITRA_COLUMN_ORDER,
  DEFAULT_PALITRA_COLUMN_VISIBILITY,
  PalitraTable,
} from './components/PalitraTable';
import { useRerPalitraNeoPage } from './use-rer-palitra-neo-page';
import { PowerAlert } from '../../components/PowerAlert';

const DEFAULT_PALITRA_SORTING: MRT_SortingState = [{ id: 'lastUploadedAtTs', desc: true }];

function RerPalitraNeoPageBody() {
  const page = useRerPalitraNeoPage();

  return (
    <Box className='w-full' sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Stack spacing={3} useFlexGap sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <TablePageToolbar
          title='Палітри'
          withGlobalTextFilter
          filtersHidden
          filter={
            <ToggleButtonGroup
              value={page.archiveView}
              exclusive
              size='small'
              color='primary'
              onChange={(_event, value: 'active' | 'all' | 'archived' | null) => {
                if (value) page.setArchiveView(value);
              }}
              sx={{
                flexShrink: 0,
                borderRadius: 1,
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  px: 1.75,
                  py: 0.875,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  lineHeight: 1.25,
                  borderRadius: 0,
                },
                '& .MuiToggleButtonGroup-firstButton': {
                  borderTopLeftRadius: 8,
                  borderBottomLeftRadius: 8,
                },
                '& .MuiToggleButtonGroup-lastButton': {
                  borderTopRightRadius: 8,
                  borderBottomRightRadius: 8,
                },
              }}
            >
              <ToggleButton value='all'>Усі</ToggleButton>
              <ToggleButton value='active'>Активні</ToggleButton>
              <ToggleButton value='archived'>Архів</ToggleButton>
            </ToggleButtonGroup>
          }
          actions={
            <Stack direction='row' spacing={2} flexWrap='wrap' useFlexGap>
              <Button
                component='a'
                href='/alpinequest-kmz'
                target='_blank'
                rel='noopener noreferrer'
                variant='outlined'
              >
                AlpineQuest конвертер
              </Button>
              <Button
                variant='outlined'
                onClick={page.requestAssignFolder}
                disabled={
                  page.selectedPalitraIds.length === 0 ||
                  page.folderActionsBlocked ||
                  page.bulkDeleteInFlight ||
                  page.inFlightArchiveId !== null ||
                  page.inFlightDeleteId !== null
                }
              >
                Перемістити в папку
              </Button>
              <Button
                variant='outlined'
                color='error'
                onClick={page.requestBulkDelete}
                disabled={
                  page.selectedPalitraIds.length === 0 ||
                  page.bulkDeleteInFlight ||
                  page.folderActionsBlocked ||
                  page.inFlightArchiveId !== null ||
                  page.inFlightDeleteId !== null
                }
              >
                Видалити палітри
              </Button>
              <Button variant='contained' onClick={page.openCreate} disabled={page.createInFlight || page.folderActionsBlocked}>
                Додати палітру
              </Button>
            </Stack>
          }
        />

        {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PalitraTable
            loading={page.loading}
            rows={page.rows}
            bulkDeleteInFlight={page.bulkDeleteInFlight}
            externalBusy={page.folderActionsBlocked}
            selectedPalitraIds={page.selectedPalitraIds}
            onOpenEdit={page.openEdit}
            onRequestArchive={page.requestArchive}
            onRequestAssignFolder={page.requestAssignFolderForPalitra}
            onRequestUnarchive={page.handleUnarchive}
            onDownload={page.handleDownload}
            onRequestUploadPoints={page.requestUploadPoints}
            onDelete={page.requestDelete}
            onSetSelectedPalitraIds={page.setSelectedPalitraIds}
            onToggleFolderExpanded={page.toggleFolderExpanded}
            onRequestRenameFolder={page.requestRenameFolder}
            onRequestArchiveFolder={page.requestArchiveFolder}
            onRequestDeleteFolder={page.requestDeleteFolder}
          />
        </Box>
      </Stack>

      <PalitraFolderActionDialog
        state={page.folderDialogState}
        folderOptions={page.folderOptions}
        submitting={page.folderActionInFlight}
        onClose={page.cancelFolderAction}
        onConfirm={page.confirmFolderAction}
        onNextFolderPathChange={page.setFolderDialogNextFolderPath}
      />

      <Dialog
        open={page.archiveDialogOpen}
        onClose={page.cancelArchive}
        disableRestoreFocus
        TransitionProps={{ onExited: page.onArchiveDialogExited }}
        fullWidth
        maxWidth='sm'
      >
        <DialogTitle>Перенести палітру в архів</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1.5, fontSize: '1rem', lineHeight: 1.6 }}>
            {'Перенести палітру «' + (page.archiveDialogPalitra?.name ?? '') + '» в архів?'}
          </DialogContentText>
          <Typography variant='body1' color='text.primary' sx={{ mb: 1.5, lineHeight: 1.6 }}>
            Архівні палітри залишаються в системі, але не беруть участі в активній роботі:
          </Typography>
          <Box
            component='ul'
            sx={{
              m: 0,
              pl: 3,
              listStyleType: 'disc',
              '& li': {
                mb: 1,
                display: 'list-item',
              },
            }}
          >
            <Typography component='li' variant='body1' sx={{ lineHeight: 1.6 }}>
              Лишаються в системі з позначкою «Архів»
            </Typography>
            <Typography component='li' variant='body1' sx={{ lineHeight: 1.6 }}>
              Не відображаються в результатах пошуку
            </Typography>
            <Typography component='li' variant='body1' sx={{ lineHeight: 1.6 }}>
              Не відображаються на мапах
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button onClick={page.cancelArchive} disabled={page.inFlightArchiveId !== null}>
            Скасувати
          </Button>
          <Button
            onClick={page.confirmArchive}
            color='warning'
            variant='contained'
            disabled={page.inFlightArchiveId !== null}
            startIcon={page.inFlightArchiveId !== null ? <CircularProgress color='inherit' size={16} /> : null}
          >
            Перенести в архів
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={page.deleteDialogOpen}
        onClose={page.cancelDelete}
        disableRestoreFocus
        TransitionProps={{ onExited: page.onDeleteDialogExited }}
      >
        <DialogTitle>Підтвердження видалення</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {'Видалити палітру «' + (page.deleteDialogPalitra?.name ?? '') + '»?'}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button onClick={page.cancelDelete} disabled={page.inFlightDeleteId !== null}>
            Скасувати
          </Button>
          <Button
            onClick={page.confirmDelete}
            color='error'
            variant='contained'
            disabled={page.inFlightDeleteId !== null}
            startIcon={page.inFlightDeleteId !== null ? <CircularProgress color='inherit' size={16} /> : null}
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
        summaryText={'Видалити палітр: ' + page.bulkDeleteDialogPalitras.length + '?'}
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
        type='file'
        accept='application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,.kmz,.kml'
        style={{ display: 'none' }}
        onChange={page.handleUploadPointsSelected}
      />

      <input
        ref={page.uploadKmzInputRef}
        type='file'
        accept='application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,.kmz,.kml'
        style={{ display: 'none' }}
        onChange={page.handleKmzSelected}
      />

      <CreatePalitraDrawer
        open={page.createOpen}
        onClose={page.resetCreateFlow}
        onExited={page.onCreateDrawerExited}
        createInFlight={page.createInFlight}
        referenceDataReady={page.referenceDataReady}
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
        referenceDataReady={page.referenceDataReady}
        onSetEditForm={page.updateEditForm}
        onSave={page.handleEditSave}
      />
    </Box>
  );
}

export function RerPalitraNeoPage() {
  return (
    <TableStateProvider
      tableId='rer-palitra-neo'
      defaultColumnVisibility={DEFAULT_PALITRA_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_PALITRA_COLUMN_ORDER}
      defaultEnableColumnOrdering={false}
      defaultSorting={DEFAULT_PALITRA_SORTING}
    >
      <RerPalitraNeoPageBody />
    </TableStateProvider>
  );
}
