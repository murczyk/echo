import { Box } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isPresent } from '../../utils/misc';
import { AnalysisPageHeader } from './AnalysisPageHeader';
import { AnalysisLeftPanel } from './AnalysisLeftPanel';
import { AnalysisLoadingSkeletons } from './AnalysisLoadingSkeletons';
import { AnalysisCenterPanel } from './AnalysisCenterPanel';
import { AnalysisRightPanel } from './AnalysisRightPanel';
import { AnalysisReportDialog } from './components/AnalysisReportDialog';
import { CreateMessageFab } from '../shared/manage-message/CreateMessageFab';
import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';
import { getAnalysisCenterTabs } from './types';
import { useMinDurationBusy } from './use-min-duration-busy';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
};

export function RerAnalysisNeoPage({ authUserName = null }: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName);
  const theme = useTheme();
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
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
  const showLoadingSkeletons =
    !page.hasLoadedInitialMessages && page.error == null && page.messages.length === 0;
  const leftPanelVisible = isAnalysisCompactLayout || page.leftPanelOpen;
  const rightPanelVisible = page.rightPanelOpen;
  const centerTabs = getAnalysisCenterTabs(page.analysisMapInSidebar);
  const centerTab =
    page.analysisMapInSidebar && page.centerTab === 'map' ? 'messages' : page.centerTab;
  const analysisMapVisible =
    centerTab === 'map' ||
    (page.analysisMapInSidebar && rightPanelVisible && page.rightSidebarTab === 'map');
  const messagesPaneLoading = useMinDurationBusy(page.messagesLoading, 450);
  const previousRightPanelOpenRef = useRef(page.rightPanelOpen);

  useEffect(() => {
    const wasOpen = previousRightPanelOpenRef.current;
    previousRightPanelOpenRef.current = rightPanelVisible;
    if (wasOpen || !rightPanelVisible || window.innerWidth >= 1200) return;

    const rightPanel = document.querySelector<HTMLElement>('[data-analysis-right-panel]');
    if (!rightPanel) return;
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: no-preference)')?.matches === true;
    rightPanel.scrollIntoView({
      behavior: prefersReducedMotion ? 'smooth' : 'auto',
      block: 'start',
    });
  }, [rightPanelVisible]);

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
      <Box sx={{ px: { xs: 1, lg: 2 }, pt: 0.5 }}>
        <AnalysisPageHeader
          page={page}
          centerTab={centerTab}
          isCompactLayout={isAnalysisCompactLayout}
          isNarrowLayout={isNarrowLayout}
          leftPanelVisible={leftPanelVisible}
          rightPanelVisible={rightPanelVisible}
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
            gridTemplateRows: {
              xs: [
                leftPanelVisible ? 'auto' : null,
                'minmax(0,1fr)',
                rightPanelVisible ? 'minmax(0,1fr)' : null,
              ]
                .filter(Boolean)
                .join(' '),
              lg: '1fr',
            },
            gridTemplateColumns: {
              xs: 'minmax(0,1fr)',
              lg: [
                leftPanelVisible ? '400px' : null,
                'minmax(0,1fr)',
                rightPanelVisible ? 'minmax(0,1fr)' : null,
              ]
                .filter(Boolean)
                .join(' '),
            },
          }}
        >
          <AnalysisLeftPanel
            page={page}
            leftPanelVisible={leftPanelVisible}
            isCompactLayout={isAnalysisCompactLayout}
          />
          {showLoadingSkeletons ? (
            <AnalysisLoadingSkeletons rightPanelVisible={rightPanelVisible} />
          ) : (
            <AnalysisCenterPanel
              page={page}
              centerTab={centerTab}
              centerTabs={centerTabs}
              isCompactLayout={isAnalysisCompactLayout}
              isNarrowLayout={isNarrowLayout}
              rightPanelVisible={rightPanelVisible}
              messagesPaneLoading={messagesPaneLoading}
              messagesPanelId={messagesPanelId}
              messagesTabId={messagesTabId}
              summaryPanelId={summaryPanelId}
              summaryTabId={summaryTabId}
              mapPanelId={mapPanelId}
              mapTabId={mapTabId}
            />
          )}
          {!showLoadingSkeletons ? (
            <AnalysisRightPanel
              page={page}
              rightPanelVisible={rightPanelVisible}
              isCompactLayout={isAnalysisCompactLayout}
            />
          ) : null}
        </Box>
      </Box>

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
        onDownload={page.downloadReport}
        onRepeatTaskRun={page.repeatReportTaskRun}
        onSetProgressExpanded={page.setReportProgressExpanded}
        onToggleTaskRunLogs={page.toggleReportTaskRunLogs}
        onUpdate={page.updateReport}
      />

      {!analysisMapVisible ? <CreateMessageFab onClick={() => setCreateMessageOpen(true)} /> : null}
      <ManageMessageDrawer
        open={createMessageOpen || isPresent(page.editorMessage)}
        cyberEchoEnabled={page.cyberEchoEnabled}
        currentUser={page.currentUser}
        editTarget={page.editorMessage}
        editSaveInFlight={page.editorSaveInFlight}
        onClose={() => {
          if (isPresent(page.editorMessage)) {
            page.closeEditor();
          } else {
            setCreateMessageOpen(false);
          }
        }}
        onSubmitEdit={async (_id, message) => {
          await Promise.resolve(page.saveEditor(message));
        }}
        onEditSuccess={() => {
          page.reload();
        }}
        onCreated={async () => {
          setCreateMessageOpen(false);
          page.reload();
          notify({ message: 'Повідомлення успішно створено.', severity: 'success' });
        }}
      />
    </Box>
  );
}
