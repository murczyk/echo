import { Box } from '@mui/material';
import { useId, useState } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { PowerAlert } from '../../components/PowerAlert';
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
  const [createdMessageNoticeRevision, setCreatedMessageNoticeRevision] = useState(0);
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const mapTabId = `${centerTabsId}-map-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const mapPanelId = `${centerTabsId}-map-panel`;
  const showLoadingSkeletons =
    !page.hasLoadedInitialMessages && page.error == null && page.messages.length === 0;
  const leftPanelVisible = isMobileLayout || page.leftPanelOpen;
  const rightPanelVisible = isMobileLayout || page.rightPanelOpen;
  const centerTabs = getAnalysisCenterTabs(page.analysisMapInSidebar);
  const centerTab =
    page.analysisMapInSidebar && page.centerTab === 'map' ? 'messages' : page.centerTab;
  const messagesPaneLoading = useMinDurationBusy(page.messagesLoading, 450);

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
      <Box sx={{ px: { xs: 1, lg: 2 } }}>
        <AnalysisPageHeader
          page={page}
          centerTab={centerTab}
          isMobileLayout={isMobileLayout}
          leftPanelVisible={leftPanelVisible}
          rightPanelVisible={rightPanelVisible}
        />
      </Box>

      {createdMessageNoticeRevision > 0 ? (
        <PowerAlert
          key={createdMessageNoticeRevision}
          severity="success"
          role="status"
          autoHideDuration={3000}
          sx={{ mx: { xs: 1, lg: 2 } }}
        >
          Повідомлення успішно створено.
        </PowerAlert>
      ) : null}
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
            gap: { xs: 2, lg: 0 },
            overflow: 'hidden',
            alignItems: 'stretch',
            gridTemplateColumns: {
              xs: '1fr',
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
          <AnalysisLeftPanel page={page} leftPanelVisible={leftPanelVisible} />
          {showLoadingSkeletons ? (
            <AnalysisLoadingSkeletons rightPanelVisible={rightPanelVisible} />
          ) : (
            <AnalysisCenterPanel
              page={page}
              centerTab={centerTab}
              centerTabs={centerTabs}
              isMobileLayout={isMobileLayout}
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
            <AnalysisRightPanel page={page} rightPanelVisible={rightPanelVisible} />
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

      <CreateMessageFab onClick={() => setCreateMessageOpen(true)} />
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
          page.reload();
        }}
        onCreated={async () => {
          setCreateMessageOpen(false);
          setCreatedMessageNoticeRevision((revision) => revision + 1);
          page.reload();
        }}
      />
    </Box>
  );
}
