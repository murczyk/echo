import SettingsIcon from '@mui/icons-material/Settings';
import {
  Box,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { MRT_PaginationState } from 'material-react-table';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { PowerIconButton } from '../../components/PowerIconButton';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { OrbitUnitLinkDialog } from '../rer-unit-details/OrbitUnitLinkDialog';
import { DeleteUnitDialog, MergeUnitDialog } from './components/UnitActionDialogs';
import { KmzTaskStatus } from './components/KmzTaskStatus';
import { KmzUploadDialog } from './components/KmzUploadDialog';
import { UnitFormDrawer } from './components/UnitFormDrawer';
import { UnitsTable } from './components/UnitsTable';
import { UnitsPaginationControl } from './components/UnitsPaginationControl';
import { buildUnitsListReq, type UnitStatusFilter } from './helpers';
import { useRerUnitsPage } from './use-rer-units-page';
import { type UnitSearchMode } from './search-mode';

const FILTER_DEBOUNCE_MS = 500;

const DEFAULT_COLUMN_VISIBILITY = {
  name: true,
  other: false,
  teamOrCrew: false,
  section: false,
  squad: false,
  platoon: false,
  company: true,
  battalion: true,
  regiment: true,
  brigade: true,
  division: true,
  corps: false,
  army: true,
  militaryDistrict: false,
  armyRegion: false,
  createdAt: true,
  comment: true,
  hasOrbit: true,
  orbitUnitGenerativeNames: false,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'other',
  'teamOrCrew',
  'section',
  'squad',
  'platoon',
  'company',
  'battalion',
  'regiment',
  'brigade',
  'division',
  'corps',
  'army',
  'militaryDistrict',
  'armyRegion',
  'createdAt',
  'comment',
  'hasOrbit',
  'orbitUnitGenerativeNames',
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
        <PowerIconButton
          aria-label="Налаштування пошуку"
          aria-controls={menuOpen ? menuId : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : undefined}
          onClick={(event) => setAnchorElement(event.currentTarget)}
          sx={{
            width: 40,
            height: 40,
            border: '1px solid',
            borderColor: 'divider',
            borderLeft: 0,
            borderRadius: 0,
            backgroundColor: 'background.paper',
          }}
        >
          <SettingsIcon sx={{ fontSize: compact ? 20 : 18 }} />
        </PowerIconButton>
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
          <ListItemText>Точний пошук</ListItemText>
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
      <PowerButton variant="contained" onClick={onCreate} disabled={createDisabled}>
        Додати підрозділ
      </PowerButton>
      <PowerButton variant="outlined" disabled={kmzDisabled || uploadingKmz} onClick={onOpenKmz}>
        {uploadingKmz ? 'Підвантаження…' : 'Підвантажити KMZ'}
      </PowerButton>
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [delayMs, value]);

  return debouncedValue;
}

