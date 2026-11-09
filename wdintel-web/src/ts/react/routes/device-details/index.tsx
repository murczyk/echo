import { DeviceFileExplorer } from '../device-files/components/DeviceFileExplorer';
import { useDeviceFileLink } from '../device-files/use-device-file-link';
import SettingsIcon from '@mui/icons-material/Settings';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, Skeleton, Tooltip } from '@mui/material';
import { useEffect, useState, useRef, type CSSProperties } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { hasRole } from '../../utils/roles';
import { DeviceUpsertDrawer } from '../devices/components/DeviceUpsertDrawer';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { DeviceFilesSidebar, useDeviceFiles } from '../device-files';
import { useDeviceAnalyticsTags } from '../device-files/use-device-analytics-tags';
import { useDeviceFileJournal } from '../device-files/use-device-file-journal';
import { DeviceHeaderTitle } from './components/DeviceHeaderTitle';
import { DeviceAudioForwardingWarning } from './components/DeviceAudioForwardingWarning';
import { DeviceDetailsNavigation } from './components/DeviceDetailsNavigation';
import { DeviceDetailsLeftPanel } from './components/DeviceDetailsLeftPanel';
import { DeviceDetailsContent } from './components/DeviceDetailsContent';
import { DeviceDetailsSection, readDeviceTagFilter } from './page-route';
import { useDevicePageNavigation } from './use-device-page-navigation';
import { useDeviceMobileLayout } from '../devices/use-device-mobile-layout';
import { DeviceMobileHeader } from './components/DeviceMobileHeader';
import { DeviceMobileSheet } from '../devices/components/DeviceMobileSheet';
import { useDeviceDetailsPage } from './use-device-details-page';
import { useDeviceAudioSettings } from './use-device-audio-settings';
import { useDeviceAudio } from './use-device-audio';
import { useDeviceAudioEditor } from './use-device-audio-editor';
import { useDeviceAudioDraftGuard } from './use-device-audio-draft-guard';
import { DeviceAudioLeaveDialog } from './components/DeviceAudioLeaveDialog';
import { DeviceAudioEditor } from './components/DeviceAudioEditor';
import { DeviceAudioSidebar } from './components/DeviceAudioSidebar';
import { useDeviceSyncSessions } from './use-device-sync-sessions';
import { selectDeviceSyncSession } from './url-state';
import { DeviceSyncSessionsSidebar } from './components/DeviceSyncSessionsSidebar';
import { DeviceSyncSessionFilter } from './components/DeviceSyncSessionFilter';
import { useDeviceFileErrorNotification } from '../device-files/use-device-file-error-notification';
import { useDeviceFilesPanelResize } from './use-device-files-panel-resize';
import { DEVICE_OVERVIEW_SIDEBAR_WIDTH, DEVICE_SIDEBAR_WIDTH } from './layout';

