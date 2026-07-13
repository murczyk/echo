import { Box, FormControlLabel, Paper, Stack, Switch, Tab, Tabs } from '@mui/material';

import { PowerChip } from '../../components/PowerChip';
import { NO_DATA_LABEL } from '../../utils/misc';
import { AnalysisMapPane } from './components/AnalysisMapPane';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { ANALYSIS_CENTER_TAB_META } from './analysis-center-tabs';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  centerTab: AnalysisCenterTab;
  centerTabs: AnalysisCenterTab[];
  isMobileLayout: boolean;
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
  isMobileLayout,
  messagesPaneLoading,
  messagesPanelId,
  messagesTabId,
  summaryPanelId,
  summaryTabId,
  mapPanelId,
  mapTabId,
}: Props) {
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={
        centerTab === 'messages' ? messagesTabId : centerTab === 'summary' ? summaryTabId : mapTabId
      }
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
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{ px: { xs: 1, lg: 2 }, pt: { xs: 0.5, lg: 1 }, mb: 0 }}
      >
        <Tabs
          value={centerTab}
          onChange={(_event, value) => page.setCenterTab(value)}
          variant="scrollable"
          scrollButtons={isMobileLayout ? false : 'auto'}
          sx={{
            minHeight: 0,
            flex: 1,
            minWidth: 0,
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
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={page.newestFirst}
                onChange={(_event, value) => page.setNewestFirst(value)}
              />
            }
            label="спочатку нові"
            sx={{
              height: 40,
              mt: -0.25, // slight nudge to align baselines visually
              mr: 0,
              flexShrink: 0,
              whiteSpace: 'nowrap',
              '& .MuiFormControlLabel-label': {
                fontSize: { xs: 12.5, sm: 13 },
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
            botTagAction={page.botTagAction}
            messageComments={page.messageComments}
            messages={page.messages}
            networkDisplayMap={page.networkDisplayMap}
            noMoreToLoad={page.noMoreToLoad}
            onCloseEditor={page.closeEditor}
            onDeleteMessage={page.onDeleteMessage}
            onCancelBotTagAction={page.onCancelBotTagAction}
            onMarkBotTagWrong={page.onMarkBotTagWrong}
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
            tagsMap={page.tagsMap}
            tagsOrder={page.tagsOrder}
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
  );
}
