import {
  MessageDeleteAccessContext,
  MessageWriteAccessContext,
} from '../shared/message-card/MessageWriteAccess';
import { canWriteMessages, hasRole } from '../../utils/roles';
import { RadioFeaturesProvider } from '../shared/RadioFeatures';
import { Box } from '@mui/material';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import {
  ManageMessageDrawer,
  type ManageMessageEditorHandle,
} from '../shared/manage-message/ManageMessageDrawer';
import { focusAfterEditorSurfacesClose } from '../shared/manage-message/focus-restoration';
import {
  MANAGE_MESSAGE_EDITOR_TRANSITION_EASING,
  MANAGE_MESSAGE_EDITOR_TRANSITION_MS,
  useManageMessageEditorPresentation,
} from '../shared/manage-message/ManageMessageEditorSurface';
import { getAnalysisCenterTabs } from './types';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';
import { AudioTranscriptionPreferencesProvider } from '../shared/message-card/MessageCardAudioTranscription';
import { PointBlacklistPaletteNamesCacheProvider } from '../shared/message-card/PointBlacklistPaletteNamesCache';
import { MessageDeviceAccessProvider } from '../shared/message-card/MessageDeviceAccess';
import { isIntelligenceReport } from '../shared/intelligence-reports';
import { useObservedWidth } from '../../hooks/use-observed-width';
import { AnalysisRightDock } from './AnalysisRightDock';
import { analysisWorkspaceColumns, shouldInlineAnalysisLeftPanel } from './analysis-editor-layout';
import {
  recordAnalysisDebugPageSnapshot,
  summarizeAnalysisDebugFilters,
  useAnalysisDebugEnabled,
} from './analysis-debug';

export type RerAnalysisNeoPageProps = {
  authUserName?: string | null;
  authUserRoles?: string[];
};

