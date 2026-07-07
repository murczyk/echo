import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import RestoreIcon from '@mui/icons-material/Restore';
import {
  Box,
  IconButton,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useState } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { navigateWithinSpa } from '../../utils/browser';
import { DeviceUpsertDrawer } from '../devices/components/DeviceUpsertDrawer';
import { DeviceDetailsLeftPanel } from './components/DeviceDetailsLeftPanel';
import { DeviceDetailsTabPanel, type DeviceDetailsTab } from './components/DeviceDetailsTabPanel';
import { DeviceFileBatchCreateDialog } from './components/DeviceFileBatchCreateDialog';
import { DeviceFilesSection } from './components/DeviceFilesSection';
import { fileDisplayName, formatDeviceLifecycleLabel } from './helpers';
import { useDeviceDetailsPage } from './use-device-details-page';
import { useDeviceFiles } from './use-device-files';

function DeviceHeaderTitle({
  deviceName,
  archived,
}: {
  deviceName: string | null;
  archived: boolean;
}) {
  const lifecycleLabel = formatDeviceLifecycleLabel(archived);

  return (
    <Box
      component="span"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, lineHeight: 'inherit' }}
    >
      <Tooltip title="До списку пристроїв" arrow placement="bottom-start">
        <IconButton
          aria-label="До списку пристроїв"
          onClick={() => navigateWithinSpa('/devices')}
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {deviceName === null ? (
        <Skeleton width={240} />
      ) : (
        <>
          <Tooltip title={lifecycleLabel} arrow placement="bottom-start">
            <Box
              component="span"
              aria-label={lifecycleLabel}
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: archived ? 'warning.main' : 'success.main',
                flexShrink: 0,
                cursor: 'default',
              }}
            />
          </Tooltip>
          <Box
            component="span"
            sx={{ display: 'block', minWidth: 0, lineHeight: 'inherit', overflowWrap: 'anywhere' }}
          >
            {deviceName}
          </Box>
        </>
      )}
    </Box>
  );
}

