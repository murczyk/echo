import { Box } from '@mui/material';
import { useCallback, useId, useRef, useState } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isPresent } from '../../utils/misc';
import { AnalysisPageHeader } from './AnalysisPageHeader';
import { AnalysisLeftPanel } from './AnalysisLeftPanel';
import { AnalysisLoadingSkeletons } from './AnalysisLoadingSkeletons';
import { AnalysisCenterPanel } from './AnalysisCenterPanel';
import { AnalysisFullscreenPanelDrawer } from './AnalysisFullscreenPanelDrawer';
import { AnalysisRightPanel } from './AnalysisRightPanel';
import { AnalysisReportDialog } from './components/AnalysisReportDialog';
import { CreateMessageFab } from '../shared/manage-message/CreateMessageFab';
import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';
import { getAnalysisCenterTabs } from './types';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';
import { AudioTranscriptionPreferencesProvider } from '../shared/message-card/MessageCardAudioTranscription';
import { isIntelligenceReport } from '../shared/intelligence-reports';
import { PointBlacklistPaletteNamesCacheProvider } from '../shared/message-card/PointBlacklistPaletteNamesCache';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
};

export function RerAnalysisNeoPage({ authUserName = null }: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName);
  const theme = useTheme();
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
  const reportFocusTargetRef = useRef<HTMLElement | null>(null);
  const reportFallbackFocusRef = useRef<HTMLDivElement | null>(null);
  const { notify } = usePowerSnackbar();
  const isAnalysisCompactLayout = useMediaQuery(theme.breakpoints.down('md'));
  const isNarrowLayout = useMediaQuery(theme.breakpoints.down('lg'));
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const mapTabId = `${centerTabsId}-map-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const mapPanelId = `${centerTabsId}-map-panel`;
  const keepDirectMessageVisible =
    page.directMessageNavigation != null &&
    page.messages.some(
      ([messageId]) => messageId === page.directMessageNavigation?.targetMessageId,
    );
  const showLoadingSkeletons =
    page.error == null &&
    !keepDirectMessageVisible &&
    (page.messagesLoading ||
      page.directMessageLoading ||
      (!page.hasLoadedInitialMessages && page.messages.length === 0));
  const leftPanelVisible = page.leftPanelOpen;
  const rightPanelVisible = page.rightPanelOpen;
  const inlineLeftPanelVisible = !isNarrowLayout && leftPanelVisible;
  const inlineRightPanelVisible = !isNarrowLayout && rightPanelVisible;
  const centerTabs = getAnalysisCenterTabs(page.analysisMapInSidebar);
  const centerTab =
    page.analysisMapInSidebar && page.centerTab === 'map' ? 'messages' : page.centerTab;
  const analysisMapVisible =
    centerTab === 'map' ||
    (page.analysisMapInSidebar && rightPanelVisible && page.rightSidebarTab === 'map');
  const openReport = useCallback(
    (focusTarget: HTMLElement) => {
      reportFocusTargetRef.current = focusTarget;
      page.openReport();
    },
    [page.openReport],
  );

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: { xs: 1, lg: 2 },
        pt: { xs: 1, lg: 1 },
        overflow: 'hidden',
      }}
    >
      <Box ref={reportFallbackFocusRef} tabIndex={-1} sx={{ px: { xs: 1, lg: 2 }, pt: 0.5 }}>
        <AnalysisPageHeader
          page={page}
          centerTab={centerTab}
          isCompactLayout={isAnalysisCompactLayout}
          isNarrowLayout={isNarrowLayout}
          leftPanelVisible={leftPanelVisible}
          rightPanelVisible={rightPanelVisible}
          onOpenReport={openReport}
        />
      </Box>

      {page.error ? (
        <PowerAlert severity="error" role="alert" sx={{ mx: { xs: 1, lg: 2 } }}>
          {page.error}
        </PowerAlert>
      ) : null}
      {page.validationError ? (
        <PowerAlert severity="warning" role="status" sx={{ mx: { xs: 1, lg: 2 } }}>
          {page.validationError}
        </PowerAlert>
      ) : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
          overflowX: 'hidden',
          overscrollBehavior: 'none',
        }}
        aria-busy={
          page.messagesLoading ||
          page.filtersLoading ||
          page.summaryLoading ||
          page.newCallsignsLoading
        }
      >
        <Box
          sx={{
            height: '100%',
            minHeight: 0,
            display: 'grid',
            gap: 0,
            overflow: 'hidden',
            alignItems: 'stretch',
            gridTemplateRows: 'minmax(0,1fr)',
            gridTemplateColumns: {
              xs: 'minmax(0,1fr)',
              lg: [
                inlineLeftPanelVisible ? '400px' : null,
                'minmax(0,1fr)',
                inlineRightPanelVisible ? 'minmax(0,1fr)' : null,
              ]
                .filter(Boolean)
                .join(' '),
            },
          }}
        >
          {inlineLeftPanelVisible ? (
            <AnalysisLeftPanel
              page={page}
              leftPanelVisible
              isCompactLayout={isAnalysisCompactLayout}
            />
          ) : null}
          <PointBlacklistPaletteNamesCacheProvider>
            {showLoadingSkeletons ? (
              <AnalysisLoadingSkeletons rightPanelVisible={inlineRightPanelVisible} />
            ) : (
              <AudioTranscriptionPreferencesProvider
                collapsedByDefault={page.audioTranscriptionCollapsed}
                enabled={page.audioTranscriptionEnabled}
              >
                <AnalysisCenterPanel
                  page={page}
                  centerTab={centerTab}
                  centerTabs={centerTabs}
                  isCompactLayout={isAnalysisCompactLayout}
                  isNarrowLayout={isNarrowLayout}
                  rightPanelVisible={inlineRightPanelVisible}
                  messagesPanelId={messagesPanelId}
                  messagesTabId={messagesTabId}
                  summaryPanelId={summaryPanelId}
                  summaryTabId={summaryTabId}
                  mapPanelId={mapPanelId}
                  mapTabId={mapTabId}
                />
              </AudioTranscriptionPreferencesProvider>
            )}
          </PointBlacklistPaletteNamesCacheProvider>
          {!showLoadingSkeletons && inlineRightPanelVisible ? (
            <AnalysisRightPanel
              page={page}
              rightPanelVisible
              isCompactLayout={isAnalysisCompactLayout}
            />
          ) : null}
        </Box>
      </Box>

      <AnalysisFullscreenPanelDrawer
        anchor="left"
        title="Фільтри"
        open={isNarrowLayout && leftPanelVisible}
        onClose={page.toggleLeftPanel}
        maxPanelWidth={400}
      >
        <AnalysisLeftPanel page={page} leftPanelVisible isCompactLayout={false} fullHeight />
      </AnalysisFullscreenPanelDrawer>

      <AnalysisFullscreenPanelDrawer
        anchor="right"
        title="Аналітична панель"
        open={isNarrowLayout && rightPanelVisible}
        onClose={page.toggleRightPanel}
      >
        {showLoadingSkeletons ? (
          <AnalysisLoadingSkeletons centerVisible={false} rightPanelVisible />
        ) : (
          <AnalysisRightPanel
            page={page}
            rightPanelVisible
            isCompactLayout={isAnalysisCompactLayout}
            showNarrowCloseButton={false}
          />
        )}
      </AnalysisFullscreenPanelDrawer>

      <AnalysisReportDialog
        aors={page.aorEntries}
        currentUser={page.currentUser}
        supportNonRerInterceptions={page.supportNonRerInterceptions}
        downloadInFlight={page.reportDownloadInFlight}
        progressExpanded={page.reportProgressExpanded}
        taskRuns={page.reportTaskRuns}
        open={page.report.open}
        report={page.report}
        queryState={page.queryState}
        onClose={page.closeReport}
        focusReturnTargetRef={reportFocusTargetRef}
        fallbackFocusTargetRef={reportFallbackFocusRef}
        onDownload={page.downloadReport}
        onRepeatTaskRun={page.repeatReportTaskRun}
        onSetProgressExpanded={page.setReportProgressExpanded}
        onToggleTaskRunLogs={page.toggleReportTaskRunLogs}
        onUpdate={page.updateReport}
      />

      {!analysisMapVisible ? <CreateMessageFab onClick={() => setCreateMessageOpen(true)} /> : null}
      <ManageMessageDrawer
        open={createMessageOpen || isPresent(page.editorMessage) || isPresent(page.reportSource)}
        cyberEchoEnabled={page.cyberEchoEnabled}
        currentUser={page.currentUser}
        editTarget={page.editorMessage}
        reportSource={page.reportSource}
        editSaveInFlight={page.editorSaveInFlight}
        onClose={() => {
          if (isPresent(page.editorMessage) || isPresent(page.reportSource)) {
            page.closeEditor();
          } else {
            setCreateMessageOpen(false);
          }
        }}
        onSubmitEdit={
          page.editorMessage && !isIntelligenceReport(page.editorMessage.message)
            ? async (_id, message) => {
                await Promise.resolve(page.saveEditor(message));
              }
            : undefined
        }
        onEditSuccess={() => {
          page.reload();
        }}
        onDeleteSuccess={() => {
          page.reload();
          notify({ message: 'Розвіддонесення успішно видалено.', severity: 'success' });
        }}
        onCreated={async () => {
          setCreateMessageOpen(false);
          page.reload();
          notify({
            message: page.reportSource
              ? 'Розвіддонесення успішно створено.'
              : 'Повідомлення успішно створено.',
            severity: 'success',
          });
        }}
      />
    </Box>
  );
}
