import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import RestoreIcon from '@mui/icons-material/Restore';
import { Box, IconButton, Menu, MenuItem, Skeleton, Stack, Tooltip } from '@mui/material';
import { useState } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { navigateWithinSpa } from '../../utils/browser';
import { DeviceUpsertDrawer } from '../devices/components/DeviceUpsertDrawer';
import { DeviceDetailsLeftPanel } from './components/DeviceDetailsLeftPanel';
import { formatDeviceLifecycleLabel } from './helpers';
import { useDeviceDetailsPage } from './use-device-details-page';

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
          Пристрій архівовано. Редактори можуть відновити пристрій.
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
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <DeviceDetailsLeftPanel device={null} loading={page.loading} />
          </Box>
        ) : device ? (
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <DeviceDetailsLeftPanel device={device} loading={page.loading} />
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
        onSave={(form) => void page.saveEditDevice(form)}
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
    </Box>
  );
}