export function RerAnalysisNeoPage({
  authUserName = null,
  authUserRoles = [],
}: RerAnalysisNeoPageProps = {}) {
  const page = useRerAnalysisNeoPage(authUserName, authUserRoles);
  const analysisDebugEnabled = useAnalysisDebugEnabled();
  const theme = useTheme();
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
  const [createMessageGroupMasterKey, setCreateMessageGroupMasterKey] = useState<string | null>(
    null,
  );
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [editorSourceMessageId, setEditorSourceMessageId] = useState<number | null>(null);
  const editorRef = useRef<ManageMessageEditorHandle>(null);
  const editorInitialFocusTargetRef = useRef<HTMLElement | null>(null);
  const { ref: layoutRef, width: layoutWidth } = useObservedWidth<HTMLDivElement>();
  const reportFocusTargetRef = useRef<HTMLElement | null>(null);
  const reportFallbackFocusRef = useRef<HTMLDivElement | null>(null);
  const createMessageFabRef = useRef<HTMLButtonElement | null>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    if (!page.directMessageError) return;
    notify({ severity: 'error', message: page.directMessageError });
  }, [notify, page.directMessageError]);
  const isAnalysisCompactLayout = useMediaQuery(theme.breakpoints.down('md'));
  const isNarrowLayout = useMediaQuery(theme.breakpoints.down('lg'));
  const editorPresentation = useManageMessageEditorPresentation();
  const reduceEditorMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const centerTabsId = useId().replace(/:/g, '-');
  const messagesTabId = `${centerTabsId}-messages-tab`;
  const summaryTabId = `${centerTabsId}-summary-tab`;
  const mapTabId = `${centerTabsId}-map-tab`;
  const messagesPanelId = `${centerTabsId}-messages-panel`;
  const summaryPanelId = `${centerTabsId}-summary-panel`;
  const mapPanelId = `${centerTabsId}-map-panel`;
  const filtersPanelId = `${centerTabsId}-filters-panel`;
  const keepDirectMessageVisible =
    page.directMessageNavigation != null &&
    page.messages.some(
      ([messageId]) => messageId === page.directMessageNavigation?.targetMessageId,
    );
  const keepMessageViewportVisible = page.messageViewportPreserving && page.messages.length > 0;
  const showLoadingSkeletons =
    page.error == null &&
    !keepDirectMessageVisible &&
    !keepMessageViewportVisible &&
    !page.hasLoadedInitialMessages &&
    (page.messagesLoading || page.directMessageLoading || page.messages.length === 0);
  const leftPanelVisible = page.leftPanelOpen;
  const requestedRightPanelVisible = page.rightPanelOpen;
  const editorIntentKey = createMessageOpen
    ? `create-message:${createMessageGroupMasterKey ?? 'all'}`
    : page.reportSource
      ? `create-report:${page.reportSource.id}`
      : page.editorMessage
        ? `${page.editorEditAsReport ? 'edit-report' : 'edit-message'}:${page.editorMessage.id}`
        : page.editTargetLoadState.status !== 'idle'
          ? `edit-report:${page.editTargetLoadState.reportId}`
          : null;
  const editorOpen = editorIntentKey !== null;
  const editorHighlightedMessageId = editorOpen
    ? (editorSourceMessageId ??
      page.reportSource?.id ??
      page.editorMessage?.id ??
      (page.editTargetLoadState.status !== 'idle' ? page.editTargetLoadState.reportId : null))
    : null;
  const rightPanelVisible = requestedRightPanelVisible && !editorOpen;
  const modalEditorOpen = editorOpen && editorPresentation === 'modal';
  const toggleFilterPanel = useCallback(() => {
    setFilterPanelOpen((current) => !current);
  }, []);
  const closeFilterPanel = useCallback(() => {
    setFilterPanelOpen(false);
  }, []);
  useEffect(() => {
    if (!filterPanelOpen) return;
    const sections =
      page.groupNavigation.scope.kind === 'group'
        ? (['tags', 'senders'] as const)
        : (['tags', 'groups', 'senders'] as const);
    void Promise.all(sections.map((section) => page.loadFilterSection(section)));
  }, [filterPanelOpen, page.groupNavigation.scope.kind, page.loadFilterSection]);
  useEffect(() => {
    if (editorOpen) closeFilterPanel();
  }, [closeFilterPanel, editorOpen]);
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const inlineLeftPanelVisible = shouldInlineAnalysisLeftPanel({
    layoutWidth,
    viewportWidth,
    desktop: !isNarrowLayout,
    leftPanelOpen: leftPanelVisible,
    editorOpen,
  });
  const inlineRightDockVisible =
    editorPresentation === 'embedded' && (editorOpen || (!isNarrowLayout && rightPanelVisible));
  const centerTabs = getAnalysisCenterTabs(page.analysisMapInSidebar, page.radioFeaturesAllowed);
  const centerTab =
    page.analysisMapInSidebar && page.centerTab === 'map' ? 'messages' : page.centerTab;
  const analysisMapVisible =
    centerTab === 'map' ||
    (page.analysisMapInSidebar && rightPanelVisible && page.rightSidebarTab === 'map');
  useEffect(() => {
    if (!analysisDebugEnabled) return;
    recordAnalysisDebugPageSnapshot({
      centerTab,
      centerTabPending: page.centerTabPending,
      leftPanelOpen: leftPanelVisible,
      rightPanelOpen: rightPanelVisible,
      rightSidebarTab: page.rightSidebarTab,
      messagesLoading: page.messagesLoading,
      messagesPaging: page.messagesPaging,
      messagesTotalLoading: page.messagesTotalLoading,
      messagesTotalCount: page.messagesTotalCount,
      messagesOverallCount: page.messagesOverallCount,
      messageIds: page.messages.map(([messageId]) => messageId),
      pageIndex: page.pageIndex,
      visiblePageIndex: page.visibleMessagesPageIndex,
      newestFirst: page.newestFirst,
      hasLoadedInitialMessages: page.hasLoadedInitialMessages,
      noMoreToLoad: page.noMoreToLoad,
      directMessageActive: page.directMessageNavigation != null,
      directMessageLoading: page.directMessageLoading,
      messageViewportPreserving: page.messageViewportPreserving,
      filtersLoading: page.filtersLoading,
      countsLoading: page.countsLoading,
      summaryLoading: page.summaryLoading,
      ...summarizeAnalysisDebugFilters(page.queryState),
      hasError: page.error != null,
      hasValidationError: page.validationError != null,
      editorOpen,
      skeletonVisible: showLoadingSkeletons,
    });
  }, [
    analysisDebugEnabled,
    centerTab,
    editorOpen,
    leftPanelVisible,
    page,
    rightPanelVisible,
    showLoadingSkeletons,
  ]);
  const openReport = useCallback(
    (focusTarget: HTMLElement) => {
      reportFocusTargetRef.current = focusTarget;
      page.openReport();
    },
    [page.openReport],
  );
  const requestEditorIntent = useCallback(
    (key: string, commit: () => void, invokingControl?: HTMLElement, sourceMessageId?: number) => {
      if (!canWriteMessages(page.currentUser?.roles)) return;
      const focusTarget =
        invokingControl ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      editorInitialFocusTargetRef.current = focusTarget;
      const applyIntent = () => {
        setEditorSourceMessageId(sourceMessageId ?? null);
        if (page.rightPanelOpen) page.toggleRightPanel();
        if (key.startsWith('create-message:')) {
          if (
            isPresent(page.editorMessage) ||
            isPresent(page.reportSource) ||
            page.editTargetLoadState.status !== 'idle'
          ) {
            page.closeEditor();
          }
        } else {
          setCreateMessageOpen(false);
        }
        commit();
      };
      if (editorRef.current) {
        editorRef.current.requestIntentChange({ key, focusTarget, commit: applyIntent });
      } else {
        applyIntent();
      }
    },
    [
      page.closeEditor,
      page.currentUser?.roles,
      page.editTargetLoadState.status,
      page.editorMessage,
      page.reportSource,
      page.rightPanelOpen,
      page.toggleRightPanel,
    ],
  );
  const openCreateMessageComposer = useCallback(
    (focusTarget?: HTMLElement) => {
      const scopeKey =
        page.groupNavigation.scope.kind === 'group' ? page.groupNavigation.scope.masterKey : 'all';
      requestEditorIntent(
        `create-message:${scopeKey}`,
        () => {
          setCreateMessageGroupMasterKey(
            page.groupNavigation.scope.kind === 'group'
              ? page.groupNavigation.scope.masterKey
              : null,
          );
          setCreateMessageOpen(true);
        },
        focusTarget,
      );
    },
    [page.groupNavigation.scope, requestEditorIntent],
  );
  const openMessageEditor = useCallback(
    (messageId: number, invokingControl?: HTMLElement) => {
      const message = page.messages.find(([id]) => id === messageId)?.[1];
      const intentKind = message && isIntelligenceReport(message) ? 'edit-report' : 'edit-message';
      requestEditorIntent(
        `${intentKind}:${messageId}`,
        () => {
          page.setCenterTab('messages');
          page.openEditor(messageId);
        },
        invokingControl,
        messageId,
      );
    },
    [page.messages, page.openEditor, page.setCenterTab, requestEditorIntent],
  );
  const openReportCreator = useCallback(
    (
      messageId: number,
      etalonDisplayModel: Parameters<typeof page.openReportCreator>[1],
      invokingControl?: HTMLElement,
    ) => {
      requestEditorIntent(
        `create-report:${messageId}`,
        () => {
          page.setCenterTab('messages');
          page.openReportCreator(messageId, etalonDisplayModel);
        },
        invokingControl,
        messageId,
      );
    },
    [page.openReportCreator, page.setCenterTab, requestEditorIntent],
  );
  const openReportEditor = useCallback(
    (messageId: number, sourceMessageId?: number) => {
      requestEditorIntent(
        `edit-report:${messageId}`,
        () => {
          page.setCenterTab('messages');
          page.openReportEditor(messageId);
        },
        undefined,
        sourceMessageId,
      );
    },
    [page.openReportEditor, page.setCenterTab, requestEditorIntent],
  );
  const centerPage = {
    ...page,
    openEditor: openMessageEditor,
    openReportCreator,
    openReportEditor,
  };
  const closeMessageEditor = useCallback(() => {
    if (
      isPresent(page.editorMessage) ||
      isPresent(page.reportSource) ||
      page.editTargetLoadState.status !== 'idle'
    ) {
      page.closeEditor();
    } else {
      setCreateMessageOpen(false);
    }
  }, [page.closeEditor, page.editTargetLoadState.status, page.editorMessage, page.reportSource]);

  useEffect(() => {
    if (editorOpen || editorSourceMessageId == null) return;
    return focusAfterEditorSurfacesClose(() => {
      const sourceItem = Array.from(
        document.querySelectorAll<HTMLElement>('[data-message-id]'),
      ).find((item) => item.dataset.messageId === String(editorSourceMessageId));
      const returnLabel = editorInitialFocusTargetRef.current?.getAttribute('aria-label');
      const returnControl = Array.from(
        sourceItem?.querySelectorAll<HTMLElement>('button') ?? [],
      ).find((button) => button.getAttribute('aria-label') === returnLabel);
      return returnControl ?? null;
    });
  }, [editorOpen, editorSourceMessageId]);

  const toggleRightPanel = useCallback(() => {
    if (!editorOpen) {
      page.toggleRightPanel();
      return;
    }
    const focusTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const replaceEditorWithAnalytics = () => {
      closeMessageEditor();
      if (!page.rightPanelOpen) page.toggleRightPanel();
    };
    if (editorRef.current) {
      editorRef.current.requestIntentChange({
        key: 'analysis-panel',
        focusTarget,
        commit: replaceEditorWithAnalytics,
      });
    } else {
      replaceEditorWithAnalytics();
    }
  }, [closeMessageEditor, editorOpen, page.rightPanelOpen, page.toggleRightPanel]);

  useEffect(() => {
    if (editorOpen && page.rightPanelOpen) page.toggleRightPanel();
  }, [editorOpen, page.rightPanelOpen, page.toggleRightPanel]);

  const previousCanWriteRef = useRef<boolean | null>(null);
  useEffect(() => {
    const canWrite = canWriteMessages(page.currentUser?.roles);
    if (previousCanWriteRef.current === true && !canWrite && editorOpen) {
      if (editorRef.current) editorRef.current.closeWithoutConfirmation();
      else closeMessageEditor();
      notify({
        severity: 'error',
        message: 'Доступ до створення та редагування повідомлень втрачено.',
      });
    }
    previousCanWriteRef.current = canWrite;
  }, [closeMessageEditor, editorOpen, notify, page.currentUser?.roles]);

  const content = (
    <RadioFeaturesProvider allowed={page.radioFeaturesAllowed}>
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
        <Box
          ref={reportFallbackFocusRef}
          data-manage-message-focus-fallback
          tabIndex={-1}
          sx={{ px: { xs: 1, lg: 2 }, pt: 0.5 }}
        >
          <AnalysisPageHeader
            page={{ ...page, toggleRightPanel }}
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
          ref={layoutRef}
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
            data-analysis-workspace
            style={{
              gridTemplateColumns: analysisWorkspaceColumns({
                inlineLeftPanelVisible,
                inlineRightDockVisible,
                editorOpen,
              }),
              transition: reduceEditorMotion
                ? 'none'
                : `grid-template-columns ${MANAGE_MESSAGE_EDITOR_TRANSITION_MS}ms ${MANAGE_MESSAGE_EDITOR_TRANSITION_EASING}`,
            }}
            sx={{
              height: '100%',
              minHeight: 0,
              display: 'grid',
              gap: 0,
              overflow: 'hidden',
              alignItems: 'stretch',
              gridTemplateRows: 'minmax(0,1fr)',
            }}
          >
            <Box sx={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              {inlineLeftPanelVisible ? <AnalysisLeftPanel page={page} leftPanelVisible /> : null}
            </Box>
            <Box sx={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <PointBlacklistPaletteNamesCacheProvider>
                <MessageDeviceAccessProvider allowed={page.cyberEchoEnabled}>
                  {showLoadingSkeletons ? (
                    <AnalysisLoadingSkeletons
                      rightPanelVisible={inlineRightDockVisible && rightPanelVisible}
                    />
                  ) : (
                    <AudioTranscriptionPreferencesProvider
                      collapsedByDefault={page.audioTranscriptionCollapsed}
                      enabled={page.audioTranscriptionEnabled}
                    >
                      <AnalysisCenterPanel
                        page={centerPage}
                        editorHighlightedMessageId={editorHighlightedMessageId}
                        centerTab={centerTab}
                        centerTabs={centerTabs}
                        isCompactLayout={isAnalysisCompactLayout}
                        isNarrowLayout={isNarrowLayout}
                        rightPanelVisible={inlineRightDockVisible}
                        messagesPanelId={messagesPanelId}
                        messagesTabId={messagesTabId}
                        summaryPanelId={summaryPanelId}
                        summaryTabId={summaryTabId}
                        mapPanelId={mapPanelId}
                        mapTabId={mapTabId}
                        filtersPanelId={filtersPanelId}
                        filterPanelOpen={filterPanelOpen}
                        onToggleFilterPanel={toggleFilterPanel}
                        onCloseFilterPanel={closeFilterPanel}
                      />
                    </AudioTranscriptionPreferencesProvider>
                  )}
                </MessageDeviceAccessProvider>
              </PointBlacklistPaletteNamesCacheProvider>
            </Box>
            <Box sx={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <AnalysisRightDock
                presentation={inlineRightDockVisible ? 'embedded' : 'modal'}
                editorOpen={editorOpen}
                analyticsOpen={rightPanelVisible}
                editor={
                  <ManageMessageDrawer
                    ref={editorRef}
                    hideNetworks={page.hideNetworks || !page.networkVisibilityReady}
                    open={editorOpen}
                    intentKey={editorIntentKey ?? 'closed'}
                    presentation={editorPresentation}
                    adaptiveEmbeddedForm
                    fillEmbeddedSurface
                    transparentEmbeddedSurface
                    initialFocusTarget={editorInitialFocusTargetRef.current}
                    focusFallbackRef={createMessageFabRef}
                    cyberEchoEnabled={page.cyberEchoEnabled}
                    currentUser={page.currentUser}
                    initialGroupMasterKey={createMessageOpen ? createMessageGroupMasterKey : null}
                    editTarget={page.editorMessage}
                    editAsReport={page.editorEditAsReport}
                    editTargetLoadState={page.editTargetLoadState}
                    onRetryEditTargetLoad={page.retryEditTargetLoad}
                    reportSource={page.reportSource}
                    editSaveInFlight={page.editorSaveInFlight}
                    onClose={closeMessageEditor}
                    onSubmitEdit={
                      page.editorMessage && !page.editorEditAsReport
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
                      notify({
                        message: 'Розвіддонесення успішно видалено.',
                        severity: 'success',
                      });
                    }}
                    onCreated={async () => {
                      if (!page.reportSource) page.dismissUnreadBoundary();
                      page.reload({ preserveMessagePage: true, showMessagesLoading: false });
                      notify({
                        message: page.reportSource
                          ? 'Розвіддонесення успішно створено.'
                          : 'Повідомлення успішно створено.',
                        severity: 'success',
                      });
                    }}
                  />
                }
                analytics={
                  inlineRightDockVisible ? (
                    showLoadingSkeletons ? (
                      <AnalysisLoadingSkeletons centerVisible={false} rightPanelVisible />
                    ) : (
                      <AnalysisRightPanel
                        page={page}
                        rightPanelVisible
                        isCompactLayout={isAnalysisCompactLayout}
                      />
                    )
                  ) : (
                    <AnalysisFullscreenPanelDrawer
                      anchor="right"
                      title="Аналітична панель"
                      open={rightPanelVisible && !modalEditorOpen}
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
                  )
                }
              />
            </Box>
          </Box>
        </Box>

        <AnalysisFullscreenPanelDrawer
          anchor="left"
          title="Групи"
          open={!inlineLeftPanelVisible && leftPanelVisible && !editorOpen}
          onClose={page.toggleLeftPanel}
          maxPanelWidth={320}
        >
          <AnalysisLeftPanel page={page} leftPanelVisible fullHeight />
        </AnalysisFullscreenPanelDrawer>

        <AnalysisReportDialog
          aors={page.aorEntries}
          currentUser={page.currentUser}
          rerReportEnabled={page.rerReportEnabled}
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

        {!analysisMapVisible && !editorOpen ? (
          <CreateMessageFab ref={createMessageFabRef} onClick={openCreateMessageComposer} />
        ) : null}
      </Box>
    </RadioFeaturesProvider>
  );
  return (
    <MessageWriteAccessContext.Provider value={canWriteMessages(page.currentUser?.roles)}>
      <MessageDeleteAccessContext.Provider value={hasRole(page.currentUser?.roles, 'DeleteMsg')}>
        {content}
      </MessageDeleteAccessContext.Provider>
    </MessageWriteAccessContext.Provider>
  );
}
