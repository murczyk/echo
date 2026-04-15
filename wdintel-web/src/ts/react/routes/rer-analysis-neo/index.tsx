import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import MessageOutlinedIcon from '@mui/icons-material/MessageOutlined';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import { Backdrop, Box, Button, CircularProgress, FormControlLabel, Paper, Skeleton, Stack, Switch, Tab, Tabs } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerChip } from '../../components/PowerChip';
import { loadingOverlayBackdropSx } from '../../components/loadingOverlayStyles';
import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import { AnalysisMapPane } from './components/AnalysisMapPane';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisReportDialog } from './components/AnalysisReportDialog';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { useMinDurationBusy } from './use-min-duration-busy';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';
import { PowerAlert } from '../../components/PowerAlert';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
};

export function RerAnalysisNeoPage({ authUserName = null }: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName);
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const mapTabId = `${centerTabsId}-map-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const mapPanelId = `${centerTabsId}-map-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const showLoadingSkeletons = page.messagesLoading && page.messages.length === 0 && page.counts == null;
  const [mountedTabs, setMountedTabs] = useState<Record<'messages' | 'map' | 'summary', boolean>>({
    messages: true,
    map: false,
    summary: false,
  });
  const fixedPanelWidth = '400px';
  const collapsedPanelWidth = '28px';
  const leftColumnWidth = page.leftPanelOpen ? fixedPanelWidth : collapsedPanelWidth;
  const rightColumnWidth =
    page.centerTab === 'messages'
      ? page.rightPanelOpen
        ? 'minmax(0,1fr)'
        : collapsedPanelWidth
      : page.rightPanelOpen
        ? fixedPanelWidth
        : collapsedPanelWidth;
  const activeTabId = page.centerTab === 'messages' ? messagesTabId : page.centerTab === 'map' ? mapTabId : summaryTabId;
  const centerPanelBusy = useMinDurationBusy(
    page.centerTabPending || page.editorSaveInFlight || page.messageActionLoading,
    450,
  );
  const messagesPaneLoading = useMinDurationBusy(page.messagesLoading, 450);
  const gridTemplateColumns = {
    xs: '1fr',
    lg: [leftColumnWidth, 'minmax(0,1fr)', rightColumnWidth].join(' '),
  };

  useEffect(() => {
    setMountedTabs((current) => (current[page.centerTab] ? current : { ...current, [page.centerTab]: true }));
  }, [page.centerTab]);

  return (
    <Box sx={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
      <PageHeader
        title="Аналіз"
        actions={
          <Button variant="contained" color="primary" onClick={page.openReport} title="Відкрити конструктор звітів" sx={{ height: 44, px: 2 }}>
            Конструктор звітів
          </Button>
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
              <Paper
                variant="outlined"
                sx={{ p: 2, minHeight: 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}
              >
                <Stack spacing={2}>
                  <Skeleton variant="text" width={96} height={36} />
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                    <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
                    <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
                  </Stack>
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                    <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
                    <Skeleton variant="rounded" height={40} sx={{ flex: 1 }} />
                  </Stack>
                  <Skeleton variant="rounded" height={56} />
                  {Array.from({ length: 8 }).map((_, index) => (
                    <Skeleton key={index} variant="rounded" height={56} />
                  ))}
                </Stack>
              </Paper>

              <Paper
                variant="outlined"
                sx={{ p: 2, minHeight: 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}
              >
                <Stack spacing={2}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                    <Skeleton variant="text" width={280} height={40} />
                    <Stack direction="row" spacing={2}>
                      <Skeleton variant="rounded" width={92} height={28} />
                      <Skeleton variant="rounded" width={92} height={28} />
                    </Stack>
                  </Stack>
                  {Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} variant="rounded" height={72} />
                  ))}
                  <Skeleton variant="rounded" height={72} />
                </Stack>
              </Paper>

              <Paper
                variant="outlined"
                component="aside"
                aria-label="Аналітична права секція"
                aria-disabled="true"
                sx={{
                  minHeight: 0,
                  height: "100%",
                  overflow: "hidden",
                  display: { xs: 'none', lg: 'flex' },
                  opacity: 0.55,
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'background.paper',
                    borderRight: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Box component="i" className="bi bi-chevron-left" sx={{ fontSize: 16, color: 'text.secondary' }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
                  <Skeleton variant="rounded" sx={{ flex: 1, minHeight: 240 }} />
                </Box>
              </Paper>

            </>
          ) : (
            <>
              <Paper
                variant="outlined"
                component="aside"
                aria-label="Панель фільтрів"
                sx={{
                  minHeight: 0,
                  height: { xs: 'auto', lg: '100%' },
                  overflow: 'hidden',
                  display: { xs: 'block', lg: 'flex' },
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    flexShrink: 0,
                    borderRight: page.leftPanelOpen ? '1px solid' : 'none',
                    borderColor: 'divider',
                    display: { xs: 'none', lg: 'flex' },
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'background.paper',
                    cursor: 'pointer',
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={page.leftPanelOpen ? 'Згорнути панель фільтрів' : 'Розгорнути панель фільтрів'}
                  onClick={page.toggleLeftPanel}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      page.toggleLeftPanel();
                    }
                  }}
                >
                  <Box component="i" className={page.leftPanelOpen ? 'bi bi-chevron-left' : 'bi bi-chevron-right'} sx={{ fontSize: 16, color: 'text.secondary' }} />
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    display: { xs: 'block', lg: page.leftPanelOpen ? 'block' : 'none' },
                  }}
                >
                  <AnalysisFiltersPanel {...page} />
                </Box>
              </Paper>

              <Paper
                variant="outlined"
                component="section"
                aria-labelledby={activeTabId}
                sx={{ minHeight: 0, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", position: 'relative' }}
              >
                <Stack spacing={0.75} sx={{ px: 2, pt: 1, mb: page.centerTab === 'map' ? 0 : 0.25 }}>
                  <Tabs
                    value={page.centerTab}
                    onChange={(_event, value) => page.setCenterTab(value)}
                    variant="scrollable"
                    allowScrollButtonsMobile
                    sx={{
                      minHeight: 0,
                      ml: -1,
                      width: "100%",
                      "& .MuiTabs-flexContainer": { gap: 1 },
                      "& .MuiTab-root": { minHeight: 40, px: 1, py: 0.5, whiteSpace: "nowrap" },
                      "& .MuiTab-iconWrapper": { mr: 0.75, mb: 0 },
                    }}
                    aria-label="Центральна панель аналізу"
                  >
                    <Tab
                      id={messagesTabId}
                      aria-controls={messagesPanelId}
                      value="messages"
                      icon={<MessageOutlinedIcon />}
                      iconPosition="start"
                      label={`Повідомлення (${page.messages.length})`}
                    />
                    <Tab
                      id={mapTabId}
                      aria-controls={mapPanelId}
                      value="map"
                      icon={<MapOutlinedIcon />}
                      iconPosition="start"
                      label="Мапа"
                    />
                    <Tab
                      id={summaryTabId}
                      aria-controls={summaryPanelId}
                      value="summary"
                      icon={<SettingsInputAntennaOutlinedIcon />}
                      iconPosition="start"
                      label="Частоти"
                    />
                  </Tabs>
                  {page.centerTab === 'map' ? null : (
                    <Stack
                      direction="row"
                      spacing={1.5}
                      flexWrap="wrap"
                      alignItems="center"
                      justifyContent="space-between"
                      role="status"
                      aria-live="polite"
                      aria-label="Поточна статистика вибірки"
                      sx={{ rowGap: 1, width: '100%' }}
                    >
                      <FormControlLabel
                        control={<Switch checked={page.newestFirst} onChange={(_event, value) => page.setNewestFirst(value)} />}
                        label="спочатку нові"
                        sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: 14, fontWeight: 500 } }}
                      />
                      <Stack
                        direction="row"
                        spacing={1.5}
                        flexWrap="wrap"
                        useFlexGap
                        justifyContent="flex-end"
                        sx={{ ml: 'auto', width: { xs: '100%', sm: 'auto' } }}
                      >
                        {page.countsLoading && page.counts == null ? (
                          <>
                            <Skeleton variant="rounded" width={110} height={32} />
                            <Skeleton variant="rounded" width={110} height={32} />
                          </>
                        ) : (
                          <>
                            <PowerChip label={"Всього: " + (page.counts?.countOverall ?? 0)} color="default" />
                            <PowerChip label={"Обрано: " + (page.counts?.countSelected ?? 0)} color="primary" selected />
                          </>
                        )}
                      </Stack>
                    </Stack>
                  )}
                </Stack>

                <Box
                  id={messagesPanelId}
                  role="tabpanel"
                  hidden={page.centerTab !== "messages"}
                  aria-labelledby={messagesTabId}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    px: 2,
                    pb: 2,
                    pt: 1,
                    display: page.centerTab === "messages" ? "flex" : "none",
                    overflow: "hidden",
                  }}
                >
                  <AnalysisMessagesPane
                    authUserName={page.authUserName}
                    copiedFeedbackId={page.copiedFeedbackId}
                    editorMessage={page.editorMessage}
                    editorSaveInFlight={page.editorSaveInFlight}
                    groupInfos={page.groupInfos}
                    loading={messagesPaneLoading}
                    paginationLoading={page.messagesPaging}
                    messages={page.messages}
                    networkDisplayMap={page.networkDisplayMap}
                    noMoreToLoad={page.noMoreToLoad}
                    onCloseEditor={page.closeEditor}
                    onDeleteMessage={page.onDeleteMessage}
                    onLoadMoreMessages={page.loadMoreMessages}
                    onOpenEditor={page.openEditor}
                    onSaveEditor={page.saveEditor}
                    onSaveMessageComment={page.onSaveMessageComment}
                    onToggleMessageBookmark={page.onToggleMessageBookmark}
                    onToggleMessageImportant={page.onToggleMessageImportant}
                    onToggleMessageTag={page.onToggleMessageTag}
                    profiles={page.profiles}
                    tagsMap={page.tagsMap}
                    callsignInfoMap={page.summaryCallsignsInfo}
                    networks={page.networks}
                    unitsMap={page.unitsMap}
                  />
                </Box>

                <Box
                  id={mapPanelId}
                  role="tabpanel"
                  hidden={page.centerTab !== "map"}
                  aria-labelledby={mapTabId}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: page.centerTab === "map" ? "flex" : "none",
                    overflow: "hidden",
                  }}
                >
                  {mountedTabs.map ? (
                    <AnalysisMapPane
                      visible={page.centerTab === "map"}
                      mapAttrs={page.mapAttrs}
                      search={page.queryState.search}
                      onDateRangeChange={page.refreshMapDateRange}
                      onExit={() => page.setCenterTab('messages')}
                      onLoadMessages={page.loadMessagesForMap}
                      onUnitClick={page.toggleUnitFromMap}
                    />
                  ) : null}
                </Box>

                <Box
                  id={summaryPanelId}
                  role="tabpanel"
                  hidden={page.centerTab !== "summary"}
                  aria-labelledby={summaryTabId}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    px: 2,
                    pb: 2,
                    display: page.centerTab === "summary" ? "flex" : "none",
                    overflow: "hidden",
                  }}
                >
                  {mountedTabs.summary ? (
                    <AnalysisSummaryTableCard
                      callsignInfoMap={page.summaryCallsignsInfo}
                      networkDisplayMap={page.networkDisplayMap}
                      networks={page.networks}
                      onDownloadGeojson={page.downloadGeojson}
                      onDownloadKmz={page.downloadKmz}
                      onDownloadXlsx={page.downloadSummaryXlsx}
                      onRenameUnit={page.renameSummaryUnit}
                      onSelectFreq={page.selectOnlyFreq}
                      onShowFreqOnMap={page.showFreqOnMap}
                      loading={page.summaryLoading}
                      rows={page.summaryRows}
                      sx={{ flex: 1, minWidth: 0 }}
                      tableContainerSx={{ maxHeight: '100%' }}
                      title="Таблиця частот"
                      unitsMap={page.unitsMap}
                    />
                  ) : null}
                </Box>

                {centerPanelBusy && !page.messagesLoading && !showLoadingSkeletons ? (
                  <Backdrop open aria-label="Завантаження" sx={(theme) => ({ ...loadingOverlayBackdropSx(theme), display: 'flex' })}>
                    <CircularProgress color="inherit" size={30} />
                  </Backdrop>
                ) : null}
              </Paper>

              <Paper
                variant="outlined"
                component="aside"
                aria-label="Аналітична права секція"
                sx={{
                  minHeight: 0,
                  height: { xs: 'auto', lg: '100%' },
                  overflow: 'hidden',
                  display: { xs: 'block', lg: 'flex' },
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    flexShrink: 0,
                    borderRight: page.rightPanelOpen ? '1px solid' : 'none',
                    borderColor: 'divider',
                    display: { xs: 'none', lg: 'flex' },
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'background.paper',
                    cursor: 'pointer',
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={page.rightPanelOpen ? 'Згорнути праву секцію' : 'Розгорнути праву секцію'}
                  onClick={page.toggleRightPanel}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      page.toggleRightPanel();
                    }
                  }}
                >
                  <Box component="i" className={page.rightPanelOpen ? 'bi bi-chevron-right' : 'bi bi-chevron-left'} sx={{ fontSize: 16, color: 'text.secondary' }} />
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    display: { xs: 'block', lg: page.rightPanelOpen ? 'block' : 'none' },
                  }}
                >
                  <AnalysisSidebar {...page} />
                </Box>
                {!page.rightPanelOpen && showLoadingSkeletons ? (
                  <Box sx={{ flex: 1, minWidth: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
                    <Skeleton variant="rounded" sx={{ flex: 1, minHeight: 240 }} />
                  </Box>
                ) : null}
              </Paper>
            </>
          )}
        </Box>

      </Box>

      <AnalysisReportDialog
        aors={page.aorEntries}
        downloadInFlight={page.reportDownloadInFlight}
        open={page.report.open}
        report={page.report}
        onClose={page.closeReport}
        onDownload={page.downloadReport}
        onUpdate={page.updateReport}
      />
    </Box>
  );
}