function RerUnitsNeoPageBody({
  authUserRoles,
  openCreate,
}: {
  authUserRoles: string[];
  openCreate: boolean;
}) {
  const tableState = useTableStateContext();
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down('lg'));
  const [kmzDialogOpen, setKmzDialogOpen] = useState(false);
  const [orbitLinkOpen, setOrbitLinkOpen] = useState(false);
  const [orbitLinkTransition, setOrbitLinkTransition] = useState(false);
  const [searchMode, setSearchMode] = useState<UnitSearchMode>('strict');
  const [statusFilter, setStatusFilter] = useState<UnitStatusFilter>('active');
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const debouncedGlobalFilter = useDebouncedValue(tableState.globalFilter, FILTER_DEBOUNCE_MS);
  const debouncedColumnFilters = useDebouncedValue(tableState.columnFilters, FILTER_DEBOUNCE_MS);
  const listReq = useMemo(
    () =>
      buildUnitsListReq({
        statusFilter,
        globalFilter: debouncedGlobalFilter,
        columnFilters: debouncedColumnFilters,
        sorting: tableState.sorting,
        searchMode,
        pagination,
      }),
    [
      debouncedColumnFilters,
      debouncedGlobalFilter,
      pagination,
      searchMode,
      statusFilter,
      tableState.sorting,
    ],
  );
  const page = useRerUnitsPage(authUserRoles, listReq);
  const createRequestHandled = useRef(false);
  const orbitTransitionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!openCreate) {
      createRequestHandled.current = false;
      return;
    }
    if (createRequestHandled.current || !page.canEdit || !page.settingsReady) return;
    createRequestHandled.current = true;
    page.openCreateDialog();
  }, [openCreate, page.canEdit, page.openCreateDialog, page.settingsReady]);

  const clearOrbitTransitionTimer = () => {
    if (orbitTransitionTimerRef.current === null) return;
    window.clearTimeout(orbitTransitionTimerRef.current);
    orbitTransitionTimerRef.current = null;
  };

  useEffect(() => clearOrbitTransitionTimer, []);

  useEffect(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, [
    searchMode,
    statusFilter,
    tableState.columnFilters,
    tableState.globalFilter,
    tableState.sorting,
  ]);

  useEffect(() => {
    setPagination((current) => {
      const lastPageIndex = Math.max(0, Math.ceil(page.totalCount / current.pageSize) - 1);
      return current.pageIndex > lastPageIndex ? { ...current, pageIndex: lastPageIndex } : current;
    });
  }, [page.totalCount]);

  const changeStatusFilter = (status: UnitStatusFilter) => {
    setPagination((current) => ({ ...current, pageIndex: 0 }));
    setStatusFilter(status);
  };

  const openOrbitLinkDialog = () => {
    clearOrbitTransitionTimer();
    setOrbitLinkTransition(true);
    orbitTransitionTimerRef.current = window.setTimeout(() => {
      orbitTransitionTimerRef.current = null;
      setOrbitLinkOpen(true);
    }, 0);
  };

  const closeOrbitLinkDialog = () => {
    clearOrbitTransitionTimer();
    setOrbitLinkOpen(false);
    orbitTransitionTimerRef.current = window.setTimeout(() => {
      orbitTransitionTimerRef.current = null;
      setOrbitLinkTransition(false);
    }, 0);
  };

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
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 w-full sm:w-[360px] sm:max-w-full">
                <GlobalFilterTextField
                  globalFilter={tableState.globalFilter}
                  setGlobalFilter={tableState.onChangeGlobalFilter}
                  disabled={page.loadError !== null}
                />
                <SearchModeSettingsButton
                  compact={isSmallScreen}
                  searchMode={searchMode}
                  onSearchModeChange={setSearchMode}
                />
              </div>
              <UnitStatusFilters
                status={statusFilter}
                counts={page.statusCounts}
                onChange={changeStatusFilter}
              />
            </div>
          }
          hideGlobalTextFilter={page.loading || page.loadError !== null}
          internalActionsDisabled={page.loading || page.loadError !== null}
          leadingInternalActions={
            <UnitsPaginationControl
              pageIndex={pagination.pageIndex}
              pageSize={pagination.pageSize}
              totalCount={page.totalCount}
              loading={page.loading || page.loadError !== null}
              onPrevPage={() =>
                setPagination((current) => ({
                  ...current,
                  pageIndex: Math.max(0, current.pageIndex - 1),
                }))
              }
              onNextPage={() =>
                setPagination((current) => ({
                  ...current,
                  pageIndex: current.pageIndex + 1,
                }))
              }
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
              units={page.units}
              totalCount={page.totalCount}
              attachmentUnitIds={page.attachmentUnitIds}
              loading={page.loading}
              canEdit={page.canEdit}
              actionInFlight={page.submitting}
              onEdit={page.openEditDialog}
              onDelete={page.openDeleteDialog}
              onMerge={page.openMergeDialog}
              searchMode={searchMode}
              onSearchModeChange={setSearchMode}
              pagination={pagination}
              onPaginationChange={setPagination}
            />
          )}
        </Box>
      </Stack>

      <UnitFormDrawer
        open={page.createOpen}
        unit={null}
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
      <UnitFormDrawer
        open={page.editUnit !== null}
        suspended={orbitLinkTransition}
        unit={page.editUnit}
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
        onLinkOrbitUnit={openOrbitLinkDialog}
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
        submitting={page.submitting}
        progress={page.mergeProgress}
        progressLabel={page.mergeProgressLabel}
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
          unit={page.editUnit}
          onClose={closeOrbitLinkDialog}
          onLinked={() => {
            closeOrbitLinkDialog();
            void page.refreshLinkedEditOrbitUnit();
          }}
        />
      ) : null}
    </Box>
  );
}

export function RerUnitsNeoPage({
  authUserRoles = [],
  openCreate = false,
}: { authUserRoles?: string[]; openCreate?: boolean } = {}) {
  return (
    <TableStateProvider
      tableId="rer-units-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultSorting={[{ id: 'name', desc: false }]}
      defaultEnableColumnOrdering={false}
    >
      <RerUnitsNeoPageBody authUserRoles={authUserRoles} openCreate={openCreate} />
    </TableStateProvider>
  );
}
