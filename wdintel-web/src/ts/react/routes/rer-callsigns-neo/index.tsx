import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { Badge, Box, Button, CircularProgress, IconButton, Paper, Stack, Tooltip, useMediaQuery } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';

import { BulkDeleteConfirmDialog } from '../../components/BulkDeleteConfirmDialog';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { CreateCallsignsDrawer } from './components/CreateCallsignsDrawer';
import { CallsignsDateInputs, CallsignsFiltersTopRow } from './components/CallsignsFilters';
import {
  CallsignsTable,
  DEFAULT_CALLSIGNS_TABLE_COLUMN_ORDER,
  DEFAULT_CALLSIGNS_TABLE_COLUMN_VISIBILITY,
} from './components/CallsignsTable';
import { DeleteCallsignDialog } from './components/DeleteCallsignDialog';
import { EditCallsignDrawer } from './components/EditCallsignDrawer';
import { UnitStatsSidebar } from './components/UnitStatsSidebar';
import { DESKTOP_LAYOUT_MIN_WIDTH_PX, getExportPermissionFromRoles } from './helpers';
import { useRerCallsignsNeoPage } from './use-rer-callsigns-neo-page';
import { PowerAlert } from '../../components/PowerAlert';

type SidebarToggleRailProps = {
  open: boolean;
  hasActiveUnitFilter: boolean;
  onToggleOpen: () => void;
};

