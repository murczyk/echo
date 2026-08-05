import AddIcon from '@mui/icons-material/Add';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { Box, Button, Stack } from '@mui/material';
import { useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerChip } from '../../components/PowerChip';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { OrbitUnitLinkDialog } from '../rer-unit-details/OrbitUnitLinkDialog';
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
  orbitNote: true,
  hasOrbit: true,
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
  'orbitNote',
  'hasOrbit',
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

function UnitStatusFilters({
  status,
  counts,
  onChange,
}: {
  status: 'all' | 'active' | 'inactive';
  counts: { active: number; inactive: number };
  onChange: (status: 'all' | 'active' | 'inactive') => void;
}) {
  const statusLabel = (color: string, label: string, count: number) => (
    <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
      <Box component="span">{`${label} ${count}`}</Box>
    </Stack>
  );

  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <PowerChip
        selected={status === 'all'}
        onClick={() => onChange('all')}
        label="Всі"
        interactive
        fontWeight={700}
      />
      <PowerChip
        selected={status === 'active'}
        onClick={() => onChange('active')}
        label={statusLabel('#54c06c', 'Активні', counts.active)}
        interactive
        fontWeight={700}
      />
      <PowerChip
        selected={status === 'inactive'}
        onClick={() => onChange('inactive')}
        label={statusLabel('#bfbfbf', 'Неактивні', counts.inactive)}
        interactive
        fontWeight={700}
      />
    </Stack>
  );
}

function RerUnitsNeoPageBody({ authUserRoles }: { authUserRoles: string[] }) {
  const page = useRerUnitsPage(authUserRoles);
  const [kmzDialogOpen, setKmzDialogOpen] = useState(false);
  const [orbitLinkOpen, setOrbitLinkOpen] = useState(false);

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
          filter={
            <UnitStatusFilters
              status={page.statusFilter}
              counts={page.statusCounts}
              onChange={page.setStatusFilter}
            />
          }
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
              units={page.visibleUnits}
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
        orbitUnits={[]}
        orbitLinksLoading={false}
        orbitLinksError={null}
        canLinkOrbitUnit={false}
        unlinkingOrbitUnitId={null}
        onClose={page.closeDialogs}
        onSubmit={(value) => void page.submitUnit(value)}
        onLinkOrbitUnit={() => undefined}
        onUnlinkOrbitUnit={() => undefined}
      />
      <UnitFormDialog
        open={page.editUnit !== null}
        unit={page.editUnit}
        units={page.units}
        devicesSectionEnabled={false}
        submitting={page.submitting}
        error={page.dialogError}
        orbitUnits={page.editOrbitUnits}
        orbitLinksLoading={page.orbitLinksLoading}
        orbitLinksError={page.orbitLinksError}
        canLinkOrbitUnit={page.canLinkEditOrbitUnit}
        unlinkingOrbitUnitId={page.unlinkingOrbitUnitId}
        onClose={page.closeDialogs}
        onSubmit={(value) => void page.submitUnit(value)}
        onLinkOrbitUnit={() => setOrbitLinkOpen(true)}
        onUnlinkOrbitUnit={(orbitUnit) => void page.unlinkEditOrbitUnit(orbitUnit)}
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
      {orbitLinkOpen && page.editUnit !== null ? (
        <OrbitUnitLinkDialog
          unitId={page.editUnit.id}
          onClose={() => setOrbitLinkOpen(false)}
          onLinked={() => {
            setOrbitLinkOpen(false);
            void page.refreshLinkedEditOrbitUnit();
          }}
        />
      ) : null}
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