export function DeviceDetailsPage({
  deviceId,
  authUserRoles = [],
}: {
  deviceId: string;
  authUserRoles?: string[];
}) {
  const page = useDeviceDetailsPage({ deviceId, authUserRoles });
  const files = useDeviceFiles({
    deviceId,
    canRead: page.permissions.canRead,
    canEdit: page.permissions.canEdit,
    parentArchived: page.device?.archived ?? false,
  });
  const isMobileLayout = useMediaQuery((theme) => theme.breakpoints.down('sm'));
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<DeviceDetailsTab>('description');
  const [actionsMenuAnchorEl, setActionsMenuAnchorEl] = useState<HTMLElement | null>(null);

  if (!page.permissions.canRead) {
    return <PageErrorState message="Немає доступу до пристроїв." minHeight="100%" />;
  }

  if (page.initialLoadFailed) {
    return (
      <PageErrorState
        message={page.status?.text ?? 'Помилка завантаження пристрою.'}
        actionLabel="Спробувати ще раз"
        onAction={() => void page.reload()}
        minHeight="100%"
      />
    );
  }

  const device = page.device;
  const showEditAction = page.permissions.canEdit && device !== null && !device.archived;
  const showArchiveAction = page.permissions.canEdit && device !== null && !device.archived;
  const showRestoreAction = page.permissions.canEdit && device !== null && device.archived;
  const leftPanelVisible = isMobileLayout || leftPanelOpen;
  const sidePanelLabel = leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель';
  const actionsMenuOpen = actionsMenuAnchorEl !== null;
  const actionsDisabled = page.mutating || page.editSubmitting;

  function closeActionsMenu() {
    setActionsMenuAnchorEl(null);
  }

  function openEditDrawer() {
    closeActionsMenu();
    page.openEditDrawer();
  }

  function openArchiveDialog() {
    closeActionsMenu();
    page.openArchiveDialog();
  }

  function restoreDevice() {
    closeActionsMenu();
    void page.restoreCurrentDevice();
  }

  const filesPanel = device ? (
    <DeviceFilesSection
      files={files.files}
      deletedFilter={files.deletedFilter}
      total={files.total}
      hasMore={files.hasMore}
      loading={files.loading}
      refreshing={files.refreshing}
      loadingMore={files.loadingMore}
      status={files.status}
      mutatingFileId={files.mutatingFileId}
      canEdit={page.permissions.canEdit}
      parentArchived={device.archived}
      hasFilters={files.hasFilters}
      onDeletedFilterChange={files.setDeletedFilter}
      onCreate={files.openCreateDialog}
      onReload={files.reload}
      onLoadMore={files.loadMore}
      onDelete={files.deleteFile}
      onRestore={files.restoreFile}
    />
  ) : null;

  return (
    <Box
      sx={{
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title={
          <DeviceHeaderTitle
            deviceName={device?.name ?? null}
            archived={device?.archived ?? false}
          />
        }
        titleLeadingActions={
          !isMobileLayout ? (
            <SidePanelToggleButton
              side="left"
              active={leftPanelVisible}
              label={sidePanelLabel}
              onClick={() => setLeftPanelOpen((current) => !current)}
            />
          ) : null
        }
        titleLeadingGap={2}
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title="Дії">
              <IconButton
                onClick={(event) => setActionsMenuAnchorEl(event.currentTarget)}
                aria-haspopup="true"
                aria-controls={actionsMenuOpen ? 'device-details-actions-menu' : undefined}
                aria-label="Дії з пристроєм"
              >
                <MoreVertOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              id="device-details-actions-menu"
              open={actionsMenuOpen}
              anchorEl={actionsMenuAnchorEl}
              onClose={closeActionsMenu}
            >
              {device?.archived ? (
                <MenuItem
                  onClick={restoreDevice}
                  disabled={!showRestoreAction || actionsDisabled}
                  sx={{ color: showRestoreAction ? 'primary.main' : undefined }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <RestoreIcon fontSize="small" />
                    <span>Відновити</span>
                  </Stack>
                </MenuItem>
              ) : (
                <>
                  <MenuItem onClick={openEditDrawer} disabled={!showEditAction || actionsDisabled}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <EditIcon fontSize="small" />
                      <span>Редагувати</span>
                    </Stack>
                  </MenuItem>
                  <MenuItem
                    onClick={openArchiveDialog}
                    disabled={!showArchiveAction || actionsDisabled}
                    sx={{ color: showArchiveAction ? 'error.main' : undefined }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <ArchiveOutlinedIcon fontSize="small" />
                      <span>Архівувати</span>
                    </Stack>
                  </MenuItem>
                </>
              )}
            </Menu>
          </Stack>
        }
      />

      {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}
      {device?.archived ? (
        <PowerAlert severity="warning" autoHideDuration={null}>
          Пристрій архівовано. Редактори можуть відновити пристрій; життєвий цикл файлів заблоковано
          до відновлення.
        </PowerAlert>
      ) : null}

      <Box
        sx={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        {page.loading && device === null ? (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gap: 2,
              gridTemplateColumns: {
                xs: '1fr',
                lg: leftPanelVisible ? 'minmax(360px, 420px) minmax(0,1fr)' : 'minmax(0,1fr)',
              },
              overflow: 'hidden',
            }}
          >
            {leftPanelVisible ? (
              <Box sx={{ minHeight: 0, overflow: 'auto' }}>
                <DeviceDetailsLeftPanel device={null} loading={page.loading} />
              </Box>
            ) : null}
            <PageLoadingState minHeight="100%" />
          </Box>
        ) : device ? (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gap: 2,
              gridTemplateColumns: {
                xs: '1fr',
                lg: leftPanelVisible ? 'minmax(360px, 420px) minmax(0,1fr)' : 'minmax(0,1fr)',
              },
              overflow: 'hidden',
            }}
          >
            {leftPanelVisible ? (
              <Box sx={{ minHeight: 0, overflow: 'auto' }}>
                <DeviceDetailsLeftPanel device={device} loading={page.loading} />
              </Box>
            ) : null}
            <DeviceDetailsTabPanel
              activeTab={activeTab}
              onActiveTabChange={setActiveTab}
              filesPanel={filesPanel}
            />
          </Box>
        ) : null}

        <SectionLoadingOverlay
          open={page.refreshing && device !== null}
          ariaLabel="Оновлення пристрою"
          showSpinner={false}
        />
      </Box>

      <DeviceUpsertDrawer
        open={page.editForm !== null}
        mode="edit"
        form={page.editForm}
        saving={page.editSubmitting}
        error={page.editError}
        serverFieldErrors={page.editServerFieldErrors}
        referenceLoading={page.lookupsLoading}
        aorOptions={page.aorOptions}
        unitOptions={page.unitOptions}
        hasChanges={page.editHasChanges}
        onClose={page.closeEditDrawer}
        onChange={page.setEditForm}
        onSave={(form) => {
          void page.saveEditDevice(form).then((saved) => {
            if (saved) void files.reload();
          });
        }}
      />

      <ConfirmDangerDialog
        open={page.archiveDialogOpen}
        onClose={page.closeArchiveDialog}
        onConfirm={() => void page.confirmArchiveCurrentDevice()}
        title="Архівувати пристрій"
        description={`Ви дійсно хочете архівувати пристрій «${device?.name ?? ''}»?`}
        confirmLabel="Архівувати"
        submitting={page.mutating}
        disabled={device === null}
      />

      <DeviceFileBatchCreateDialog
        open={files.createDialogOpen}
        rows={files.createRows}
        error={files.createError}
        serverFieldErrors={files.createServerFieldErrors}
        submitting={files.creatingFiles}
        onRowsChange={files.setCreateRows}
        onClose={files.closeCreateDialog}
        onSubmit={(rows) => void files.submitCreateFiles(rows)}
      />

      <ConfirmDangerDialog
        open={files.deleteDialogFile !== null}
        onClose={files.closeDeleteDialog}
        onConfirm={() => void files.confirmDeleteFile()}
        title="Видалити файл"
        description={`Ви дійсно хочете видалити файл «${
          files.deleteDialogFile ? fileDisplayName(files.deleteDialogFile) : ''
        }»?`}
        confirmLabel="Видалити файл"
        submitting={files.mutatingFileId !== null}
        disabled={files.deleteDialogFile === null}
      />
    </Box>
  );
}
