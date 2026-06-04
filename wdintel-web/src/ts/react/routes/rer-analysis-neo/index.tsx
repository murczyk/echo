import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import MessageOutlinedIcon from '@mui/icons-material/MessageOutlined';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import {
  Box,
  Button,
  FormControlLabel,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  useMediaQuery,
} from '@mui/material';
import { useId } from 'react';
import { useTheme } from '@mui/material/styles';

import { PageHeader } from '../../components/PageHeader';
import { PowerChip } from '../../components/PowerChip';
import { PowerAlert } from '../../components/PowerAlert';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { NO_DATA_LABEL } from '../../utils/misc';
import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import { AnalysisMapPane } from './components/AnalysisMapPane';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisReportDialog } from './components/AnalysisReportDialog';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { useMinDurationBusy } from './use-min-duration-busy';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';
import { getAnalysisCenterTabs } from './types';
import type { AnalysisCenterTab } from './types';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
};

const ANALYSIS_CENTER_TAB_META: Record<
  AnalysisCenterTab,
  { icon: typeof MessageOutlinedIcon; label: string }
> = {
  messages: { icon: MessageOutlinedIcon, label: 'Повідомлення' },
  summary: { icon: TableRowsOutlinedIcon, label: 'Зведена таблиця' },
  map: { icon: MapOutlinedIcon, label: 'Мапа' },
};

