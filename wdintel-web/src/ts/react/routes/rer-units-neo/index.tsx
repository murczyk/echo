import AddIcon from '@mui/icons-material/Add';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  Box,
  Button,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerChip } from '../../components/PowerChip';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { OrbitUnitLinkDialog } from '../rer-unit-details/OrbitUnitLinkDialog';
import { DeleteUnitDialog, MergeUnitDialog } from './components/UnitActionDialogs';
import { KmzTaskStatus } from './components/KmzTaskStatus';
import { KmzUploadDialog } from './components/KmzUploadDialog';
import { UnitFormDialog } from './components/UnitFormDialog';
import { UnitsTable } from './components/UnitsTable';
import { useRerUnitsPage } from './use-rer-units-page';
import { type UnitSearchMode } from './search-mode';

const DEFAULT_COLUMN_VISIBILITY = {
  name: true,
  company: true,
  battalion: true,
  regiment: true,
  division: true,
  army: true,
  militaryDistrict: true,
  armyRegion: true,
  createdAt: true,
  comment: true,
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
  'militaryDistrict',
  'armyRegion',
  'createdAt',
  'comment',
  'hasOrbit',
];

function SearchModeSettingsButton({
  compact,
  searchMode,
  onSearchModeChange,
}: {
  compact: boolean;
  searchMode: UnitSearchMode;
  onSearchModeChange: (searchMode: UnitSearchMode) => void;
}) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const menuOpen = Boolean(anchorElement);
  const menuId = 'unit-search-mode-menu';

  const closeMenu = () => {
    setAnchorElement(null);
  };

  const changeMode = (mode: UnitSearchMode) => {
    onSearchModeChange(mode);
    closeMenu();
  };

  return (
    <>
      <Tooltip title="Налаштування пошуку" arrow>
        <IconButton
          aria-label="Налаштування пошуку"
          aria-controls={menuOpen ? menuId : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : undefined}
          onClick={(event) => setAnchorElement(event.currentTarget)}
          sx={{
            width: compact ? 40 : 32,
            height: compact ? 40 : 32,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: compact ? 20 : 18 }} />
        </IconButton>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchorElement}
        open={menuOpen}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { 'aria-label': 'Налаштування пошуку' } }}
      >
        <MenuItem
          role="menuitemradio"
          aria-checked={searchMode === 'strict'}
          selected={searchMode === 'strict'}
          onClick={() => changeMode('strict')}
        >
          <ListItemText>Строгий пошук</ListItemText>
        </MenuItem>
        <MenuItem
          role="menuitemradio"
          aria-checked={searchMode === 'relaxed'}
          selected={searchMode === 'relaxed'}
          onClick={() => changeMode('relaxed')}
        >
          <ListItemText>Нечіткий пошук</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

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
  const tableState = useTableStateContext();
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down('lg'));
  const [kmzDialogOpen, setKmzDialogOpen] = useState(false);
  const [orbitLinkOpen, setOrbitLinkOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<UnitSearchMode>('strict');

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
          withGlobalTextFilter={false}
          filter={
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%', minWidth: 0 }}
              >
                <GlobalFilterTextField
                  globalFilter={tableState.globalFilter}
                  setGlobalFilter={tableState.onChangeGlobalFilter}
                  disabled={page.loading || page.loadError !== null}
                />
                <SearchModeSettingsButton
                  compact={isSmallScreen}
                  searchMode={searchMode}
                  onSearchModeChange={setSearchMode}
                />
              </Stack>
              <UnitStatusFilters
                status={page.statusFilter}
                counts={page.statusCounts}
                onChange={page.setStatusFilter}
              />
            </Stack>
          }
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
              units={page.visibleUnits}
              attachmentUnitIds={page.attachmentUnitIds}
              loading={page.loading}
              canEdit={page.canEdit}
              actionInFlight={page.submitting}
              onEdit={page.openEditDialog}
              onDelete={page.openDeleteDialog}
              onMerge={page.openMergeDialog}
              searchMode={searchMode}
              onSearchModeChange={setSearchMode}
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
