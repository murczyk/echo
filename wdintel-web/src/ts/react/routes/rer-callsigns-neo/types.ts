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

export type SortColumn = 'callsign' | 'position' | 'comment' | 'unit' | 'sourceName' | 'radioFreq' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

export type CallsignsSortState = {
  column: SortColumn;
  direction: SortDirection;
};

export type OnSort = (column: SortColumn, direction?: SortDirection) => void;

export type CallsignsFilterState = {
  filterText: string;
  filterCallsign: string;
  filterPosition: string;
  filterComment: string;
  filterUnit: string;
  filterDeveloping: DevelopingFilter;
  isIgnoringDateFilter: boolean;
  fromDateTimeLocal: string;
  toDateTimeLocal: string;
};

export type UnitHierarchyFilter = {
  army: string | null;
  division: string | null;
  regiment: string | null;
  battalion: string | null;
};

export type SelectedSidebarUnitFilter =
  | {
      kind: 'leaf';
      label: string;
      unitName: string;
    }
  | {
      kind: 'group';
      label: string;
      hierarchy: UnitHierarchyFilter;
    };

export type CallsignDraftRow = {
  callsign: string;
  position: string;
  comment: string;
  developing: boolean;
  radioFreq: string;
};

export type CallsignEditForm = {
  id: number;
  callsign: string;
  position: string;
  comment: string;
  callsignAdditionalSourceIds: number[];
  unitId: number;
  sourceId: number | null;
  developing: boolean;
  radioFreq: string;
  createdAt: number;
  active: boolean;
};

export type UiStatus =
  | { kind: 'error'; text: string }
  | { kind: 'success'; text: string }
  | null;

export type CallsignRowView = Callsign & {
  unitName: string;
  sourceName: string;
  commentForView: string;
  callsignAdditionalSourceIds: number[];
  callsignAdditionalSourceNames: string[];
};

export type UnitStatView = CallsignUnitStatRow & {
  unitName: string;
  army: string;
  division: string;
  regiment: string;
  battalion: string;
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