export function RerAnalysisNeoPage({ authUserName = null }: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName);
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const mapTabId = `${centerTabsId}-map-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const mapPanelId = `${centerTabsId}-map-panel`;
  const showLoadingSkeletons = !page.hasLoadedInitialMessages && page.error == null && page.messages.length === 0;
  const fixedPanelWidth = '400px';
  const leftPanelVisible = isMobileLayout || page.leftPanelOpen;
  const rightPanelVisible = isMobileLayout || page.rightPanelOpen;
  const centerTabs = getAnalysisCenterTabs(page.analysisMapInSidebar);
  const centerTab = page.analysisMapInSidebar && page.centerTab === 'map' ? 'messages' : page.centerTab;
  const activeTabId = centerTab === 'messages' ? messagesTabId : centerTab === 'summary' ? summaryTabId : mapTabId;
  const messagesPaneLoading = useMinDurationBusy(page.messagesLoading, 450);
  const gridTemplateColumns = {
    xs: '1fr',
    lg: [
      leftPanelVisible ? fixedPanelWidth : null,
      'minmax(0,1fr)',
      rightPanelVisible ? 'minmax(0,1fr)' : null,
    ].filter(Boolean).join(' '),
  };
  const messageCardSkeletons = [
    { lines: [320, 180, 140], bodyHeight: 92 },
    { lines: [240, 160], bodyHeight: 76 },
    { lines: [280, 200, 160], bodyHeight: 88 },
    { lines: [220, 180], bodyHeight: 76 },
  ];

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: { xs: 1, lg: 2 },
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title="Аналіз"
        middle={<AnalysisHeaderControls queryState={page.queryState} updateQueryState={page.updateQueryState} />}
        titleLeadingActions={!isMobileLayout ? (
          <SidePanelToggleButton
            side="left"
            active={leftPanelVisible}
            label={leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={() => page.toggleLeftPanel()}
          />
        ) : null}
        titleLeadingGap={!isMobileLayout ? 2 : 1}
        titleActions={
          <Button
            variant="contained"
            color="primary"
            size="small"
            onClick={page.openReport}
            title="Відкрити конструктор звітів"
            startIcon={<DescriptionOutlinedIcon sx={{ fontSize: 18 }} />}
            sx={{ height: 36, px: 1.25, display: { xs: 'inline-flex', md: 'none' }, whiteSpace: 'nowrap' }}
          >
            Конструктор
          </Button>
        }
        middleGap={4}
        actions={
          <Stack direction="row" spacing={2} alignItems="center">
            <Button
              variant="contained"
              color="primary"
              onClick={page.openReport}
              title="Відкрити конструктор звітів"
              sx={{ height: 40, px: 2, display: { xs: 'none', md: 'inline-flex' } }}
            >
              Конструктор звітів
            </Button>
            {!isMobileLayout ? (
              <SidePanelToggleButton
                side="right"
                active={rightPanelVisible}
                label={rightPanelVisible ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
                onClick={() => page.toggleRightPanel()}
              />
            ) : null}
          </Stack>
        }
      />

      {page.error ? (
        <PowerAlert severity="error" role="alert">
          {page.error}
        </PowerAlert>
      ) : null}
      {page.validationError ? (
        <PowerAlert severity="warning" role="status">
          {page.validationError}
        </PowerAlert>
      ) : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
        aria-busy={page.messagesLoading || page.filtersLoading || page.summaryLoading || page.newCallsignsLoading}
      >
        <Box
          sx={{
            height: "100%",
            minHeight: 0,
            display: "grid",
            gap: 2,
            overflow: "hidden",
            alignItems: "stretch",
            gridTemplateColumns,
          }}
        >
          {showLoadingSkeletons ? (
            <>
              {leftPanelVisible ? (
                <Paper
                  variant="outlined"
                  component="aside"
                  aria-label="Панель фільтрів"
                  sx={{
                    minHeight: 0,
                    height: { xs: 'auto', lg: '100%' },
                    overflow: 'hidden',
                    display: 'block',
                  }}
                >
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      height: '100%',
                    }}
                  >
                    <AnalysisFiltersPanel page={page} />
                  </Box>
                </Paper>
              ) : null}

              <Paper
                variant="outlined"
                component="section"
                aria-label="Центральна секція"
                aria-disabled="true"
                sx={{
                  minHeight: 0,
                  minWidth: 0,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <Stack spacing={0.75} sx={{ px: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, mb: 0.25 }}>
                  <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ minHeight: 40, alignItems: 'center' }}>
                    <Skeleton variant="rounded" width={180} height={32} />
                    <Skeleton variant="rounded" width={108} height={32} />
                    <Skeleton variant="rounded" width={160} height={32} />
                  </Stack>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" alignItems="center">
                    <Skeleton variant="rounded" width={148} height={36} />
                    <Box sx={{ flex: 1, minWidth: 0 }} />
                    <Skeleton variant="rounded" width={94} height={28} />
                    <Skeleton variant="rounded" width={104} height={28} />
                  </Stack>
                </Stack>
                <Box
                  sx={{
                    flex: 1,
                    minHeight: 0,
                    px: { xs: 1, lg: 2 },
                    pb: { xs: 1, lg: 2 },
                    pt: { xs: 0.5, lg: 1 },
                    overflow: 'hidden',
                  }}
                >
                  <Stack spacing={1.25}>
                    {messageCardSkeletons.map((card, index) => (
                      <Box
                        key={index}
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          p: 1.5,
                          bgcolor: 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        <Stack spacing={1}>
                          <Stack spacing={0.75}>
                            <Skeleton variant="rounded" width={card.lines[0]} height={20} />
                            <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
                              <Skeleton variant="rounded" width={88} height={24} />
                              <Skeleton variant="rounded" width={72} height={24} />
                              <Skeleton variant="rounded" width={96} height={24} />
                            </Stack>
                          </Stack>
                          <Stack spacing={0.75}>
                            <Skeleton variant="rounded" height={card.bodyHeight} />
                            <Stack direction="row" spacing={1} flexWrap="wrap">
                              {card.lines.slice(1).map((lineWidth, lineIndex) => (
                                <Skeleton key={lineIndex} variant="rounded" width={lineWidth} height={16} />
                              ))}
                            </Stack>
                          </Stack>
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </Paper>

              {rightPanelVisible ? (
                <Paper
                  variant="outlined"
                  component="aside"
                  aria-label="Аналітична права секція"
                  aria-disabled="true"
                  sx={{
                    minHeight: 0,
                    height: { xs: 'auto', lg: '100%' },
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    opacity: 0.55,
                  }}
                >
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      p: { xs: 1, lg: 2 },
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <Stack spacing={2}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                        <Skeleton variant="text" width={280} height={40} />
                        <Stack direction="row" spacing={1}>
                          <Skeleton variant="rounded" width={92} height={28} />
                          <Skeleton variant="rounded" width={92} height={28} />
                        </Stack>
                      </Stack>
                      {Array.from({ length: 6 }).map((_, index) => (
                        <Skeleton key={index} variant="rounded" height={72} />
                      ))}
                      <Skeleton variant="rounded" height={72} />
                    </Stack>
                  </Box>
                </Paper>
              ) : null}
            </>
          ) : (
            <>
              {leftPanelVisible ? (
              <Paper
                variant="outlined"
                component="aside"
                aria-label="Панель фільтрів"
                sx={{
                  minHeight: 0,
                  height: { xs: 'auto', lg: '100%' },
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                  }}
                >
                    <AnalysisFiltersPanel page={page} />
                </Box>
              </Paper>
              ) : null}

              <Paper
                variant="outlined"
                component="section"
                aria-labelledby={activeTabId}
                sx={{
                  minHeight: 0,
                  minWidth: 0,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <Stack spacing={0.75} sx={{ px: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, mb: centerTab === 'messages' ? 0.25 : 0 }}>
                  <Tabs
                    value={centerTab}
                    onChange={(_event, value) => page.setCenterTab(value)}
                    variant="scrollable"
                    scrollButtons={isMobileLayout ? false : 'auto'}
                    sx={{
                      minHeight: 0,
                      width: '100%',
                      ml: 0,
                      '& .MuiTabs-flexContainer': { gap: 1 },
                      '& .MuiTab-root': { minHeight: 40, px: 1, py: 0.5, whiteSpace: 'nowrap' },
                      '& .MuiTab-iconWrapper': { mr: 0.75, mb: 0 },
                    }}
                    aria-label="Центральна панель аналізу"
                  >
                    {centerTabs.map((tab) => {
                      const meta = ANALYSIS_CENTER_TAB_META[tab];
                      const Icon = meta.icon;
                      if (tab === 'messages') {
                        return (
                          <Tab
                            key={tab}
                            id={messagesTabId}
                            aria-controls={messagesPanelId}
                            value="messages"
                            icon={<Icon />}
                            iconPosition="start"
                            label={`${meta.label} (${page.messages.length})`}
                          />
                        );
                      }
                      if (tab === 'summary') {
                        return (
                          <Tab
                            key={tab}
                            id={summaryTabId}
                            aria-controls={summaryPanelId}
                            value="summary"
                            icon={<Icon sx={{ fontSize: 20 }} />}
                            iconPosition="start"
                            label={meta.label}
                          />
                        );
                      }
                      return (
                        <Tab
                          key={tab}
                          id={mapTabId}
                          aria-controls={mapPanelId}
                          value="map"
                          icon={<Icon />}
                          iconPosition="start"
                          label={meta.label}
                        />
                      );
                    })}
                  </Tabs>
                  {centerTab === 'messages' ? (
                    <Stack
                      direction="row"
                      spacing={0.75}
                      flexWrap={{ xs: 'wrap', sm: 'nowrap' }}
                      alignItems="center"
                      justifyContent="space-between"
                      role="status"
                      aria-live="polite"
                      aria-label="Поточна статистика вибірки"
                      sx={{ width: '100%', minWidth: 0 }}
                    >
                      <FormControlLabel
                        control={<Switch checked={page.newestFirst} onChange={(_event, value) => page.setNewestFirst(value)} />}
                        label="спочатку нові"
                        sx={{
                          mr: 0,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                          '& .MuiFormControlLabel-label': { fontSize: { xs: 12.5, sm: 13 }, fontWeight: 500, lineHeight: 1.2 },
                        }}
                      />
                      <Stack
                        direction="row"
                        spacing={0.75}
                        flexWrap="nowrap"
                        justifyContent="flex-end"
                        sx={{ ml: 'auto', minWidth: 0, flexShrink: 0, width: 'auto' }}
                      >
                        <PowerChip
                          label={`Всього: ${page.countsLoading ? NO_DATA_LABEL : (page.counts?.countOverall ?? 0)}`}
                          color="default"
                          size="small"
                          fontSize="0.875rem"
                          labelPaddingX={0.75}
                        />
                        <PowerChip
                          label={`Обрано: ${page.countsLoading ? NO_DATA_LABEL : (page.counts?.countSelected ?? 0)}`}
                          color="primary"
                          selected
                          size="small"
                          fontSize="0.875rem"
                          labelPaddingX={0.75}
                        />
                      </Stack>
                    </Stack>
                  ) : null}
                </Stack>
                  <Box
                    sx={{
                      flex: 1,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    overflowY: { xs: 'auto', lg: 'hidden' },
                    overflowX: 'hidden',
                    WebkitOverflowScrolling: 'touch',
                    overscrollBehavior: { xs: 'contain', lg: 'auto' },
                  }}
                >
                  <Box
                    id={messagesPanelId}
                    role="tabpanel"
                    hidden={centerTab !== 'messages'}
                    aria-labelledby={messagesTabId}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      px: { xs: 1, lg: 2 },
                      pb: { xs: 1, lg: 2 },
                      pt: { xs: 0.5, lg: 1 },
                      display: centerTab === 'messages' ? 'flex' : 'none',
                      overflow: 'hidden',
                    }}
                  >
                    <AnalysisMessagesPane
                      authUserName={page.authUserName}
                      currentUser={page.currentUser}
                      copiedFeedbackId={page.copiedFeedbackId}
                      editorMessage={page.editorMessage}
                      editorSaveInFlight={page.editorSaveInFlight}
                      groupInfos={page.groupInfos}
                      loading={messagesPaneLoading}
                      paginationLoading={page.messagesPaging}
                      messageComments={page.messageComments}
                      messages={page.messages}
                      networkDisplayMap={page.networkDisplayMap}
                      noMoreToLoad={page.noMoreToLoad}
                      onCloseEditor={page.closeEditor}
                      onDeleteMessage={page.onDeleteMessage}
                      onLoadMoreMessages={page.loadMoreMessages}
                      onOpenEditor={page.openEditor}
                      onSaveEditor={page.saveEditor}
                      onSaveMessageUpdate={page.saveMessageUpdate}
                      onSaveMessageComment={page.onSaveMessageComment}
                      onToggleMessageBookmark={page.onToggleMessageBookmark}
                      onToggleMessageImportant={page.onToggleMessageImportant}
                      onToggleMessageTag={page.onToggleMessageTag}
                      onAddFrequencyToFilter={page.addFrequencyToFilter}
                      profiles={page.profiles}
                      users={page.users}
                      tagsMap={page.tagsMap}
                      tagsLoading={page.filtersLoading && Object.keys(page.tagsMap).length === 0}
                      tagsLayout={page.tagsLayout}
                      searchText={page.queryState.search}
                      callsignInfoMap={page.summaryCallsignsInfo}
                      networks={page.networks}
                      unitsMap={page.unitsMap}
                    />
                  </Box>

                  <Box
                    id={summaryPanelId}
                    role="tabpanel"
                    hidden={centerTab !== 'summary'}
                    aria-labelledby={summaryTabId}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      px: { xs: 1, lg: 2 },
                      pb: { xs: 1, lg: 2 },
                      pt: { xs: 0.5, lg: 1 },
                      display: centerTab === 'summary' ? 'flex' : 'none',
                      overflow: 'hidden',
                    }}
                  >
                    {centerTab === 'summary' ? (
                      <AnalysisSummaryTableCard
                        callsignInfoMap={page.summaryCallsignsInfo}
                        networkDisplayMap={page.networkDisplayMap}
                        networks={page.networks}
                        onDownloadXlsx={page.downloadSummaryXlsx}
                        onRenameUnit={page.renameSummaryUnit}
                        onSelectFreq={page.selectOnlyFreq}
                        onShowFreqOnMap={page.showFreqOnMap}
                        loaded={page.summaryHasLoadedOnce}
                        loading={page.summaryLoading}
                        rows={page.summaryRows}
                        sx={{ flex: 1, minWidth: 0 }}
                        tableContainerSx={{ maxHeight: '100%' }}
                        title="Таблиця частот"
                        unitsMap={page.unitsMap}
                      />
                    ) : null}
                  </Box>

                  <Box
                    id={mapPanelId}
                    role="tabpanel"
                    hidden={centerTab !== 'map'}
                    aria-labelledby={mapTabId}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      px: 0,
                      pb: 0,
                      display: centerTab === 'map' ? 'flex' : 'none',
                      overflow: 'hidden',
                    }}
                  >
                    {centerTab === 'map' ? (
                      <AnalysisMapPane
                        mapAttrs={page.mapAttrs}
                        search={page.queryState.search}
                        visible
                        onDateRangeChange={page.refreshMapDateRange}
                        onLoadMessages={page.loadMessagesForMap}
                        onUnitClick={page.toggleUnitFromMap}
                      />
                    ) : null}
                  </Box>
                </Box>

              </Paper>

              {rightPanelVisible ? (
                <Paper
                  variant="outlined"
                  component="aside"
                  aria-label="Аналітична права секція"
                  sx={{
                    minHeight: 0,
                    height: { xs: 'auto', lg: '100%' },
                    overflow: 'hidden',
                    display: 'flex',
                  }}
                >
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                    }}
                  >
                    <AnalysisSidebar {...page} />
                  </Box>
                </Paper>
              ) : null}
            </>
          )}
        </Box>

      </Box>

      <AnalysisReportDialog
        aors={page.aorEntries}
        currentUser={page.currentUser}
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
    </Box>
  );
}