export function DeviceDetailsPage({
  deviceId,
  authUserRoles = [],
  syncId: urlSyncId = null,
  section = DeviceDetailsSection.Overview,
}: {
  deviceId: string;
  authUserRoles?: string[];
  syncId?: string | null;
  section?: DeviceDetailsSection;
}) {
  const page = useDeviceDetailsPage({ deviceId, authUserRoles });
  const isMobileLayout = useDeviceMobileLayout();
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [fileFiltersOpen, setFileFiltersOpen] = useState(false);
  const linkedFile = useDeviceFileLink();
  const isOverview = section === DeviceDetailsSection.Overview;
  const isFiles = section === DeviceDetailsSection.Files;
  const syncId = isFiles ? urlSyncId : null;
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(syncId !== null);
  const rightPanelVisible = isFiles && rightPanelOpen;
  const filesPanel = useDeviceFilesPanelResize(rightPanelVisible, !isMobileLayout);
  const device = page.device;
  const audio = useDeviceAudio(
    deviceId,
    page.permissions.canRead && device?.id === deviceId,
    section === DeviceDetailsSection.Audio,
  );
  const audioSettings = useDeviceAudioSettings(
    deviceId,
    section === DeviceDetailsSection.Audio && page.permissions.canRead && device?.id === deviceId,
  );
  const editorSelection = useRef({ deviceId, audioId: audio.selectedAudioId });
  if (editorSelection.current.deviceId !== deviceId)
    editorSelection.current = { deviceId, audioId: null };
  if (audio.selectedAudioId !== null) editorSelection.current.audioId = audio.selectedAudioId;
  const audioEditor = useDeviceAudioEditor(
    deviceId,
    editorSelection.current.audioId,
    page.permissions.fieldPermissions.analyticalData &&
      device?.archived === false &&
      (editorSelection.current.audioId === null ||
        audio.processing[editorSelection.current.audioId]?.canEdit !== false),
    audio,
  );
  useEffect(() => {
    if (section === DeviceDetailsSection.Audio && audio.selectedAudioId !== null)
      audioEditor.setAutomaticView(false);
  }, [section, audio.selectedAudioId, audioEditor.setAutomaticView]);
  const audioGuard = useDeviceAudioDraftGuard(audioEditor);
  const guardedAudio = {
    ...audio,
    selectAudio: (id: string | null) => {
      if (id !== audio.selectedAudioId) void audioGuard.requestIntent(() => audio.selectAudio(id));
    },
    setUnprocessedOnly: (checked: boolean) => {
      void audioGuard.requestIntent(() => audio.setUnprocessedOnly(checked));
    },
    retry: async () => {
      await audioGuard.requestIntent(() => audio.retry());
    },
    setProcessed: async (id: string, target: boolean) => {
      if (audio.unprocessedOnly && target && id === audio.selectedAudioId)
        await audioGuard.requestIntent(() => audio.setProcessed(id, target));
      else await audio.setProcessed(id, target);
    },
    reconcileProcessing: async (id: string) => {
      await audio.reconcileProcessing(id);
      if (audioEditor.accessDenied && audioEditor.detail?.audio.id === id)
        await audioEditor.reload();
    },
  };
  const sessions = useDeviceSyncSessions({
    deviceId,
    syncId,
    open: isFiles && (isMobileLayout ? mobileSessionsOpen : rightPanelOpen),
    enabled: page.permissions.canRead && device !== null,
  });
  const tagsState = useDeviceAnalyticsTags({
    deviceId,
    enabled: page.permissions.canRead && device !== null,
    active:
      section !== DeviceDetailsSection.Journal &&
      (!isFiles ||
        fileFiltersOpen ||
        readDeviceTagFilter(window.location.search).tagIds.length > 0),
  });
  const { tagFilter, changeTagFilter, backHref, backLabel } = useDevicePageNavigation({
    deviceId,
    section,
    linkedFile,
    tagsState,
  });
  const files = useDeviceFiles({
    deviceId,
    syncId,
    enabled: section === DeviceDetailsSection.Files && sessions.ready,
    linkedFile,
    tagFilter,
    filtersOpen: fileFiltersOpen,
    setFiltersOpen: setFileFiltersOpen,
    treeActive: isMobileLayout ? mobileFilesOpen : leftPanelOpen,
  });
  const fileCitation =
    linkedFile?.revision && files.revisionPinned
      ? { ...linkedFile, deviceId, revision: linkedFile.revision }
      : undefined;
  const journal = useDeviceFileJournal({
    deviceId,
    syncId,
    enabled: section === DeviceDetailsSection.Journal && sessions.ready,
  });
  const refreshRef = useRef(() => {});
  refreshRef.current = () => {
    if (!sessions.ready) return;
    if (section === DeviceDetailsSection.Files) void files.refreshVisible();
    if (section === DeviceDetailsSection.Journal) void journal.reload();
  };
  useEffect(() => {
    if (sessions.refreshVersion > 0) refreshRef.current();
  }, [sessions.refreshVersion]);
  const fileError = [
    files.linkError,
    files.markerError,
    files.directory.error?.message,
    files.rootsError?.message,
    files.searchError?.message,
    files.searchLoadMoreError?.message,
    files.counts.error?.message,
    journal.error?.message,
    journal.loadMoreError?.message,
    tagsState.error?.message,
    ...Object.values(files.tree.branches).flatMap((branch) => [
      branch.error?.message,
      branch.loadMoreError?.message,
    ]),
  ].find(Boolean);
  useDeviceFileErrorNotification(fileError);
  const leftPanelVisible = isMobileLayout || leftPanelOpen;
  const toggleSidePanelLabel = leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель';

  if (!page.permissions.canRead) {
    return (
      <>
        <PageErrorState message="Немає доступу до пристроїв." minHeight="100%" />
        {audioEditor.confirmed ? <DeviceAudioEditor editor={audioEditor} /> : null}
        <DeviceAudioLeaveDialog guard={audioGuard} editor={audioEditor} />
      </>
    );
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

  const showLeftPanelToggle =
    isOverview || section === DeviceDetailsSection.Files || section === DeviceDetailsSection.Audio;
  const showEditAction =
    !isFiles && page.permissions.canEdit && device !== null && !device.archived;

  return (
    <Box
      className={isFiles ? 'pr-6' : undefined}
      style={
        isFiles
          ? ({
              '--device-files-scroll-gutter': rightPanelVisible
                ? 'var(--echo-spacing-lg)'
                : '1.5rem',
            } as CSSProperties)
          : undefined
      }
      sx={{
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflow: 'hidden',
      }}
    >
      {isMobileLayout ? (
        <DeviceMobileHeader
          key={section}
          files={isFiles ? files : undefined}
          filesOpen={mobileFilesOpen}
          onToggleFiles={() => setMobileFilesOpen((current) => !current)}
          device={device}
          deviceId={deviceId}
          section={section}
          backHref={backHref}
          backLabel={backLabel}
          canEdit={showEditAction}
          editSubmitting={page.editSubmitting}
          onEdit={page.openEditDrawer}
          onInfo={() => setMobileInfoOpen(true)}
          onSessions={isFiles ? () => setMobileSessionsOpen(true) : undefined}
          syncId={syncId}
          session={sessions.session}
        />
      ) : (
        <PageHeader
          titleComponent="div"
          className="device-page-header flex-nowrap! [&>div:first-child]:w-auto! [&>div:first-child]:min-w-0 [&>div:first-child]:flex-1! [&>div:last-child]:pl-echo-sm"
          titleClassName="min-w-0! flex-1!"
          title={
            <DeviceHeaderTitle
              key={section}
              files={isFiles ? files : undefined}
              deviceId={deviceId}
              section={section}
              deviceName={device === null ? null : (device.name ?? 'Без назви')}
              archived={device?.archived ?? false}
              backHref={backHref}
              backLabel={backLabel}
            />
          }
          titleLeadingActions={
            showLeftPanelToggle ? (
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
            <div className="flex flex-nowrap items-center justify-end gap-echo-sm">
              {syncId !== null ? (
                <DeviceSyncSessionFilter
                  session={sessions.session}
                  onReset={() => selectDeviceSyncSession(null)}
                />
              ) : null}
              {!isFiles ? (
                <DeviceAudioForwardingWarning configured={device?.audioForwardingConfigured} />
              ) : null}
              {showEditAction ? (
                <Tooltip title="Редагувати">
                  <span>
                    <PowerIconButton
                      onClick={page.openEditDrawer}
                      disabled={page.editSubmitting}
                      aria-label="Редагувати пристрій"
                    >
                      <SettingsIcon fontSize="small" />
                    </PowerIconButton>
                  </span>
                </Tooltip>
              ) : null}
              {isFiles ? (
                <SidePanelToggleButton
                  side="right"
                  active={rightPanelOpen}
                  label={rightPanelOpen ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
                  onClick={() => setRightPanelOpen((current) => !current)}
                />
              ) : null}
            </div>
          }
        />
      )}

      <DeviceAudioLeaveDialog guard={audioGuard} editor={audioEditor} />
      {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}
      {device?.archived ? (
        <PowerAlert severity="warning" autoHideDuration={null}>
          Пристрій архівовано. Редагування недоступне.
        </PowerAlert>
      ) : null}

      <div
        ref={filesPanel.containerRef}
        className={`${
          isMobileLayout
            ? 'relative flex min-h-0 flex-1 flex-col gap-echo-md'
            : 'relative flex-1 min-h-0 grid grid-cols-1 auto-rows-auto gap-echo-lg echo-lg:grid-cols-[var(--device-columns)] echo-lg:grid-rows-[minmax(0,1fr)]'
        } ${isFiles ? 'overflow-visible' : isMobileLayout ? 'overflow-hidden' : 'overflow-auto echo-lg:overflow-hidden'}`}
        style={
          {
            '--device-columns': `${leftPanelVisible && showLeftPanelToggle ? `${isFiles ? filesPanel.width : isOverview ? DEVICE_OVERVIEW_SIDEBAR_WIDTH : DEVICE_SIDEBAR_WIDTH}px ` : ''}minmax(0, 1fr)${rightPanelVisible ? ' 344px' : ''}`,
          } as CSSProperties
        }
      >
        {page.loading && device === null ? (
          isMobileLayout ? (
            <Skeleton variant="rounded" className="h-full w-full" />
          ) : leftPanelVisible ? (
            <Box sx={{ minHeight: 420, overflow: 'hidden' }}>
              <DeviceDetailsLeftPanel device={null} loading={page.loading} />
            </Box>
          ) : null
        ) : device ? (
          <>
            {isOverview && leftPanelVisible ? (
              <DeviceDetailsNavigation
                deviceId={deviceId}
                search={window.location.search}
                tagFilter={tagFilter}
              />
            ) : null}
            {!isMobileLayout && section === DeviceDetailsSection.Files ? (
              <div
                id="device-files-sidebar-panel"
                hidden={!leftPanelVisible}
                className="relative min-w-0 echo-lg:min-h-0"
              >
                <DeviceFilesSidebar
                  active={leftPanelVisible}
                  files={files}
                  tagsState={tagsState}
                  tagFilter={tagFilter}
                  onTagFilterChange={changeTagFilter}
                />
                <div
                  role="separator"
                  tabIndex={0}
                  aria-label="Ширина панелі файлів"
                  aria-orientation="vertical"
                  aria-controls="device-files-sidebar-panel"
                  title="Перетягніть, щоб змінити ширину панелі"
                  {...filesPanel.separatorProps}
                  className="group absolute inset-y-0 left-full z-10 -ml-px flex w-echo-lg touch-none cursor-col-resize select-none justify-start text-echo-text/40 outline-none transition-colors hover:bg-echo-primary/10 hover:text-echo-primary focus-visible:bg-echo-primary/10 focus-visible:text-echo-primary active:bg-echo-primary/15 active:text-echo-primary"
                >
                  <span className="pointer-events-none w-px bg-echo-primary/0 group-hover:bg-echo-primary group-focus-visible:bg-echo-primary group-active:bg-echo-primary" />
                  <MoreVertIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute left-1/2 top-1/2 h-6! w-4! -translate-x-1/2 -translate-y-1/2"
                  />
                </div>
              </div>
            ) : !isMobileLayout && section === DeviceDetailsSection.Audio && leftPanelVisible ? (
              <DeviceAudioSidebar audio={guardedAudio} settings={audioSettings} />
            ) : null}
            <div
              className={`${
                isMobileLayout
                  ? 'flex min-h-0 min-w-0 flex-1 overflow-hidden'
                  : 'min-h-[420px] echo-lg:min-h-0 min-w-0 flex overflow-hidden'
              } ${isFiles ? '-mr-[var(--device-files-scroll-gutter)]' : ''}`}
            >
              <DeviceDetailsContent
                device={device}
                audio={guardedAudio}
                audioEditor={audioEditor}
                audioSettings={audioSettings}
                mobile={isMobileLayout}
                fileExplorer={
                  isFiles ? (
                    <DeviceFileExplorer
                      files={files}
                      tagsState={tagsState}
                      tagFilter={tagFilter}
                      onTagFilterChange={changeTagFilter}
                      sessionScoped={syncId !== null}
                      mobile={isMobileLayout}
                      citation={fileCitation}
                    />
                  ) : undefined
                }
                section={section}
                selectedFile={files.selectedFile}
                onSelectFile={files.selectFile}
                revisionPinned={files.revisionPinned}
                citation={fileCitation}
                journal={journal}
                deviceId={deviceId}
                syncId={syncId}
                dataReady={sessions.ready}
                sessionError={sessions.selectionError}
                onRetrySession={sessions.refresh}
                refreshVersion={sessions.refreshVersion}
                isAdmin={hasRole(authUserRoles, 'Admin')}
                tagsState={tagsState}
              />
            </div>
            {!isMobileLayout && rightPanelVisible ? (
              <DeviceSyncSessionsSidebar
                deviceId={deviceId}
                syncId={syncId}
                state={sessions}
                onSelect={selectDeviceSyncSession}
              />
            ) : null}
          </>
        ) : null}

        <SectionLoadingOverlay
          open={page.refreshing && device !== null}
          ariaLabel="Оновлення пристрою"
          showSpinner={false}
        />
      </div>

      {isMobileLayout ? (
        <>
          {isFiles ? (
            <DeviceMobileSheet
              open={mobileFilesOpen}
              title="Файли"
              onClose={() => setMobileFilesOpen(false)}
            >
              <DeviceFilesSidebar
                active={mobileFilesOpen}
                fullHeight
                files={{
                  ...files,
                  openDirectory: (id, revision) => {
                    files.openDirectory(id, revision);
                    setMobileFilesOpen(false);
                  },
                  selectFile: (file) => {
                    files.selectFile(file);
                    setMobileFilesOpen(false);
                  },
                }}
                tagsState={tagsState}
                tagFilter={tagFilter}
                onTagFilterChange={changeTagFilter}
              />
            </DeviceMobileSheet>
          ) : null}
          <DeviceMobileSheet
            open={mobileInfoOpen}
            title="Про пристрій"
            onClose={() => setMobileInfoOpen(false)}
          >
            <DeviceDetailsLeftPanel device={device} loading={page.loading} />
          </DeviceMobileSheet>
          {isFiles ? (
            <DeviceMobileSheet
              open={mobileSessionsOpen}
              title="Сесії синхронізації"
              onClose={() => setMobileSessionsOpen(false)}
            >
              <DeviceSyncSessionsSidebar
                fullHeight
                deviceId={deviceId}
                syncId={syncId}
                state={sessions}
                onSelect={(id) => {
                  setMobileSessionsOpen(false);
                  selectDeviceSyncSession(id);
                }}
              />
            </DeviceMobileSheet>
          ) : null}
        </>
      ) : null}

      <DeviceUpsertDrawer
        open={page.editForm !== null}
        mode="edit"
        deviceId={page.device?.id}
        canRebuildStats={hasRole(authUserRoles, 'Admin')}
        onStatsRebuilt={sessions.refresh}
        onArchive={() => page.setArchiveConfirmationOpen(true)}
        fieldPermissions={page.permissions.fieldPermissions}
        form={page.editForm}
        saving={page.editSubmitting}
        error={page.editError}
        serverFieldErrors={page.editServerFieldErrors}
        referenceLoading={page.lookupsLoading}
        aorOptions={page.aorOptions}
        unitOptions={page.unitOptions}
        hasChanges={page.editHasChanges}
        nameRequired={page.device?.name !== null}
        onClose={page.closeEditDrawer}
        onChange={page.setEditForm}
        onSave={(form) => void page.saveEditDevice(form)}
      />
      <ConfirmDangerDialog
        open={page.archiveConfirmationOpen ?? false}
        title="Архівувати пристрій?"
        description={`Пристрій: ${page.device?.name ?? 'Без назви'}. Архівований пристрій залишиться доступним для перегляду. Редагування та нова синхронізація будуть недоступні. Незбережені зміни форми буде втрачено.`}
        confirmLabel="Архівувати"
        submitting={page.editSubmitting}
        onClose={() => page.setArchiveConfirmationOpen(false)}
        onConfirm={() => void page.archiveCurrentDevice()}
      />
    </Box>
  );
}
