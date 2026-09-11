import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import { Box, Skeleton, Stack, Tooltip, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { navigateWithinSpa } from '../../utils/browser';
import { hasRole } from '../../utils/roles';
import { DeviceUpsertDrawer } from '../devices/components/DeviceUpsertDrawer';
import { DeviceFilesSidebar, useDeviceFiles } from '../device-files';
import type { DeviceAnalyticsTagFilter } from '../device-files/types';
import { useDeviceAnalyticsTags } from '../device-files/use-device-analytics-tags';
import { useDeviceFileJournal } from '../device-files/use-device-file-journal';
import { DeviceDetailsLeftPanel } from './components/DeviceDetailsLeftPanel';
import { DeviceDetailsTabPanel, type DeviceDetailsTab } from './components/DeviceDetailsTabPanel';
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
        <PowerIconButton
          aria-label="До списку пристроїв"
          onClick={() => navigateWithinSpa('/devices')}
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <ArrowBackIcon fontSize="small" />
        </PowerIconButton>
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
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const echoLgMediaQuery = `@media (min-width: ${theme.echo.breakpoint.lg})`;
  const [activeTab, setActiveTab] = useState<DeviceDetailsTab>('analytical');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [tagFilter, setTagFilter] = useState<DeviceAnalyticsTagFilter>({
    tagIds: [],
    tagMatch: 'any',
    untagged: false,
  });
  const device = page.device;
  const tagsState = useDeviceAnalyticsTags({
    deviceId,
    enabled: page.permissions.canRead && device !== null,
  });
  const files = useDeviceFiles({
    deviceId,
    enabled: activeTab === 'files' && page.permissions.canRead && device !== null,
    tagFilter,
  });
  const journal = useDeviceFileJournal({
    deviceId,
    enabled: activeTab === 'journal' && page.permissions.canRead && device !== null,
    tagFilter,
  });
  useEffect(() => {
    setTagFilter({ tagIds: [], tagMatch: 'any', untagged: false });
  }, [deviceId]);
  useEffect(() => {
    if (tagsState.loading || tagsState.error !== null) return;
    const activeTagIds = new Set(tagsState.tags.map((tag) => tag.id));
    setTagFilter((current) => {
      const tagIds = current.tagIds.filter((tagId) => activeTagIds.has(tagId));
      return tagIds.length === current.tagIds.length ? current : { ...current, tagIds };
    });
  }, [tagsState.error, tagsState.loading, tagsState.tags]);
  const leftPanelVisible = isMobileLayout || leftPanelOpen;
  const toggleSidePanelLabel = leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель';

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

  const showEditAction = page.permissions.canEdit && device !== null && !device.archived;

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
            deviceName={device === null ? null : (device.name ?? 'Без назви')}
            archived={device?.archived ?? false}
          />
        }
        titleLeadingActions={
          !isMobileLayout ? (
            <SidePanelToggleButton
              side="left"
              active={leftPanelVisible}
              label={toggleSidePanelLabel}
              onClick={() => setLeftPanelOpen((current) => !current)}
            />
          ) : null
        }
        titleLeadingGap={2}
        actions={
          showEditAction ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Tooltip title="Редагувати">
                <span>
                  <PowerIconButton
                    onClick={page.openEditDrawer}
                    disabled={page.editSubmitting}
                    aria-label="Редагувати пристрій"
                  >
                    <EditIcon fontSize="small" />
                  </PowerIconButton>
                </span>
              </Tooltip>
            </Stack>
          ) : undefined
        }
      />

      {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}
      {device?.archived ? (
        <PowerAlert severity="warning" autoHideDuration={null}>
          Пристрій архівовано. Редагування недоступне.
        </PowerAlert>
      ) : null}

      <Box
        sx={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gridTemplateRows: 'auto minmax(420px, 1fr)',
          overflow: 'auto',
          [echoLgMediaQuery]: {
            gridTemplateColumns: leftPanelVisible
              ? 'minmax(360px, 420px) minmax(0, 1fr)'
              : 'minmax(0, 1fr)',
            gridTemplateRows: 'minmax(0, 1fr)',
            overflow: 'hidden',
          },
          gap: 2,
        }}
      >
        {page.loading && device === null ? (
          leftPanelVisible ? (
            <Box sx={{ minHeight: 420, overflow: 'hidden' }}>
              <DeviceDetailsLeftPanel device={null} loading={page.loading} />
            </Box>
          ) : null
        ) : device ? (
          <>
            {activeTab === 'files' ? (
              <div
                hidden={!leftPanelVisible}
                className="min-w-0 echo-lg:min-h-0 echo-lg:overflow-hidden"
              >
                <DeviceFilesSidebar
                  files={files}
                  tagsState={tagsState}
                  tagFilter={tagFilter}
                  onTagFilterChange={setTagFilter}
                />
              </div>
            ) : leftPanelVisible ? (
              <Box sx={{ minHeight: 0, overflow: 'hidden' }}>
                <DeviceDetailsLeftPanel device={device} loading={page.loading} />
              </Box>
            ) : null}
            <Box sx={{ minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
              <DeviceDetailsTabPanel
                activeTab={activeTab}
                journal={journal}
                deviceId={deviceId}
                isAdmin={hasRole(authUserRoles, 'Admin')}
                tagsState={tagsState}
                tagFilter={tagFilter}
                onTagFilterChange={setTagFilter}
                onTabChange={setActiveTab}
              />
            </Box>
          </>
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
        fieldPermissions={page.permissions.fieldPermissions}
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
    </Box>
  );
}
