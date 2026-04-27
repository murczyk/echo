import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  InboxMessage,
  NetJsonGraphAndMeta,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  Unit,
} from '../../../../Bindings';
import { buildInboxReq } from './helpers';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisFilterSectionId,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
} from './types';

export type UseAnalysisDataProps = {
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  shouldLoadNewCallsigns: boolean;
  queryState: import('./types').AnalysisQueryState;
  centerTab: 'messages' | 'summary';
  rightPanelOpen: boolean;
  rightSidebarTab: import('./types').AnalysisSidebarTab | null;
};

export type UseAnalysisDataResult = {
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphNolimit: boolean;
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  counts: CountStatsRsp | null;
  countsLoading: boolean;
  aorEntries: AnalysisAorEntry[];
  filtersLoading: boolean;
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
  loadCallsignGraph: () => Promise<void>;
  loadAllMessages: () => Promise<void>;
  loadFilterSection: (section: AnalysisFilterSectionId) => Promise<void>;
  invalidateFilterSectionLoads: () => void;
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadNewCallsigns: () => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<void>;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
  messagesLoading: boolean;
  messagesPaging: boolean;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: import('../../../../Bindings').NewCallsignsRes;
  newCallsignsLoading: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  onUpdateLocalMessage: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => void;
  onDeleteMessage: (messageId: number) => Promise<void>;
  onSaveMessageComment: (messageId: number, comment: string | null) => Promise<void>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => Promise<void>;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => Promise<void>;
  onToggleMessageTag: (messageId: number, tagId: number) => Promise<void>;
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  reload: () => Promise<void>;
  summaryLoading: boolean;
  rightSidebarLoading: boolean;
  summaryRows: SummaryTableFreqRow[];
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  unitsMap: Record<number, Unit>;
  tagsMap: Record<number, Tag>;
  topCallsigns: AnalysisCountItem[];
  topFreqs: AnalysisCountItem[];
  groupInfos: Record<string, SignalGroupEntry>;
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
  renameSummaryUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
};
