import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  InboxMessage,
  MessageComment,
  InboxMessagesReq,
  NetJsonGraphAndMeta,
  Network,
  NewCallsignsRes,
  RerAnalysisQueryState,
  SavedFilter,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  TagFilterOption,
  User,
  Unit,
  ReportHistoryRow,
} from '../../../../Bindings';
import type { AnalysisReportState } from './report-helpers';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import type { AnalysisBotTagAction } from './use-analysis-data.message-actions';

export type AnalysisReportTaskRun = {
  id: number;
  reportTitle: string;
  reportName: string;
  headerTitle: string;
  running: boolean;
  cancelled: boolean;
  curr: number;
  overall: number;
  logs: string[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expanded: boolean;
  historyRow: ReportHistoryRow | null;
};

export type AnalysisCountItem = {
  key: string;
  count: number;
};

export type AnalysisFilterOption = {
  value: string;
  label: string;
  count: number;
  values?: string[];
};

export type AnalysisAorEntry = {
  id: number;
  name: string;
};

export type AnalysisGroupsActivityPeriod = 'selected' | 'month' | 'quarter' | 'year';
export type AnalysisQueryState = Omit<RerAnalysisQueryState, 'dateFromStr' | 'timeFromStr' | 'dateToStr' | 'timeToStr'> & {
  fromDateTimeStr: string;
  toDateTimeStr: string;
  filterTagsOption: TagFilterOption;
  includeOnlyNewFreqs: boolean;
  onlyWithMedia: boolean;
  reportTagsOnlyThisUnit: boolean;
};

export type AnalysisFilterOptions = {
  tags: AnalysisFilterOption[];
  aors: AnalysisFilterOption[];
  groups: AnalysisFilterOption[];
  senders: AnalysisFilterOption[];
  freqs: AnalysisFilterOption[];
  newFreqs: AnalysisFilterOption[];
  callsigns: AnalysisFilterOption[];
  units: AnalysisFilterOption[];
  locations: AnalysisFilterOption[];
  posts: AnalysisFilterOption[];
  networks: AnalysisFilterOption[];
  metadataCcs: AnalysisFilterOption[];
  metadataSenders: AnalysisFilterOption[];
  metadataReceivers: AnalysisFilterOption[];
  metadataHashes: AnalysisFilterOption[];
};

export type AnalysisFilterSectionId =
  | 'tags'
  | 'aors'
  | 'groups'
  | 'senders'
  | 'callsigns'
  | 'units'
  | 'locations'
  | 'posts'
  | 'networks'
  | 'metadata';

export type AnalysisFilterSectionLoadState = 'idle' | 'loading' | 'stale' | 'loaded' | 'error';

export type AnalysisPalitrasLoadState = 'idle' | 'loading' | 'success' | 'error';

export type AnalysisMapAttrs = {
  daterange: string;
  daterangeLoading: string;
  points: string;
  messages: string;
  selectedUnits: string;
  palitras: string;
  palitrasLoaded: string;
  palitrasLoadState: AnalysisPalitrasLoadState;
};

export type AnalysisCenterTab = 'messages' | 'summary' | 'map';
export type AnalysisSidebarTab = 'map' | 'stats' | 'callsigns' | 'newCallsigns';

export function getAnalysisCenterTabs(analysisMapInSidebar: boolean): AnalysisCenterTab[] {
  return analysisMapInSidebar ? ['messages', 'summary'] : ['messages', 'map', 'summary'];
}

export function getAnalysisSidebarTabs(analysisMapInSidebar: boolean): AnalysisSidebarTab[] {
  return analysisMapInSidebar ? ['map', 'stats', 'callsigns', 'newCallsigns'] : ['stats', 'callsigns', 'newCallsigns'];
}

export type AnalysisPageState = {
  authUserName: string | null;
  aorEntries: AnalysisAorEntry[];
  canResetFilters: boolean;
  analysisMapInSidebar: boolean;
  centerTab: AnalysisCenterTab;
  centerTabPending: boolean;
  counts: CountStatsRsp | null;
  copiedFeedbackId: string | null;
  error: string | null;
  editorMessage: { id: number; message: InboxMessage } | null;
  editorSaveInFlight: boolean;
  currentUser: User | null;
  filtersLoading: boolean;
  filterSectionLoadStates: Record<AnalysisFilterSectionId, AnalysisFilterSectionLoadState>;
  isFilterSectionLoading: (section: AnalysisFilterSectionId) => boolean;
  isFilterSectionEmptyLoading: (section: AnalysisFilterSectionId, optionCount: number) => boolean;
  isFilterSectionStale: (section: AnalysisFilterSectionId) => boolean;
  groupInfos: Record<string, SignalGroupEntry>;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  includeOnlyNewFreqs: boolean;
  inboxReq: InboxMessagesReq | null;
  isDirty: boolean;
  loadedSavedFilter: SavedFilter | null;
  countsLoading: boolean;
  leftPanelOpen: boolean;
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphNolimit: boolean;
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  hasLoadedInitialMessages: boolean;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
  botTagAction: AnalysisBotTagAction | null;
  messageComments: Record<number, MessageComment[]>;
  messagesLoading: boolean;
  messagesPaging: boolean;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: NewCallsignsRes;
  newCallsignsLoading: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  newestFirst: boolean;
  unitsExactMatchOnlyDefault: boolean | null;
  supportNonRerInterceptions: boolean;
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  queryState: AnalysisQueryState;
  users: Record<string, User | null>;
  tagsLayout: TagsLayoutVariant;
  rightPanelOpen: boolean;
  rightSidebarTab: AnalysisSidebarTab | null;
  report: AnalysisReportState;
  reportDownloadInFlight: boolean;
  reportProgressExpanded: boolean;
  reportTaskRuns: AnalysisReportTaskRun[];
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  summaryLoading: boolean;
  summaryLoaded: boolean;
  summaryHasLoadedOnce: boolean;
  rightSidebarLoading: boolean;
  summaryRows: SummaryTableFreqRow[];
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  unitsMap: Record<number, Unit>;
  tagsMap: Record<number, Tag>;
  topCallsigns: AnalysisCountItem[];
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
  validationError: string | null;
};

export type AnalysisPageActions = {
  applySavedFilter: (savedFilter: SavedFilter | null) => void;
  deleteLoadedSavedFilter: () => void;
  renameExistingSavedFilter: (name: string) => Promise<boolean>;
  loadCallsignGraph: () => void;
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => void;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  loadAllMessages: () => Promise<void>;
  loadFilterSection: (section: AnalysisFilterSectionId) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<boolean>;
  loadNewCallsigns: () => Promise<void>;
  onDeleteMessage: (messageId: number) => void;
  onSaveMessageComment: (messageId: number, comment: string | null) => void;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => void;
  renameSummaryUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  onUpdateLocalMessage: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => void;
  closeReport: () => void;
  downloadGeojson: () => void;
  downloadKmz: () => void;
  downloadSummaryXlsx: () => void;
  downloadReport: () => void;
  closeEditor: () => void;
  openReport: () => void;
  openEditor: (messageId: number) => void;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => void;
  reload: () => void;
  resetFilters: () => void;
  saveAsNew: (name: string) => Promise<boolean>;
  setCenterTab: (tab: AnalysisCenterTab) => void;
  setIncludeOnlyNewFreqs: (value: boolean) => void;
  setNewestFirst: (value: boolean) => void;
  setRightSidebarTab: (tab: AnalysisSidebarTab) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  selectOnlyFreq: (freq: string) => void;
  setSavedFilterName: (name: string) => void;
  addFrequencyToFilter: (freq: string) => void;
  showFreqOnMap: (freq: string) => void;
  toggleUnitFromMap: (unitName: string | null) => void;
  updateReport: (patch: Partial<AnalysisReportState>) => void;
  updateExisting: () => void;
  updateQueryState: (patch: Partial<AnalysisQueryState>) => void;
  saveEditor: (message: InboxMessage) => void;
  saveMessageUpdate: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => Promise<boolean>;
  repeatReportTaskRun: (id: number) => Promise<void>;
  setReportProgressExpanded: (expanded: boolean) => void;
  toggleReportTaskRunLogs: (id: number, expanded: boolean) => void;
};

export type AnalysisPageViewModel = AnalysisPageState & AnalysisPageActions;