function SidebarToggleRail({ open, hasActiveUnitFilter, onToggleOpen }: SidebarToggleRailProps) {
  return (
    <Paper
      variant="outlined"
      sx={{
        width: 56,
        minWidth: 56,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 0,
        py: 0,
        borderRadius: 0,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      <Tooltip title={open ? 'Сховати підрозділи' : 'Показати підрозділи'} arrow placement="right">
        <IconButton
          size="small"
          onClick={onToggleOpen}
          aria-label={open ? 'Сховати підрозділи' : 'Показати підрозділи'}
          sx={{ width: 56, height: 56, p: 0, borderRadius: 0 }}
        >
          {open ? (
            <ChevronLeftOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          ) : (
            <ChevronRightOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          )}
        </IconButton>
      </Tooltip>
      <Box sx={{ width: 56, borderBottom: '1px solid', borderColor: 'divider' }} />
      <Tooltip title={hasActiveUnitFilter ? 'Є активний фільтр підрозділу' : 'Фільтр підрозділу'} arrow placement="right">
        <Box
          sx={{
            pt: 1.25,
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Badge color="error" variant="dot" invisible={!hasActiveUnitFilter}>
            <FilterAltOutlinedIcon
              sx={{ fontSize: 20, color: hasActiveUnitFilter ? 'primary.main' : 'text.secondary' }}
            />
          </Badge>
        </Box>
      </Tooltip>
    </Paper>
  );
}

function RerCallsignsNeoPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useRerCallsignsNeoPage({ authUserRoles });
  const isDesktopLayout = useMediaQuery(`(min-width:${DESKTOP_LAYOUT_MIN_WIDTH_PX}px)`);
  const shellPermissions = getExportPermissionFromRoles(authUserRoles);
  const controlsDisabled = page.loading || page.addSubmitting || page.editSubmitting || page.deleteSubmitting;
  const filtersDisabled = page.loading || page.addSubmitting || page.editSubmitting || page.deleteSubmitting;
  const showExportButtons = shellPermissions.canExport || page.permissions.canExport;
  const showExportPlaceholders = page.loading && !showExportButtons;
  const hasActiveUnitFilter = page.selectedSidebarUnitFilter !== null || page.filters.filterUnit.trim() !== '';
  const hasActiveFilters =
    page.filters.filterText.trim() !== '' ||
    page.filters.filterCallsign.trim() !== '' ||
    page.filters.filterPosition.trim() !== '' ||
    page.filters.filterFullName.trim() !== '' ||
    page.filters.filterComment.trim() !== '' ||
    page.filters.filterUnit.trim() !== '' ||
    page.selectedSidebarUnitFilter !== null ||
    page.filters.filterDeveloping !== 'OnlyNonDeveloping' ||
    !page.filters.isIgnoringDateFilter;
  const exportActions = showExportButtons || showExportPlaceholders ? (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button
        startIcon={page.downloadInProgress === 'csv' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        onClick={page.onDownloadCsv}
        disabled={showExportPlaceholders || controlsDisabled || page.downloadInProgress !== null}
        variant="outlined"
        aria-label={page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
        title={page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
      </Button>
      <Button
        startIcon={page.downloadInProgress === 'xlsx' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        onClick={page.onDownloadXlsx}
        disabled={showExportPlaceholders || controlsDisabled || page.downloadInProgress !== null}
        variant="outlined"
        aria-label={page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
        title={page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
      </Button>
    </Stack>
  ) : null;
  const mergedExportActions = showExportButtons || showExportPlaceholders ? (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'nowrap' }}>
      <Button
        startIcon={page.downloadInProgress === 'csv' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        onClick={page.onDownloadCsv}
        disabled={showExportPlaceholders || controlsDisabled || page.downloadInProgress !== null}
        variant="outlined"
        aria-label={page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
        title={page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {page.downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
      </Button>
      <Button
        startIcon={page.downloadInProgress === 'xlsx' ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        onClick={page.onDownloadXlsx}
        disabled={showExportPlaceholders || controlsDisabled || page.downloadInProgress !== null}
        variant="outlined"
        aria-label={page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
        title={page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {page.downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
      </Button>
    </Stack>
  ) : null;
  const whiteActions = (
    <InternalTableActions
      densityDisabled={page.loading}
      columnsVisibilityDisabled={page.loading}
      filtersDisabled={page.loading}
      additionalActiveFilters={[
        ...(page.filters.filterText.trim()
          ? [
              {
                id: 'page-filter-text',
                label: 'Пошук',
                value: page.filters.filterText.trim(),
                valuePreview: page.filters.filterText.trim(),
                isGlobalFilter: false,
              },
            ]
          : []),
        ...(page.selectedSidebarUnitFilter
          ? [
              {
                id: 'page-unit',
                label: 'Підрозділ',
                value: page.selectedSidebarUnitFilter.kind === 'leaf' ? page.selectedSidebarUnitFilter.unitName : page.selectedSidebarUnitFilter.label,
                valuePreview: page.selectedSidebarUnitFilter.kind === 'leaf' ? page.selectedSidebarUnitFilter.unitName : page.selectedSidebarUnitFilter.label,
                isGlobalFilter: false,
              },
            ]
          : page.filters.filterUnit.trim()
            ? [
                {
                  id: 'page-unit',
                  label: 'Підрозділ',
                  value: page.filters.filterUnit.trim(),
                  valuePreview: page.filters.filterUnit.trim(),
                  isGlobalFilter: false,
                },
              ]
            : []),
      ]}
      onClearAdditionalActiveFilter={(filterId) => {
        if (filterId === 'page-unit') {
          page.onClearUnitFilter();
        }
        if (filterId === 'page-filter-text') {
          page.onFiltersChange((prev) => ({
            ...prev,
            filterText: '',
          }));
        }
      }}
      onClearAdditionalActiveFilters={page.onClearFilters}
      fullScreenEnabled
      fullScreenDisabled={page.loading}
    />
  );

  return (
    <Box className="w-full" sx={{ height: isDesktopLayout ? '100%' : 'auto', minHeight: 0, overflow: isDesktopLayout ? 'hidden' : 'visible' }}>
      <Stack
        spacing={3}
        useFlexGap
        sx={{ height: isDesktopLayout ? '100%' : 'auto', minHeight: 0, overflow: isDesktopLayout ? 'hidden' : 'visible' }}
      >
        <TablePageToolbar
          title="Позивні"
          internalActionsHidden
          actions={page.permissions.canEdit ? (
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
          ) : undefined}
        />

        {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}

        <Stack
          direction={isDesktopLayout ? 'row' : 'column'}
          spacing={2}
          useFlexGap
          sx={{
            flex: 1,
            minHeight: isDesktopLayout ? 0 : 'auto',
            alignItems: 'stretch',
          }}
        >
          {isDesktopLayout ? (
            <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0, flexShrink: 0 }}>
              <UnitStatsSidebar
                stats={page.unitStatsView}
                open={page.sidebarOpen}
                isDesktopLayout={isDesktopLayout}
                loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
                onPickUnitFilter={page.onPickUnitFilter}
                selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
              />
              <SidebarToggleRail
                open={page.sidebarOpen}
                hasActiveUnitFilter={hasActiveUnitFilter}
                onToggleOpen={() => page.setSidebarOpen((prev: boolean) => !prev)}
              />
            </Box>
          ) : (
            <UnitStatsSidebar
              stats={page.unitStatsView}
              open={page.sidebarOpen}
              isDesktopLayout={isDesktopLayout}
              loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
              onPickUnitFilter={page.onPickUnitFilter}
              onToggleOpen={() => page.setSidebarOpen((prev: boolean) => !prev)}
              selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
            />
          )}

          <Stack spacing={2} useFlexGap sx={{ flex: 1, minWidth: 0, minHeight: isDesktopLayout ? 0 : 'auto' }}>
            <Stack
              spacing={2}
              useFlexGap
              sx={{
                display: isDesktopLayout ? 'flex' : 'none',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  minWidth: 0,
                  flexWrap: 'wrap',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    minWidth: 0,
                    flex: '1 1 auto',
                    flexWrap: 'nowrap',
                  }}
                >
                  <CallsignsFiltersTopRow
                    filters={page.filters}
                    filtersDisabled={filtersDisabled}
                    onFiltersChange={page.onFiltersChange}
                  />
                  <CallsignsDateInputs
                    isDesktopLayout={isDesktopLayout}
                    filters={page.filters}
                    filtersDisabled={filtersDisabled}
                    onFiltersChange={page.onFiltersChange}
                  />
                </Box>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    ml: 'auto',
                    flex: '0 0 auto',
                  }}
                >
                  <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'nowrap' }}>
                    {mergedExportActions}
                  </Stack>
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>{whiteActions}</Box>
                </Box>
              </Box>
            </Stack>
            <Stack
              spacing={2}
              useFlexGap
              sx={{
                display: isDesktopLayout ? 'none' : 'flex',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  minWidth: 0,
                  flexWrap: 'wrap',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    minWidth: 0,
                    flex: '1 1 auto',
                    flexWrap: 'nowrap',
                  }}
                >
                  <CallsignsFiltersTopRow
                    filters={page.filters}
                    filtersDisabled={filtersDisabled}
                    onFiltersChange={page.onFiltersChange}
                  />
                  <CallsignsDateInputs
                    isDesktopLayout={isDesktopLayout}
                    filters={page.filters}
                    filtersDisabled={filtersDisabled}
                    onFiltersChange={page.onFiltersChange}
                  />
                </Box>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    minWidth: 0,
                    ml: 'auto',
                    flex: '0 0 auto',
                  }}
                >
                  {exportActions}
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>{whiteActions}</Box>
                </Box>
              </Box>
            </Stack>
            <Box sx={{ flex: 1, minHeight: isDesktopLayout ? 0 : 'auto' }}>
              <CallsignsTable
                canEdit={page.permissions.canEdit}
                rows={page.rows}
                loading={page.loading}
                refreshing={page.refreshing}
                loadingMore={page.loadingMore}
                showLoadMore={page.showLoadMore}
                hasActiveFilters={hasActiveFilters}
                textFilters={{
                  filterCallsign: page.filters.filterCallsign,
                  filterPosition: page.filters.filterPosition,
                  filterFullName: page.filters.filterFullName,
                  filterComment: page.filters.filterComment,
                  filterUnit: page.filters.filterUnit,
                }}
                inFlightDeleteId={page.deleteInFlightId}
                bulkDeleteInFlight={page.bulkDeleteInFlight}
                selectedCallsignIds={page.selectedCallsignIds}
                sort={page.sort}
                statusFilter={page.filters.filterDeveloping}
                onSort={page.onSort}
                onStatusFilterChange={(filterDeveloping) => page.onFiltersChange((prev) => ({ ...prev, filterDeveloping }))}
                onTextColumnFiltersChange={(nextTextFilters) =>
                  page.onFiltersChange((prev) => ({
                    ...prev,
                    ...nextTextFilters,
                  }))
                }
                onClearFilters={page.onClearFilters}
                onSetSelectedCallsignIds={page.setSelectedCallsignIds}
                onLoadMore={page.onLoadMore}
                onEdit={page.onOpenEdit}
                onDelete={page.onRequestDelete}
              />
            </Box>
          </Stack>
        </Stack>
      </Stack>

      <CreateCallsignsDrawer
        open={page.addDrawerOpen}
        onClose={page.onCloseAddDrawer}
        units={page.units}
        sources={page.sources}
        addUnitId={page.addUnitId}
        addSourceId={page.addSourceId}
        addCallsignAdditionalSourceIds={page.addCallsignAdditionalSourceIds}
        rows={page.addRows}
        submitting={page.addSubmitting}
        disabled={!page.permissions.canEdit}
        validationError={page.addValidationError}
        duplicateHints={page.addPotentialDuplicates}
        onAddUnitIdChange={page.setAddUnitId}
        onAddSourceIdChange={page.setAddSourceId}
        onAddCallsignAdditionalSourceIdsChange={page.setAddCallsignAdditionalSourceIds}
        onRowChange={page.onRowChange}
        onAppendRow={page.onAppendRow}
        onRemoveRow={page.onRemoveRow}
        onClearRows={page.onClearRows}
        onApplyPastedRows={page.onApplyPastedRows}
        onSubmit={page.onSubmitAdd}
      />

      <EditCallsignDrawer
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

export function RerCallsignsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  return (
    <TableStateProvider
      tableId="rer-callsigns-neo"
      defaultColumnVisibility={DEFAULT_CALLSIGNS_TABLE_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_CALLSIGNS_TABLE_COLUMN_ORDER}
      defaultEnableColumnOrdering={false}
    >
      <RerCallsignsNeoPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
