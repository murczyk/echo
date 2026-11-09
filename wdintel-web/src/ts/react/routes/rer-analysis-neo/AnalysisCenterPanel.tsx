import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import {
  Badge,
  Box,
  Button,
  Collapse,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  useMediaQuery,
} from '@mui/material';
import { useCallback, useEffect, useRef } from 'react';

import { PowerChip } from '../../components/PowerChip';
import { NO_DATA_LABEL } from '../../utils/misc';
import { AnalysisMapPane } from './components/AnalysisMapPane';
import { AnalysisMessagesPane } from './components/AnalysisMessagesPane';
import { AnalysisPaginationControl } from './components/AnalysisPaginationControl';
import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import { AnalysisSummaryTableCard } from './components/AnalysisSummaryTableCard';
import { ANALYSIS_CENTER_TAB_META } from './analysis-center-tabs';
import { analysisCompactTabsSx, analysisNewestFirstLabelSx } from './analysis-tab-styles';
import { getAnalysisActiveFilterCount } from './analysis-active-filter-count';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from './helpers';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';
import { GroupIdentity, groupFilterIdentity } from '../shared/group-navigation';
import {
  MANAGE_MESSAGE_EDITOR_TRANSITION_EASING,
  MANAGE_MESSAGE_EDITOR_TRANSITION_MS,
} from '../shared/manage-message/ManageMessageEditorSurface';
import { AnalysisFullscreenPanelDrawer } from './AnalysisFullscreenPanelDrawer';

type Props = {
  page: AnalysisPageViewModel;
  editorHighlightedMessageId: number | null;
  centerTab: AnalysisCenterTab;
  centerTabs: AnalysisCenterTab[];
  isCompactLayout?: boolean;
  isNarrowLayout: boolean;
  rightPanelVisible: boolean;
  messagesPanelId: string;
  messagesTabId: string;
  summaryPanelId: string;
  summaryTabId: string;
  mapPanelId: string;
  mapTabId: string;
  filtersPanelId: string;
  filterPanelOpen: boolean;
  onToggleFilterPanel: () => void;
  onCloseFilterPanel: () => void;
};

