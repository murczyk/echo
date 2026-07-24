import AddIcon from '@mui/icons-material/Add';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { Box, Button, Stack } from '@mui/material';
import { useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { DeleteUnitDialog, MergeUnitDialog } from './components/UnitActionDialogs';
import { KmzTaskStatus } from './components/KmzTaskStatus';
import { KmzUploadDialog } from './components/KmzUploadDialog';
import { UnitFormDialog } from './components/UnitFormDialog';
import { UnitsTable } from './components/UnitsTable';
import { useRerUnitsPage } from './use-rer-units-page';

const DEFAULT_COLUMN_VISIBILITY = {
  name: true,
  company: true,
  battalion: true,
  regiment: true,
  division: true,
  army: true,
  createdAt: true,
  comment: true,
  active: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'company',
  'battalion',
  'regiment',
  'division',
  'army',
  'createdAt',
  'comment',
  'active',
];

function PageActions({
  canEdit,
  createDisabled,
  kmzDisabled,
  uploadingKmz,
  onCreate,
  onOpenKmz,
}: {
  canEdit: boolean;
  createDisabled: boolean;
  kmzDisabled: boolean;
  uploadingKmz: boolean;
  onCreate: () => void;
  onOpenKmz: () => void;
}) {
  if (!canEdit) return null;

  return (
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={onCreate}
        disabled={createDisabled}
      >
        Додати підрозділ
      </Button>
      <Button
        variant="outlined"
        startIcon={<UploadFileIcon />}
        disabled={kmzDisabled || uploadingKmz}
        onClick={onOpenKmz}
      >
        {uploadingKmz ? 'Підвантаження…' : 'Підвантажити KMZ…'}
      </Button>
    </Stack>
  );
}

function RerUnitsNeoPageBody({ authUserRoles }: { authUserRoles: string[] }) {
  const page = useRerUnitsPage(authUserRoles);
  const [kmzDialogOpen, setKmzDialogOpen] = useState(false);

  return (
    <Box
      sx={{
        height: { xs: 'auto', lg: '100%' },
        minHeight: 0,
        overflow: { xs: 'visible', lg: 'hidden' },
      }}
    >
      <Stack
        spacing={3}
        sx={{
          height: { xs: 'auto', lg: '100%' },
          minHeight: 0,
          overflow: { xs: 'visible', lg: 'hidden' },
        }}
      >
        <TablePageToolbar
          title="Підрозділи противника"
          withGlobalTextFilter
          hideGlobalTextFilter={page.loading || page.loadError !== null}
          internalActionsDisabled={page.loading || page.loadError !== null}
          actions={
            <PageActions
              canEdit={page.canEdit}
              createDisabled={
                page.loading || page.loadError !== null || page.submitting || !page.settingsReady
              }
              kmzDisabled={page.loading || page.loadError !== null || page.submitting}
              uploadingKmz={page.uploadingKmz}
              onCreate={page.openCreateDialog}
              onOpenKmz={() => setKmzDialogOpen(true)}
            />
          }
        />

        {page.status ? (
          <PowerAlert severity={page.status.severity}>{page.status.text}</PowerAlert>
        ) : null}
        {page.kmzTask ? <KmzTaskStatus task={page.kmzTask} /> : null}

        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
          {page.loadError !== null ? (
            <PageErrorState
              message={`Не вдалося завантажити підрозділи: ${page.loadError}`}
              actionLabel="Повторити"
              onAction={() => void page.loadUnits()}
              minHeight={0}
            />
          ) : (
            <UnitsTable
              units={page.units}
              attachmentUnitIds={page.attachmentUnitIds}
              loading={page.loading}
              canEdit={page.canEdit}
              actionInFlight={page.submitting}
              onEdit={page.openEditDialog}
              onDelete={page.openDeleteDialog}
              onMerge={page.openMergeDialog}
            />
          )}
        </Box>
      </Stack>

      <UnitFormDialog
        open={page.createOpen}
        unit={null}
        units={page.units}
        devicesSectionEnabled={page.devicesSectionEnabled}
        submitting={page.submitting}
        error={page.dialogError}
        onClose={page.closeDialogs}
        onSubmit={(value) => void page.submitUnit(value)}
      />
      <UnitFormDialog
        open={page.editUnit !== null}
        unit={page.editUnit}
        units={page.units}
        devicesSectionEnabled={false}
        submitting={page.submitting}
        error={page.dialogError}
        onClose={page.closeDialogs}
        onSubmit={(value) => void page.submitUnit(value)}
      />
      <DeleteUnitDialog
        unit={page.deleteTarget}
        submitting={page.submitting}
        error={page.dialogError}
        onClose={page.closeDialogs}
        onConfirm={() => void page.confirmDelete()}
      />
      <MergeUnitDialog
        original={page.mergeTarget}
        units={page.units}
        submitting={page.submitting}
        error={page.dialogError}
        onClose={page.closeDialogs}
        onConfirm={(duplicate) => void page.confirmMerge(duplicate)}
      />
      <KmzUploadDialog
        open={kmzDialogOpen}
        uploading={page.uploadingKmz}
        onClose={() => setKmzDialogOpen(false)}
        onUpload={(file) => void page.uploadKmz(file)}
      />
    </Box>
  );
}

export function RerUnitsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  return (
    <TableStateProvider
      tableId="rer-units-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultSorting={[{ id: 'name', desc: false }]}
      defaultEnableColumnOrdering={false}
    >
      <RerUnitsNeoPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
