import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import MessageOutlinedIcon from '@mui/icons-material/MessageOutlined';
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import {
  Badge,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useId } from 'react';
import { useTheme } from '@mui/material/styles';

import { PageHeader } from '../../components/PageHeader';
import { PowerChip } from '../../components/PowerChip';
import { PowerAlert } from '../../components/PowerAlert';
import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisReportDialog } from './components/AnalysisReportDialog';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { useMinDurationBusy } from './use-min-duration-busy';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';
import type { AnalysisSidebarTab } from './types';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
};

export function RerAnalysisNeoPage({ authUserName = null }: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName);
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const showLoadingSkeletons = !page.hasLoadedInitialMessages && page.messagesLoading;
  const fixedPanelWidth = '400px';
  const collapsedPanelWidth = '56px';
  const leftColumnWidth = page.leftPanelOpen ? fixedPanelWidth : collapsedPanelWidth;
  const rightColumnWidth = page.rightPanelOpen ? 'minmax(0,1fr)' : collapsedPanelWidth;
  const activeTabId = page.centerTab === 'messages' ? messagesTabId : summaryTabId;
  const messagesPaneLoading = useMinDurationBusy(page.messagesLoading, 450);
  const gridTemplateColumns = {
    xs: '1fr',
    lg: [leftColumnWidth, 'minmax(0,1fr)', rightColumnWidth].join(' '),
  };
  const openRightSidebarTab = (tab: AnalysisSidebarTab) => {
    if (!page.rightPanelOpen) {
      page.toggleRightPanel();
    }
    page.setRightSidebarTab(tab);
  };

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: { xs: 1, lg: 2 },
        pb: { xs: 2, lg: 2 },
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title="Аналіз"
        middle={<AnalysisHeaderControls queryState={page.queryState} updateQueryState={page.updateQueryState} />}
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
        actions={
          <Button
            variant="contained"
            color="primary"
            onClick={page.openReport}
            title="Відкрити конструктор звітів"
            sx={{ height: 44, px: 2, display: { xs: 'none', md: 'inline-flex' } }}
          >
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
                    flex: 1,
                    minWidth: 0,
                    borderRight: '1px solid',
                    borderColor: 'divider',
                    overflow: 'hidden',
                    display: { xs: 'flex', lg: page.leftPanelOpen ? 'block' : 'none' },
                    flexDirection: 'column',
                    height: '100%',
                  }}
                >
                  <AnalysisFiltersPanel {...page} />
                </Box>
                <Box
                  sx={{
                    width: 56,
                    minWidth: 56,
                    flexShrink: 0,
                    display: { xs: 'none', lg: 'flex' },
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 0,
                    py: 0,
                    bgcolor: 'background.paper',
                  }}
                >
                  <Tooltip title={page.leftPanelOpen ? 'Згорнути панель фільтрів' : 'Розгорнути панель фільтрів'} arrow placement="right">
                    <IconButton
                      size="small"
                      onClick={page.toggleLeftPanel}
                      aria-label={page.leftPanelOpen ? 'Згорнути панель фільтрів' : 'Розгорнути панель фільтрів'}
                      sx={{ width: 56, height: 56, p: 0, borderRadius: 0 }}
                    >
                      {page.leftPanelOpen ? (
                        <ChevronLeftOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      ) : (
                        <ChevronRightOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      )}
                    </IconButton>
                  </Tooltip>
                  <Box sx={{ width: 56, borderBottom: '1px solid', borderColor: 'divider' }} />
                  <Tooltip title={page.canResetFilters ? 'Є незбережені зміни' : 'Фільтри'} arrow placement="right">
                    <Box sx={{ pt: 1.25, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Badge color="error" variant="dot" invisible={!page.canResetFilters}>
                        <FilterAltOutlinedIcon
                          sx={{ fontSize: 20, color: page.canResetFilters ? 'primary.main' : 'text.secondary' }}
                        />
                      </Badge>
                    </Box>
                  </Tooltip>
                </Box>
              </Paper>

              <Paper
                variant="outlined"
                component="section"
                aria-label="Центральна секція"
                aria-disabled="true"
                sx={{
                  gridColumn: { lg: 2 },
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
                  <Skeleton variant="text" width={320} height={40} />
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Skeleton variant="rounded" width={160} height={32} />
                    <Skeleton variant="rounded" width={88} height={32} />
                    <Skeleton variant="rounded" width={112} height={32} />
                  </Stack>
                </Stack>
                <Box sx={{ flex: 1, minHeight: 0, px: { xs: 1, lg: 2 }, pb: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, overflow: 'hidden' }}>
                  <Stack spacing={1.5}>
                    {Array.from({ length: 7 }).map((_, index) => (
                      <Skeleton key={index} variant="rounded" height={72} />
                    ))}
                  </Stack>
                </Box>
              </Paper>

              <Paper
                variant="outlined"
                component="aside"
                aria-label="Аналітична права секція"
                aria-disabled="true"
                sx={{
                  gridColumn: { lg: 3 },
                  minHeight: 0,
                  height: { xs: 'auto', lg: '100%' },
                  overflow: 'hidden',
                  display: { xs: 'block', lg: 'flex' },
                  opacity: 0.55,
                }}
              >
                <Box
                  sx={{
                    width: 56,
                    minWidth: 56,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 0,
                    py: 0,
                    bgcolor: 'background.paper',
                  }}
                >
                  <Box
                    sx={{
                      width: 56,
                      height: 56,
                      borderBottom: '1px solid',
                      borderColor: 'divider',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                    >
                    <IconButton size="small" disabled aria-label="Права секція" sx={{ width: 56, height: 56, p: 0, borderRadius: 0 }}>
                      <ChevronLeftOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    </IconButton>
                  </Box>
                  <Stack spacing={0.75} alignItems="center" sx={{ pt: 1.25 }}>
                    {[
                      { tab: 'map' as const, icon: MapOutlinedIcon, label: 'Мапа' },
                      { tab: 'stats' as const, icon: BarChartOutlinedIcon, label: 'Зведення' },
                      { tab: 'callsigns' as const, icon: PeopleOutlineOutlinedIcon, label: 'Позивні' },
                      { tab: 'newCallsigns' as const, icon: PersonAddOutlinedIcon, label: 'Нові' },
                    ].map((item) => {
                      const Icon = item.icon;
                      const active = page.rightSidebarTab === item.tab;
                      return (
                        <IconButton
                          key={item.tab}
                          size="small"
                          disabled
                          aria-label={item.label}
                          aria-pressed={active}
                          sx={{
                            width: 44,
                            height: 44,
                            borderRadius: '50%',
                            color: active ? 'primary.main' : 'text.secondary',
                            bgcolor: active ? 'action.selected' : 'transparent',
                          }}
                        >
                          <Icon sx={{ fontSize: 20 }} />
                        </IconButton>
                      );
                    })}
                  </Stack>
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    borderLeft: '1px solid',
                    borderColor: 'divider',
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
                    flex: 1,
                    minWidth: 0,
                    borderRight: '1px solid',
                    borderColor: 'divider',
                    overflow: 'hidden',
                    display: { xs: 'block', lg: page.leftPanelOpen ? 'block' : 'none' },
                  }}
                >
                  <AnalysisFiltersPanel {...page} />
                </Box>
                <Box
                  sx={{
                    width: 56,
                    minWidth: 56,
                    flexShrink: 0,
                    display: { xs: 'none', lg: 'flex' },
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 0,
                    py: 0,
                    bgcolor: 'background.paper',
                  }}
                >
                  <Tooltip title={page.leftPanelOpen ? 'Згорнути панель фільтрів' : 'Розгорнути панель фільтрів'} arrow placement="right">
                    <IconButton
                      size="small"
                      onClick={page.toggleLeftPanel}
                      aria-label={page.leftPanelOpen ? 'Згорнути панель фільтрів' : 'Розгорнути панель фільтрів'}
                      sx={{ width: 56, height: 56, p: 0, borderRadius: 0 }}
                    >
                      {page.leftPanelOpen ? (
                        <ChevronLeftOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      ) : (
                        <ChevronRightOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      )}
                    </IconButton>
                  </Tooltip>
                  <Box sx={{ width: 56, borderBottom: '1px solid', borderColor: 'divider' }} />
                  <Tooltip title={page.canResetFilters ? 'Є незбережені зміни' : 'Фільтри'} arrow placement="right">
                    <Box sx={{ pt: 1.25, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Badge color="error" variant="dot" invisible={!page.canResetFilters}>
                        <FilterAltOutlinedIcon
                          sx={{ fontSize: 20, color: page.canResetFilters ? 'primary.main' : 'text.secondary' }}
                        />
                      </Badge>
                    </Box>
                  </Tooltip>
                </Box>
              </Paper>

              <Paper
                variant="outlined"
                component="section"
                aria-labelledby={activeTabId}
                sx={{
                  gridColumn: { lg: 2 },
                  minHeight: 0,
                  minWidth: 0,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <Stack spacing={0.75} sx={{ px: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, mb: page.centerTab === 'summary' ? 0 : 0.25 }}>
                  <Tabs
                    value={page.centerTab}
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
                    <Tab
                      id={messagesTabId}
                      aria-controls={messagesPanelId}
                      value="messages"
                      icon={<MessageOutlinedIcon />}
                      iconPosition="start"
                      label={`Повідомлення (${page.messages.length})`}
                    />
                    <Tab
                      id={summaryTabId}
                      aria-controls={summaryPanelId}
                      value="summary"
                      icon={<TableRowsOutlinedIcon sx={{ fontSize: 20 }} />}
                      iconPosition="start"
                      label="Таблиця: Частоти"
                    />
                  </Tabs>
                  {page.centerTab === 'summary' ? null : (
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
                        {page.countsLoading ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 32, px: 1.5 }}>
                            <CircularProgress size={18} thickness={5} />
                          </Box>
                        ) : (
                          <>
                            <PowerChip
                              label={'Всього: ' + (page.counts?.countOverall ?? 0)}
                              color="default"
                              size="small"
                              fontSize="0.875rem"
                              labelPaddingX={0.75}
                            />
                            <PowerChip
                              label={'Обрано: ' + (page.counts?.countSelected ?? 0)}
                              color="primary"
                              selected
                              size="small"
                              fontSize="0.875rem"
                              labelPaddingX={0.75}
                            />
                          </>
                        )}
                      </Stack>
                    </Stack>
                  )}
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
                    hidden={page.centerTab !== 'messages'}
                    aria-labelledby={messagesTabId}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      px: { xs: 1, lg: 2 },
                      pb: { xs: 1, lg: 2 },
                      pt: { xs: 0.5, lg: 1 },
                      display: page.centerTab === 'messages' ? 'flex' : 'none',
                      overflow: 'hidden',
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
                      onSaveMessageUpdate={page.saveMessageUpdate}
                      onSaveMessageComment={page.onSaveMessageComment}
                      onToggleMessageBookmark={page.onToggleMessageBookmark}
                      onToggleMessageImportant={page.onToggleMessageImportant}
                      onToggleMessageTag={page.onToggleMessageTag}
                      profiles={page.profiles}
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
                    hidden={page.centerTab !== 'summary'}
                    aria-labelledby={summaryTabId}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      px: 2,
                      pb: 2,
                      display: page.centerTab === 'summary' ? 'flex' : 'none',
                      overflow: 'hidden',
                    }}
                  >
                    {page.centerTab === 'summary' ? (
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
                </Box>

              </Paper>

              <Paper
                variant="outlined"
                component="aside"
                aria-label="Аналітична права секція"
                sx={{
                  gridColumn: { lg: 3 },
                  minHeight: 0,
                  height: { xs: 'auto', lg: '100%' },
                  overflow: 'hidden',
                  display: { xs: 'block', lg: 'flex' },
                }}
              >
                <Box
                  sx={{
                    width: 56,
                    minWidth: 56,
                    flexShrink: 0,
                    display: { xs: 'none', lg: 'flex' },
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 0,
                    py: 0,
                    bgcolor: 'background.paper',
                  }}
                >
                  <Tooltip title={page.rightPanelOpen ? 'Згорнути праву секцію' : 'Розгорнути праву секцію'} arrow placement="left">
                    <IconButton
                      size="small"
                      onClick={page.toggleRightPanel}
                      aria-label={page.rightPanelOpen ? 'Згорнути праву секцію' : 'Розгорнути праву секцію'}
                      sx={{ width: 56, height: 56, p: 0, borderRadius: 0 }}
                    >
                      {page.rightPanelOpen ? (
                        <ChevronRightOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      ) : (
                        <ChevronLeftOutlinedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                      )}
                    </IconButton>
                  </Tooltip>
                  <Box sx={{ width: 56, borderBottom: '1px solid', borderColor: 'divider' }} />
                  <Stack spacing={0.75} alignItems="center" sx={{ pt: 1.25 }}>
                    {[
                      { tab: 'map' as const, icon: MapOutlinedIcon, label: 'Мапа' },
                      { tab: 'stats' as const, icon: BarChartOutlinedIcon, label: 'Зведення' },
                      { tab: 'callsigns' as const, icon: PeopleOutlineOutlinedIcon, label: 'Позивні' },
                      { tab: 'newCallsigns' as const, icon: PersonAddOutlinedIcon, label: 'Нові' },
                    ].map((item) => {
                      const Icon = item.icon;
                      const active = page.rightSidebarTab === item.tab;
                      return (
                        <Tooltip key={item.tab} title={item.label} arrow placement="left">
                          <IconButton
                            size="small"
                            onClick={() => openRightSidebarTab(item.tab)}
                            aria-label={item.label}
                            aria-pressed={active}
                            sx={{
                              width: 44,
                              height: 44,
                              borderRadius: '50%',
                              color: active ? 'primary.main' : 'text.secondary',
                              bgcolor: active ? 'action.selected' : 'transparent',
                            }}
                          >
                            <Icon sx={{ fontSize: 20 }} />
                          </IconButton>
                        </Tooltip>
                      );
                    })}
                  </Stack>
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    borderLeft: '1px solid',
                    borderColor: 'divider',
                    overflow: 'hidden',
                    display: { xs: 'block', lg: page.rightPanelOpen ? 'block' : 'none' },
                  }}
                >
                  <AnalysisSidebar {...page} />
                </Box>
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