export function AnalysisCenterPanel({
  page,
  editorHighlightedMessageId,
  centerTab,
  centerTabs,
  isCompactLayout = false,
  isNarrowLayout,
  rightPanelVisible,
  messagesPanelId,
  messagesTabId,
  summaryPanelId,
  summaryTabId,
  mapPanelId,
  mapTabId,
  filtersPanelId,
  filterPanelOpen,
  onToggleFilterPanel,
  onCloseFilterPanel,
}: Props) {
  // Flush, full-height divider on the column edge for every tab — mirrors the
  // left panel's `border-r` so both sides read identically. (Previously the
  // messages tab drew its own inset border on the scroll area, which sat 16px
  // inside the column padding and looked misaligned with the left divider.)
  // Columns stack below MUI's `lg` (1200px), so the divider is gated to
  // `min-[1200px]`.
  const showRightDivider = rightPanelVisible;
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const messageTransitionLoading = page.groupScopeTransitionPending || page.messagesLoading;
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const closeFilterPanel = useCallback(() => {
    onCloseFilterPanel();
    window.requestAnimationFrame(() => filterButtonRef.current?.focus());
  }, [onCloseFilterPanel]);
  useEffect(() => {
    if (!filterPanelOpen || isNarrowLayout) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeFilterPanel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeFilterPanel, filterPanelOpen, isNarrowLayout]);
  const group = groupFilterIdentity(page.queryState.groupsSelected, page.groupInfos);
  const scopeLabel = `Для: ${group.name}`;
  const activeFilterCount = getAnalysisActiveFilterCount(page.queryState, {
    hideGroupSelection: false,
    radioFeaturesAllowed: page.radioFeaturesAllowed,
  });
  const filterButtonLabel = activeFilterCount > 0 ? 'Фільтри (активні)' : 'Фільтри';
  const filterIcon = (
    <Badge
      color="error"
      variant="dot"
      invisible={activeFilterCount === 0}
      data-analysis-active-filter-indicator={activeFilterCount > 0 ? '' : undefined}
    >
      <FilterAltOutlinedIcon fontSize="small" />
    </Badge>
  );
  const filterPanelBody = (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <AnalysisFiltersPanel page={page} fullHeight hideGroupSelection={false} />
    </Box>
  );

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
      {page.threadMode ? (
        <section
          aria-label="Перегляд ланцюжка"
          className="mx-echo-sm mb-echo-sm flex flex-wrap items-center justify-between gap-echo-sm rounded-echo-sm border border-echo-divider bg-echo-text/5 p-echo-sm"
        >
          <div className="min-w-0">
            <div className="text-echo-text">Ланцюжок</div>
            <div className="text-echo-xs text-echo-text-muted">
              Фільтри діють лише в цьому ланцюжку. Мапа, зведена таблиця, звіти й аналітика поки
              недоступні.
            </div>
            {page.threadMode.deletedCount > 0 ? (
              <div className="text-echo-xs text-echo-text-muted">
                Видалено повідомлень: {page.threadMode.deletedCount}
              </div>
            ) : null}
          </div>
          <Button size="small" onClick={page.threadMode.exit}>
            Вийти з ланцюжка
          </Button>
        </section>
      ) : null}
      <Stack
        direction={isNarrowLayout ? 'row' : { xs: 'column', lg: 'row' }}
        alignItems={isNarrowLayout ? 'center' : { xs: 'stretch', lg: 'center' }}
        justifyContent="space-between"
        spacing={isCompactLayout ? 0.5 : 1}
        sx={{ px: { xs: 1, lg: 2 }, pt: 0, mb: 0, flexShrink: 0 }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
            gap: { xs: 1, sm: 1.5 },
          }}
        >
          <Box
            data-analysis-current-group
            sx={{
              display: 'flex',
              minWidth: 0,
              width: { xs: '128px', sm: '180px' },
              flexShrink: 0,
              '& .group-navigation-name': {
                fontSize: '16px',
                lineHeight: 1.5,
                fontWeight: 500,
              },
            }}
          >
            <GroupIdentity group={group} avatarSize="context" />
          </Box>
          <Button
            ref={filterButtonRef}
            data-analysis-filter-toggle
            size="small"
            aria-label={filterButtonLabel}
            aria-expanded={filterPanelOpen}
            aria-controls={filtersPanelId}
            startIcon={isCompactLayout ? undefined : filterIcon}
            onClick={onToggleFilterPanel}
            sx={{
              width: isCompactLayout ? 40 : 116,
              minWidth: isCompactLayout ? 40 : 116,
              height: 36,
              px: isCompactLayout ? 0.5 : 1,
              flexShrink: 0,
              textTransform: 'none',
              color: filterPanelOpen || activeFilterCount > 0 ? 'primary.main' : 'text.secondary',
            }}
          >
            {isCompactLayout ? filterIcon : 'Фільтри'}
          </Button>
          <Box
            data-analysis-group-divider
            aria-hidden="true"
            sx={{ width: '1px', height: '24px', flex: '0 0 auto', bgcolor: 'divider' }}
          />
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
                    disabled={page.threadMode != null}
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
                  disabled={page.threadMode != null}
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
            rangePageIndex={page.visibleMessagesPageIndex}
            pageSize={ANALYSIS_MESSAGES_PAGE_SIZE}
            messagesCount={page.messages.length}
            totalCount={page.messagesTotalCount}
            totalLoading={page.messagesTotalLoading}
            loading={messageTransitionLoading}
            preserveRangeWhileLoading
            noMoreToLoad={page.noMoreToLoad}
            hasMoreAfterWindow={page.hasMoreAfterWindow}
            busy={page.messagesPaging || messageTransitionLoading}
            jumpDisabled={page.directMessageNavigation != null}
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
              ...analysisNewestFirstLabelSx,
              visibility: centerTab === 'messages' ? 'visible' : 'hidden',
              pointerEvents: centerTab === 'messages' ? 'auto' : 'none',
            }}
          />
        ) : null}
      </Stack>

      <AnalysisFullscreenPanelDrawer
        anchor="left"
        title="Фільтри"
        subtitle={scopeLabel}
        closeLabel="Закрити фільтри"
        open={isNarrowLayout && filterPanelOpen}
        onClose={closeFilterPanel}
        maxPanelWidth={400}
      >
        <Box
          id={isNarrowLayout ? filtersPanelId : undefined}
          data-analysis-filter-panel
          sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          {filterPanelBody}
        </Box>
      </AnalysisFullscreenPanelDrawer>

      <Box
        sx={{
          flex: 1,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          overflow: 'hidden',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: { xs: 'contain', lg: 'auto' },
        }}
      >
        <Collapse
          data-analysis-filter-transition
          orientation="horizontal"
          in={filterPanelOpen && !isNarrowLayout}
          timeout={reduceMotion ? 0 : MANAGE_MESSAGE_EDITOR_TRANSITION_MS}
          easing={MANAGE_MESSAGE_EDITOR_TRANSITION_EASING}
          unmountOnExit
          sx={{
            height: '100%',
            flexShrink: 0,
            '& .MuiCollapse-wrapper': { height: '100%' },
            '& .MuiCollapse-wrapperInner': { height: '100%' },
          }}
        >
          <Paper
            component="aside"
            id={filtersPanelId}
            data-analysis-filter-panel
            aria-label="Фільтри"
            square
            elevation={0}
            sx={{
              width: 336,
              flex: '0 0 336px',
              height: '100%',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRight: '1px solid',
              borderColor: 'divider',
              bgcolor: 'var(--echo-color-background)',
              backgroundImage: 'none',
              boxShadow: 'none',
            }}
          >
            {filterPanelBody}
          </Paper>
        </Collapse>
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
            position: 'relative',
          }}
        >
          <AnalysisMessagesPane
            editorHighlightedMessageId={editorHighlightedMessageId}
            authUserName={page.authUserName}
            currentUser={page.currentUser}
            copiedFeedbackId={page.copiedFeedbackId}
            groupInfos={page.groupInfos}
            hideGroupName={page.groupNavigation.scope.kind === 'group'}
            paginationLoading={page.messagesPaging}
            showLoadingSkeleton={page.groupScopeTransitionPending || page.showMessagesLoading}
            isLoading={
              page.groupScopeTransitionPending ||
              (page.hasLoadedInitialMessages && page.messagesLoading)
            }
            newestFirst={page.newestFirst}
            botTagAction={page.botTagAction}
            messageComments={page.messageComments}
            messages={page.messages}
            firstLoadedMessageIndex={page.firstLoadedMessageIndex}
            hasMoreBeforeWindow={page.hasMoreBeforeWindow}
            hasMoreAfterWindow={page.hasMoreAfterWindow}
            loadingBeforeWindow={page.loadingBeforeWindow}
            loadingAfterWindow={page.loadingAfterWindow}
            networkDisplayMap={page.networkDisplayMap}
            pageIndex={page.pageIndex}
            pageNavigationTarget={page.messagePageNavigationTarget}
            viewportPreservationKey={page.messageViewportPreservationKey}
            edgeLoadRetryKey={page.messageEdgeLoadRetryKey}
            onViewportCaptureChange={page.setMessageViewportCapture}
            onVisiblePageChange={page.setVisibleMessagesPageIndex}
            onPageNavigationHandled={page.clearMessagePageNavigationTarget}
            scrollResetKey={`${page.queryState.fromDateTimeStr}|${page.queryState.toDateTimeStr}|${
              page.groupNavigation.scope.kind === 'group'
                ? page.groupNavigation.scope.masterKey
                : 'all'
            }|${page.linkedMessageLandingKey}`}
            noMoreToLoad={page.noMoreToLoad}
            onDeleteMessage={page.onDeleteMessage}
            onCancelBotTagAction={page.onCancelBotTagAction}
            onMarkBotTagWrong={page.onMarkBotTagWrong}
            onOpenEditor={page.openEditor}
            onCreateReport={page.openReportCreator}
            onEditReport={page.openReportEditor}
            onLoadMoreMessages={page.loadMoreMessages}
            onLoadPreviousMessages={page.loadPreviousMessages}
            onOpenPointsOnMap={page.openPointsOnMap}
            onAddPointHighlightBlacklist={page.onAddPointHighlightBlacklist}
            onSaveMessageUpdate={page.saveMessageUpdate}
            onToggleMessageBookmark={page.onToggleMessageBookmark}
            onToggleMessageImportant={page.onToggleMessageImportant}
            onToggleMessageTag={page.onToggleMessageTag}
            profiles={page.profiles}
            tagsMap={page.tagsMap}
            tagsOrder={page.tagsOrder}
            tagsLoading={page.filtersLoading && Object.keys(page.tagsMap).length === 0}
            tagsLayout={page.tagsLayout}
            hideBotTags={page.hideBotTags}
            hideNetworks={page.hideNetworks}
            messageTimeBasis={page.queryState.messageTimeBasis}
            collapseMediaPreviews={page.collapseMediaPreviews}
            mediaSummaryEnabled={page.mediaSummaryEnabled}
            messageTextPreviewLines={page.messageTextPreviewLines}
            showCallsignAddForm={page.showAnalysisCallsignAddForm}
            searchText={page.queryState.search}
            callsignInfoMap={page.summaryCallsignsInfo}
            networks={page.networks}
            unitsMap={page.unitsMap}
            directMessageNavigation={page.directMessageNavigation}
            onLinkedMessageMounted={page.onLinkedMessageMounted}
            loadedReplyTarget={page.loadedReplyTarget}
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
            pt: { xs: 0.5, lg: 1 },
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
              onLoadSettlementMessages={page.loadSettlementMessagesForMap}
              onUnitClick={page.toggleUnitFromMap}
              onShowSettlementsChange={page.setShowSettlements}
            />
          ) : null}
        </Box>
      </Box>
    </section>
  );
}
