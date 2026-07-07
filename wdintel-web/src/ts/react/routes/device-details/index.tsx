import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { navigateWithinSpa } from '../../utils/browser';
import { isSafeExternalUrl } from '../devices/helpers';
import { DeviceFilesSection } from './components/DeviceFilesSection';
import {
  DeviceCustomFieldsSection,
  DeviceRegistrySection,
  DeviceSummarySection,
} from './components/DeviceInfoSections';
import { formatDeviceLifecycleLabel } from './helpers';
import { useDeviceDetailsPage } from './use-device-details-page';
import { useDeviceFiles } from './use-device-files';

function openExternalUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function DeviceHeaderTitle({
  deviceName,
  deleted,
}: {
  deviceName: string | null;
  deleted: boolean;
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      {deviceName === null ? (
        <Skeleton width={240} />
      ) : (
        <Typography
          component="span"
          variant="h5"
          sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}
        >
          {deviceName}
        </Typography>
      )}
      {deviceName !== null ? (
        <Chip
          size="small"
          color={deleted ? 'warning' : 'success'}
          label={formatDeviceLifecycleLabel(deleted)}
        />
      ) : null}
    </Stack>
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
    parentDeleted: page.device?.deleted ?? false,
  });

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
  const externalUrl = device?.externalUrl?.trim() ?? '';
  const canOpenExternalUrl = isSafeExternalUrl(externalUrl);
  const showEditAction = page.permissions.canEdit && device !== null && !device.deleted;
  const showDeleteAction = page.permissions.canEdit && device !== null && !device.deleted;
  const showRestoreAction = page.permissions.canEdit && device !== null && device.deleted;

  return (
    <Box
      sx={{
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title={
          <DeviceHeaderTitle deviceName={device?.name ?? null} deleted={device?.deleted ?? false} />
        }
        titleLeadingActions={
          <Tooltip title="До списку пристроїв">
            <IconButton
              aria-label="До списку пристроїв"
              size="small"
              onClick={() => navigateWithinSpa('/devices')}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        }
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            {canOpenExternalUrl ? (
              <Button
                startIcon={<OpenInNewIcon fontSize="small" />}
                onClick={() => openExternalUrl(externalUrl)}
              >
                Зовнішнє посилання
              </Button>
            ) : null}
            <Button
              variant="outlined"
              onClick={() => void page.reload()}
              disabled={page.loading || page.refreshing || page.mutating}
              startIcon={page.refreshing ? <CircularProgress size={16} /> : <RefreshIcon />}
            >
              Оновити
            </Button>
            {showEditAction ? (
              <Button
                variant="outlined"
                onClick={page.showEditNotice}
                disabled={page.mutating}
                startIcon={<EditIcon />}
              >
                Редагувати
              </Button>
            ) : null}
            {showDeleteAction ? (
              <Button
                color="error"
                variant="outlined"
                onClick={() => void page.deleteCurrentDevice()}
                disabled={page.mutating}
                startIcon={page.mutating ? <CircularProgress size={16} /> : <DeleteIcon />}
              >
                Видалити
              </Button>
            ) : null}
            {showRestoreAction ? (
              <Button
                color="primary"
                variant="contained"
                onClick={() => void page.restoreCurrentDevice()}
                disabled={page.mutating}
                startIcon={page.mutating ? <CircularProgress size={16} /> : <RestoreIcon />}
              >
                Відновити
              </Button>
            ) : null}
          </Stack>
        }
      />

      <Box sx={{ position: 'relative', minHeight: 0, flex: 1, overflow: 'auto', pt: 2, pb: 4 }}>
        {page.status ? (
          <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert>
        ) : null}
        {device?.deleted ? (
          <PowerAlert severity="warning" autoHideDuration={null}>
            Пристрій видалено. Редактори можуть відновити пристрій; життєвий цикл файлів заблоковано
            до відновлення.
          </PowerAlert>
        ) : null}

        {page.loading && device === null ? (
          <PageLoadingState minHeight={360} />
        ) : device ? (
          <Stack spacing={2.5} sx={{ pt: page.status || device.deleted ? 2 : 0 }}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
                gap: 2.5,
              }}
            >
              <DeviceSummarySection device={device} />
              <DeviceRegistrySection device={device} onOpenExternalUrl={openExternalUrl} />
            </Box>
            <DeviceCustomFieldsSection device={device} />
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
              parentDeleted={device.deleted}
              hasFilters={files.hasFilters}
              onDeletedFilterChange={files.setDeletedFilter}
              onCreate={files.showCreateNotice}
              onReload={files.reload}
              onLoadMore={files.loadMore}
              onDelete={files.deleteFile}
              onRestore={files.restoreFile}
            />
          </Stack>
        ) : null}

        <SectionLoadingOverlay
          open={page.refreshing && device !== null}
          ariaLabel="Оновлення пристрою"
          showSpinner={false}
        />
      </Box>
    </Box>
  );
}
