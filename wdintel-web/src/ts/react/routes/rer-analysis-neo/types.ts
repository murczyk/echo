import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  InboxMessage,
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
  Unit,
} from '../../../../Bindings';
import type { AnalysisReportState } from './report-helpers';

export type AnalysisCountItem = {
  key: string;
  count: number;
};

export type AnalysisAorEntry = {
  id: number;
  name: string;
};

export type AnalysisGroupsActivityPeriod = 'selected' | 'month' | 'quarter' | 'year';
export type AnalysisQueryState = RerAnalysisQueryState & {
  filterTagsOption: TagFilterOption;
  includeOnlyNewFreqs: boolean;
  reportTagsOnlyThisUnit: boolean;
};

export type AnalysisFilterOptions = {
  aors: string[];
  groups: string[];
  senders: string[];
  freqs: string[];
  newFreqs: string[];
  callsigns: string[];
  units: string[];
  locations: string[];
  posts: string[];
  networks: string[];
  metadataCcs: string[];
  metadataSenders: string[];
  metadataReceivers: string[];
  metadataHashes: string[];
};

export type AnalysisMapAttrs = {
  daterange: string;
  daterangeLoading: string;
  points: string;
  messages: string;
  selectedUnits: string;
  palitras: string;
};

export type AnalysisSidebarSections = {
  stats: boolean;
  callsigns: boolean;
  newCallsigns: boolean;
};

export type AnalysisPageState = {
  authUserName: string | null;
  aorEntries: AnalysisAorEntry[];
  canResetFilters: boolean;
  centerTab: 'messages' | 'map' | 'summary';
  centerTabPending: boolean;
  counts: CountStatsRsp | null;
  copiedFeedbackId: string | null;
  error: string | null;
  editorMessage: { id: number; message: InboxMessage } | null;
  editorSaveInFlight: boolean;
  filtersLoading: boolean;
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
  groupsActivityLoading: boolean;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
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
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  queryState: AnalysisQueryState;
  rightPanelOpen: boolean;
  rightSidebarSections: AnalysisSidebarSections;
  report: AnalysisReportState;
  reportDownloadInFlight: boolean;
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  summaryLoading: boolean;
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
  renameExistingSavedFilter: () => Promise<void>;
  loadCallsignGraph: () => void;
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => void;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  loadAllMessages: () => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => void;
  onDeleteMessage: (messageId: number) => void;
  onSaveMessageComment: (messageId: number, comment: string | null) => void;
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
  saveAsNew: () => void;
  setCenterTab: (tab: 'messages' | 'map' | 'summary') => void;
  setIncludeOnlyNewFreqs: (value: boolean) => void;
  setNewestFirst: (value: boolean) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleRightSidebarSection: (section: keyof AnalysisSidebarSections) => void;
  selectOnlyFreq: (freq: string) => void;
  setSavedFilterName: (name: string) => void;
  showFreqOnMap: (freq: string) => void;
  toggleUnitFromMap: (unitName: string | null) => void;
  updateReport: (patch: Partial<AnalysisReportState>) => void;
  updateExisting: () => void;
  updateQueryState: (patch: Partial<AnalysisQueryState>) => void;
  saveEditor: (message: InboxMessage) => void;
};

export type AnalysisPageViewModel = AnalysisPageState & AnalysisPageActions;
