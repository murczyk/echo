import { Box, FormControlLabel, Stack, Switch, Tab, Tabs } from '@mui/material';

import { PowerChip } from '../../components/PowerChip';
import { NO_DATA_LABEL } from '../../utils/misc';
import { AnalysisMapPane } from './components/AnalysisMapPane';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisPaginationControl } from './components/AnalysisPaginationControl';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { ANALYSIS_CENTER_TAB_META } from './analysis-center-tabs';
import { analysisCompactTabsSx } from './analysis-tab-styles';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from './helpers';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  centerTab: AnalysisCenterTab;
  centerTabs: AnalysisCenterTab[];
  isCompactLayout?: boolean;
  isNarrowLayout: boolean;
  rightPanelVisible: boolean;
  messagesPaneLoading: boolean;
  messagesPanelId: string;
  messagesTabId: string;
  summaryPanelId: string;
  summaryTabId: string;
  mapPanelId: string;
  mapTabId: string;
};

export function AnalysisCenterPanel({
  page,
  centerTab,
  centerTabs,
  isCompactLayout = false,
  isNarrowLayout,
  rightPanelVisible,
  messagesPaneLoading,
  messagesPanelId,
  messagesTabId,
  summaryPanelId,
  summaryTabId,
  mapPanelId,
  mapTabId,
}: Props) {
  // Flush, full-height divider on the column edge for every tab — mirrors the
  // left panel's `border-r` so both sides read identically. (Previously the
  // messages tab drew its own inset border on the scroll area, which sat 16px
  // inside the column padding and looked misaligned with the left divider.)
  // Columns stack below MUI's `lg` (1200px), so the divider is gated to
  // `min-[1200px]`.
  const showRightDivider = rightPanelVisible;

  return (
    <section
      aria-labelledby={
        centerTab === 'messages' ? messagesTabId : centerTab === 'summary' ? summaryTabId : mapTabId
      }
      className={
        'relative flex min-h-0 min-w-0 h-full flex-col overflow-hidden' +
        (showRightDivider
          ? ' min-[1200px]:border-r min-[1200px]:border-solid min-[1200px]:border-black/12 dark:min-[1200px]:border-white/12'
          : '')
      }
    >
      <Stack
        direction={isNarrowLayout ? 'row' : { xs: 'column', lg: 'row' }}
        alignItems={isNarrowLayout ? 'center' : { xs: 'stretch', lg: 'center' }}
        justifyContent="space-between"
        spacing={isCompactLayout ? 0.5 : 1}
        sx={{ px: { xs: 1, lg: 2 }, pt: 0, mb: 0, flexShrink: 0 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Tabs
            value={centerTab}
            onChange={(_event, value) => page.setCenterTab(value)}
            variant="scrollable"
            scrollButtons={isCompactLayout ? false : 'auto'}
            sx={{
              ...analysisCompactTabsSx,
              flex: 1,
              minWidth: 0,
              ml: 0,
              ...(isCompactLayout
                ? {
                    '& .MuiTabs-flexContainer': { gap: 0.25 },
                    '& .MuiTab-root': {
                      width: 34,
                      minWidth: 34,
                      minHeight: 34,
                      px: 0.5,
                      py: 0.25,
                    },
                    '& .MuiTab-iconWrapper': { mr: 0, mb: 0 },
                  }
                : {}),
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
                    label={isCompactLayout ? undefined : meta.label}
                    aria-label={isCompactLayout ? meta.label : undefined}
                    title={isCompactLayout ? meta.label : undefined}
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
                    icon={<Icon />}
                    iconPosition="start"
                    label={isCompactLayout ? undefined : meta.label}
                    aria-label={isCompactLayout ? meta.label : undefined}
                    title={isCompactLayout ? meta.label : undefined}
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
                  label={isCompactLayout ? undefined : meta.label}
                  aria-label={isCompactLayout ? meta.label : undefined}
                  title={isCompactLayout ? meta.label : undefined}
                />
              );
            })}
          </Tabs>
        </Box>
        {isNarrowLayout && centerTab === 'messages' ? (
          <AnalysisPaginationControl
            centerTab={centerTab}
            pageIndex={page.pageIndex}
            pageSize={ANALYSIS_MESSAGES_PAGE_SIZE}
            messagesCount={page.messages.length}
            totalCount={page.messagesTotalCount}
            totalLoading={page.messagesTotalLoading}
            loading={page.messagesLoading}
            noMoreToLoad={page.noMoreToLoad}
            busy={page.messagesPaging || page.messagesLoading}
            onFirstPage={page.loadFirstPage}
            onLastPage={page.loadLastPage}
            onPrevPage={page.loadPrevPage}
            onNextPage={page.loadNextPage}
          />
        ) : null}
        {!isNarrowLayout ? (
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={page.newestFirst}
                onChange={(_event, value) => page.setNewestFirst(value)}
                sx={{
                  width: 34,
                  height: 20,
                  p: 0,
                  mr: 0.5,
                  '& .MuiSwitch-switchBase': {
                    p: '2px',
                    '&.Mui-checked': { transform: 'translateX(14px)' },
                  },
                  '& .MuiSwitch-thumb': { width: 16, height: 16 },
                  '& .MuiSwitch-track': { borderRadius: 10 },
                }}
              />
            }
            label="спочатку нові"
            sx={{
              width: 110,
              height: 34,
              m: 0,
              flexShrink: 0,
              justifyContent: 'flex-end',
              whiteSpace: 'nowrap',
              visibility: centerTab === 'messages' ? 'visible' : 'hidden',
              pointerEvents: centerTab === 'messages' ? 'auto' : 'none',
              '& .MuiFormControlLabel-label': {
                fontSize: 11.5,
                fontWeight: 500,
                lineHeight: 1.2,
              },
            }}
          />
        ) : null}
      </Stack>

      <Box
        sx={{
          flex: 1,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
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
            height: '100%',
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
            minHeight: 0,
            px: 1,
            pb: { xs: 1, lg: 0 },
            pt: { xs: 0.5, lg: 1 },
            display: centerTab === 'messages' ? 'flex' : 'none',
            overflow: 'hidden',
          }}
        >
          <AnalysisMessagesPane
            authUserName={page.authUserName}
            currentUser={page.currentUser}
            copiedFeedbackId={page.copiedFeedbackId}
            groupInfos={page.groupInfos}
            loading={messagesPaneLoading}
            paginationLoading={page.messagesPaging}
            botTagAction={page.botTagAction}
            messageComments={page.messageComments}
            messages={page.messages}
            networkDisplayMap={page.networkDisplayMap}
            pageIndex={page.pageIndex}
            noMoreToLoad={page.noMoreToLoad}
            onDeleteMessage={page.onDeleteMessage}
            onCancelBotTagAction={page.onCancelBotTagAction}
            onMarkBotTagWrong={page.onMarkBotTagWrong}
            onOpenEditor={page.openEditor}
            onLoadMoreMessages={page.loadMoreMessages}
            onOpenPointsOnMap={page.openPointsOnMap}
            onAddPointHighlightBlacklist={page.onAddPointHighlightBlacklist}
            onSaveMessageUpdate={page.saveMessageUpdate}
            onSaveMessageComment={page.onSaveMessageComment}
            onToggleMessageBookmark={page.onToggleMessageBookmark}
            onToggleMessageImportant={page.onToggleMessageImportant}
            onToggleMessageTag={page.onToggleMessageTag}
            onAddFrequencyToFilter={page.addFrequencyToFilter}
            profiles={page.profiles}
            tagsMap={page.tagsMap}
            tagsOrder={page.tagsOrder}
            tagsLoading={page.filtersLoading && Object.keys(page.tagsMap).length === 0}
            tagsLayout={page.tagsLayout}
            showCallsignAddForm={page.showAnalysisCallsignAddForm}
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
            height: '100%',
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
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
            height: { xs: '100%', sm: '100%', lg: 'auto' },
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
    </section>
  );
}
