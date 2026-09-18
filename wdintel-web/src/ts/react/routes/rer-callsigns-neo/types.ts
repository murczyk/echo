import type {
  Callsign,
  CallsignUnitStatRow,
  DevelopingFilter,
  ListCallsignsReq,
  ListCallsignsSortBy,
  Source,
  Unit,
  User,
} from '../../../../Bindings';

export type SortColumn =
  | 'callsign'
  | 'position'
  | 'fullName'
  | 'comment'
  | 'unit'
  | 'sourceName'
  | 'radioFreq'
  | 'createdAt';
export type SortDirection = 'asc' | 'desc';

export type CallsignsSortState = {
  column: SortColumn;
  direction: SortDirection;
} | null;

export type OnSort = (column: SortColumn | null, direction?: SortDirection) => void;

export type CallsignsFilterState = {
  filterText: string;
  filterCallsign: string;
  filterPosition: string;
  filterFullName: string;
  filterComment: string;
  filterUnit: string;
  filterDeveloping: DevelopingFilter;
  isIgnoringDateFilter: boolean;
  fromDateTimeLocal: string;
  toDateTimeLocal: string;
};

export type UnitHierarchyFilter = {
  armyRegion: string | null;
  militaryDistrict: string | null;
  army: string | null;
  corps: string | null;
  division: string | null;
  brigade: string | null;
  regiment: string | null;
  battalion: string | null;
  company: string | null;
  platoon: string | null;
  squad: string | null;
  section: string | null;
  teamOrCrew: string | null;
  other: string | null;
};

export type SelectedSidebarUnitFilter =
  | {
      kind: 'leaf';
      label: string;
      unitName: string;
      unitId?: number;
    }
  | {
      kind: 'group';
      label: string;
      hierarchy: UnitHierarchyFilter;
    };

export type CallsignDraftRow = {
  callsign: string;
  position: string;
  fullName: string;
  comment: string;
  developing: boolean;
  radioFreq: string;
};

export type CallsignDuplicateHintMatch = {
  id: number;
  callsign: string;
  position: string;
  fullName: string;
  comment: string;
  unitName: string;
};

export type CallsignDuplicateHintGroup = {
  rowIndex: number;
  matches: CallsignDuplicateHintMatch[];
};

export type CallsignEditForm = {
  id: number;
  callsign: string;
  position: string;
  fullName: string;
  comment: string;
  callsignAdditionalSourceIds: number[];
  unitId: number;
  sourceId: number | null;
  developing: boolean;
  radioFreq: string;
  createdAt: number;
  active: boolean;
};

export type UiStatus = { kind: 'error'; text: string } | { kind: 'success'; text: string } | null;

export type CallsignRowView = Callsign & {
  unitName: string;
  sourceName: string;
  callsignAdditionalSourceIds: number[];
  callsignAdditionalSourceNames: string[];
};

export type UnitStatView = CallsignUnitStatRow & {
  unitName: string;
  armyRegion: string;
  militaryDistrict: string;
  army: string;
  corps: string;
  division: string;
  brigade: string;
  regiment: string;
  battalion: string;
  company: string;
  platoon: string;
  squad: string;
  section: string;
  teamOrCrew: string;
  other: string;
};

export type BootstrapLookups = {
  user: User | null;
  units: Unit[];
  unitsById: Map<number, Unit>;
  sources: Source[];
  sourcesById: Map<number, Source>;
  unitStats: CallsignUnitStatRow[];
};

export type ListQueryParams = {
  afterId: number | null;
  limit: number | null;
};

export type BuildReqInput = {
  filters: CallsignsFilterState;
  sort: CallsignsSortState;
  query: ListQueryParams;
  sidebarUnitHierarchyFilter?: UnitHierarchyFilter | null;
};

export type DownloadKind = 'csv' | 'xlsx';

export type ExportPermission = {
  canEdit: boolean;
  canExport: boolean;
};

export type CallsignsPageState = {
  lookups: BootstrapLookups;
  callsigns: Callsign[];
  showLoadMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  status: UiStatus;
  filters: CallsignsFilterState;
  sort: CallsignsSortState;
  addUnitId: number | null;
  addSourceId: number | null;
  addCallsignAdditionalSourceIds: number[];
  addRows: CallsignDraftRow[];
  addSubmitting: boolean;
  editForm: CallsignEditForm | null;
  editSubmitting: boolean;
  deleteTarget: Callsign | null;
  deleteSubmitting: boolean;
  sidebarOpen: boolean;
  downloadInProgress: DownloadKind | null;
};

export type SortDescriptor = {
  backend: ListCallsignsSortBy[];
  label: string;
};

export type FormatMaps = {
  unitsById: Map<number, Unit>;
  sourcesById: Map<number, Source>;
};

export type BuildRowsResult = {
  rows: CallsignRowView[];
  unitStats: UnitStatView[];
};

export type CallsignDraftValidation = {
  valid: boolean;
  error: string | null;
};

export type UploadFiltersPayload = ListCallsignsReq;
