import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  InboxMessage,
  MessageComment,
  NetJsonGraphAndMeta,
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
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisFilterSectionLoadState,
  AnalysisFilterSectionId,
  AnalysisCenterTab,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
} from './types';

export type UseAnalysisDataProps = {
  authUserName: string | null;
  currentUser: User | null;
  deferInitialLoad?: boolean;
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
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphLoadError?: string | null;
  callsignGraphNolimit: boolean;
  correlatedFreqs: CorrelatedFreq[];
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
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadNewCallsigns: () => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<boolean>;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
  messagesLoading: boolean;
  messagesPaging: boolean;
  messageComments: Record<number, MessageComment[]>;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: import('../../../../Bindings').NewCallsignsRes;
  newCallsignsLoading: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  onUpdateLocalMessage: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => void;
  onDeleteMessage: (messageId: number) => Promise<void>;
  onSaveMessageComment: (messageId: number, comment: string | null) => Promise<void>;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => Promise<void>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => Promise<void>;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => Promise<void>;
  onToggleMessageTag: (messageId: number, tagId: number) => Promise<void>;
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  users: Record<string, User | null>;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  reload: () => Promise<void>;
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
