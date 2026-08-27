import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  InboxMessage,
  MessageComment,
  NetworkCallsignRelationsRsp,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  User,
  Unit,
} from '../../../../Bindings';
import { buildInboxReq } from './helpers';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import type { AddPointHighlightBlacklistRequest } from '../shared/message-card/point-highlight-blacklist';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisFilterSectionLoadState,
  AnalysisFilterSectionId,
  AnalysisCenterTab,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
  AnalysisReloadOptions,
} from './types';

export type UseAnalysisDataProps = {
  authUserName: string | null;
  currentUser: User | null;
  deferInitialLoad?: boolean;
  focusedMessage?: [number, InboxMessage] | null;
  focusedMessageActive?: boolean;
  leftPanelOpen?: boolean;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  shouldLoadNewCallsigns: boolean;
  queryState: import('./types').AnalysisQueryState;
  centerTab: AnalysisCenterTab;
  rightPanelOpen: boolean;
  rightSidebarVisible: boolean;
  rightSidebarTab: import('./types').AnalysisSidebarTab | null;
};

export type UseAnalysisDataResult = {
  callsignGraph: NetworkCallsignRelationsRsp | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphLoadError?: string | null;
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoaded: boolean;
  correlatedFreqsLoading: boolean;
  counts: CountStatsRsp | null;
  countsLoading: boolean;
  aorEntries: AnalysisAorEntry[];
  filtersLoading: boolean;
  filterSectionLoadStates: Record<AnalysisFilterSectionId, AnalysisFilterSectionLoadState>;
  isFilterSectionLoading: (section: AnalysisFilterSectionId) => boolean;
  isFilterSectionEmptyLoading: (section: AnalysisFilterSectionId, optionCount: number) => boolean;
  isFilterSectionStale: (section: AnalysisFilterSectionId) => boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  downloadGeojson: () => Promise<void>;
  downloadKmz: () => Promise<void>;
  downloadSummaryXlsx: () => Promise<void>;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  hasLoadedInitialMessages: boolean;
  inboxReq: ReturnType<typeof buildInboxReq>;
  botTagAction: MessageCardBotTagAction | null;
  loadCallsignGraph: () => Promise<void>;
  loadAllMessages: () => Promise<void>;
  loadFilterSection: (section: AnalysisFilterSectionId) => Promise<void>;
  invalidateFilterSectionLoads: () => void;
  invalidateFilterSectionLoadsForPatch: (
    patch?: Partial<import('./types').AnalysisQueryState>,
  ) => void;
  getReloadFilterSections: () => AnalysisFilterSectionId[] | null;
  loadCorrelatedFreqs: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadNewCallsigns: () => Promise<void>;
  loadFirstPage: () => Promise<void>;
  loadFocusedEarlier: () => Promise<boolean>;
  loadFocusedLater: () => Promise<boolean>;
  loadLastPage: () => Promise<void>;
  loadNextPage: () => Promise<void>;
  loadMoreMessages: () => Promise<boolean>;
  loadPrevPage: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<boolean>;
  loadSettlementMessagesForMap: (
    settlementId: number,
    beforeIdNoninclusive?: number | null,
  ) => Promise<boolean>;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
  messagesLoading: boolean;
  messagesOverallCount: number | null;
  messagesPaging: boolean;
  messagesTotalCount: number | null;
  messagesTotalLoading: boolean;
  focusedHasMoreEarlier: boolean;
  focusedHasMoreLater: boolean;
  focusedLoadingDirection: 'earlier' | 'later' | null;
  messageComments: Record<number, MessageComment[]>;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: import('../../../../Bindings').NewCallsignsRes;
  newCallsignsLoading: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  pageIndex: number;
  onUpdateLocalMessage: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => void;
  onPrependLocalMessage: (messageId: number, message: InboxMessage) => void;
  onDeleteMessage: (messageId: number) => Promise<void>;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => Promise<void>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => Promise<void>;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => Promise<void>;
  onToggleMessageTag: (messageId: number, tagId: number) => Promise<void>;
  onAddPointHighlightBlacklist: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  setShowSettlements: (show: boolean) => Promise<void>;
  reload: (options?: AnalysisReloadOptions) => Promise<void>;
  summaryLoading: boolean;
  summaryLoaded: boolean;
  summaryHasLoadedOnce: boolean;
  rightSidebarLoading: boolean;
  summaryRows: SummaryTableFreqRow[];
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  unitsMap: Record<number, Unit>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  topCallsigns: AnalysisCountItem[];
  topFreqs: AnalysisCountItem[];
  groupInfos: Record<string, SignalGroupEntry>;
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
  renameSummaryUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
};
