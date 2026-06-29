import type {
  AreaOfResponsibility,
  EncryptionRec,
  Network,
  NetworkDescrType,
  NetworkCallsignRelationsRsp,
  NetworkPoint,
  NetworkStatus,
  NetworkFreqsRes,
  Post,
  NetworkCallsign,
  NetworkCallsignRes,
  Source,
  Unit,
  User,
} from '../../../../Bindings';
import { createDefaultNetworkEtalonkaReportState, type NetworkEtalonkaReportState, type NetworkEtalonkaReportType } from './use-rer-network-details-neo-page.etalonka-report';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from './use-rer-network-details-neo-page.constants';
import type { NetworkFreqActivityByFreq } from './frequency-utils';
import type {
  NetworkCallsignCatalogGroupView,
  NetworkCallsignActivityMap,
  NetworkCallsignDrawerForm,
  NetworkCallsignDrawerMode,
  NetworkCallsignInterceptedView,
  NetworkCallsignRowView,
  NetworkCallsignSectionMode,
  NetworkCallsignStatusFilter,
} from './network-callsigns.types';

export type { NetworkEtalonkaReportState, NetworkEtalonkaReportType };
export { createDefaultNetworkEtalonkaReportState };

export type NetworkUpsertForm = {
  id: number | null;
  name: string;
  location: string;
  radioStation: string;
  purpose: string;
  operationMode: string;
  operationType: string;
  operationPeriod: string;
  doNotArchive: boolean;
  unitTags: string[];
  status: NetworkStatus;
  aorIds: number[];
  unitIds: number[];
  postIds: number[];
  freq: string;
  modulation: 'DMR' | 'NFM' | 'AM' | '';
  encryptionId: number | null;
  activeFrom: string;
  activeTo: string;
  encryptionKeyIds: number[];
};

export type NetworkEditForm = NetworkUpsertForm;

export type NetworkFreqKind = 'DMR' | 'NFM' | 'AM' | '';

export type NetworkDescriptionForm = {
  topic: string;
  description: string;
  networkFreqId: number | null;
};

export type NetworkOption = {
  id: number;
  label: string;
};

export type NetworkDescriptionMode = 'create' | 'edit';

export type NetworkDetailsTab = 'descriptions' | 'signs' | 'frequencies' | 'callsigns' | 'relations' | 'activity' | 'direction-finding';

export type NetworkFreqCreateWizardForm = {
  freq: string;
  modulation: 'DMR' | 'NFM' | 'AM' | '';
  encryptionId: number | null;
  activeFrom: string;
  activeTo: string;
  encryptionKeyIds: number[];
};

export type NetworkFreqEditForm = {
  networkFreqId: number;
  freq: string;
  modulation: 'DMR' | 'NFM' | 'AM' | '';
  encryptionId: number | null;
  activeFrom: string;
  activeTo: string;
  encryptionKeyIds: number[];
};

export type NetworkFreqCallsignsStatus = 'idle' | 'loading' | 'success' | 'error';

export type NetworkDetailsNeoPageState = {
  network: Network | null;
  sources: Source[];
  freqs: NetworkFreqsRes[];
  freqsLoaded: boolean;
  freqsLoading: boolean;
  freqsError: string | null;
  freqActivityByFreq: NetworkFreqActivityByFreq;
  freqCallsignsById: Map<number, string[]>;
  freqCallsignsStatus: NetworkFreqCallsignsStatus;
  networkActivity: Record<string, Record<string, number>>;
  networkActivityLoaded: boolean;
  networkActivityLoading: boolean;
  networkActivityError: string | null;
  supportNonRerInterceptions: boolean;
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  pelengPointsRequestedFrom: number | null;
  pelengPointsRequestedTo: number | null;
  callsignCount: number | null;
  networkCallsigns: NetworkCallsign[];
  networkCallsignGroups: NetworkCallsignRes[];
  callsignActivityMap: NetworkCallsignActivityMap;
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
  relations: NetworkCallsignRelationsRsp | null;
  relationsLoaded: boolean;
  relationsLoading: boolean;
  relationsError: string | null;
  relationsSearch: string;
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsShowLabels: boolean;
  relationsSelectedNodeId: string | null;
  relationsSelectedEdgeId: string | null;
  relationsSince: string;
  relationsTill: string;
  pelengSince: string;
  pelengTill: string;
  pelengSearch: string;
  pelengEnabledFreqs: string[];
  pelengShowLabels: boolean;
  pelengSatelliteEnabled: boolean;
  pelengHeatmapEnabled: boolean;
  networkCallsignsLoaded: boolean;
  networkCallsignsLoading: boolean;
  networkCallsignsError: string | null;
  catalogCallsignsLoaded: boolean;
  catalogCallsignsLoading: boolean;
  catalogCallsignsError: string | null;
  interceptedCallsignsLoaded: boolean;
  interceptedCallsignsLoading: boolean;
  interceptedCallsignsError: string | null;
  callsignsLoaded: boolean;
  callsignsLoading: boolean;
  callsignsError: string | null;
  callsignStatusFilter: NetworkCallsignStatusFilter;
  callsignSectionMode: NetworkCallsignSectionMode;
  callsignInterceptedExpanded: boolean;
  callsignCreateInFlightCallsigns: string[];
  callsignCatalogAddInFlightIds: number[];
  callsignUpdateInFlightIds: number[];
  callsignDeleteInFlightIds: number[];
  currentUser: User | null;
  currentUserLoaded: boolean;
  units: Unit[];
  posts: Post[];
  aors: AreaOfResponsibility[];
  encryptions: EncryptionRec[];
  callsignDrawerOpen: boolean;
  callsignDrawerMode: NetworkCallsignDrawerMode;
  callsignDrawerForm: NetworkCallsignDrawerForm | null;
  callsignDrawerSaving: boolean;
  callsignDrawerError: string | null;
  callsignDeleteDialogOpen: boolean;
  callsignDeleteTarget: NetworkCallsignRowView | null;
  callsignDeleteSubmitting: boolean;
  callsignDeleteError: string | null;
  callsignDeleteAlsoFromCatalog: boolean;
  loading: boolean;
  referenceLoading: boolean;
  error: string | null;
  referenceWarning: string | null;
  callsignWarning: string | null;
  expandedDescriptionIds: number[];
  activeNetworkDetailsTab: NetworkDetailsTab;
  descriptionDrawerOpen: boolean;
  descriptionDrawerMode: NetworkDescriptionMode;
  descriptionDrawerDescrType: NetworkDescrType;
  descriptionDrawerDescriptionId: number | null;
  descriptionDrawerForm: NetworkDescriptionForm;
  descriptionDrawerSaving: boolean;
  descriptionDrawerError: string | null;
  deleteDescriptionDialogOpen: boolean;
  deleteDescriptionTarget: Network['descriptions'][number] | null;
  deleteDescriptionSubmitting: boolean;
  deleteDescriptionError: string | null;
  expandedFrequencyGroupIds: string[];
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  freqCreateWizardOpen: boolean;
  freqCreateWizardForm: NetworkFreqCreateWizardForm;
  freqCreateWizardSaving: boolean;
  freqCreateWizardError: string | null;
  freqEditDrawerOpen: boolean;
  freqEditDrawerForm: NetworkFreqEditForm | null;
  freqEditDrawerSaving: boolean;
  freqEditDrawerError: string | null;
  freqDeleteDialogOpen: boolean;
  freqDeleteTarget: NetworkFreqsRes | null;
  freqDeleteSubmitting: boolean;
  freqDeleteError: string | null;
  etalonkaReport: NetworkEtalonkaReportState;
  deleteDialogOpen: boolean;
  deleteInProgress: boolean;
  menuAnchorEl: HTMLElement | null;
  copyStatus: string | null;
  copyStatusTone: 'success' | 'error' | null;
  editDrawerOpen: boolean;
  editForm: NetworkEditForm | null;
  editInProgress: boolean;
  editError: string | null;
};

export type DisplayNetworkStatus = {
  label: string;
  tone: 'success' | 'warning';
};

export type NetworkRelationsDateRange = {
  relationsSince: string;
  relationsTill: string;
};

export type NetworkPelengDateRange = {
  pelengSince: string;
  pelengTill: string;
};

export const EMPTY_STATE: NetworkDetailsNeoPageState = {
  network: null,
  sources: [],
  freqs: [],
  freqsLoaded: false,
  freqsLoading: false,
  freqsError: null,
  freqActivityByFreq: {},
  freqCallsignsById: new Map(),
  freqCallsignsStatus: 'idle',
  networkActivity: {},
  networkActivityLoaded: false,
  networkActivityLoading: false,
  networkActivityError: null,
  supportNonRerInterceptions: false,
  pelengPoints: [],
  pelengPointsLoaded: false,
  pelengPointsLoading: false,
  pelengPointsError: null,
  pelengPointsRequestedFrom: null,
  pelengPointsRequestedTo: null,
  pelengSince: '',
  pelengTill: '',
  pelengSearch: '',
  pelengEnabledFreqs: [],
  pelengShowLabels: true,
  pelengSatelliteEnabled: true,
  pelengHeatmapEnabled: false,
  networkCallsignsLoaded: false,
  networkCallsignsLoading: false,
  networkCallsignsError: null,
  catalogCallsignsLoaded: false,
  catalogCallsignsLoading: false,
  catalogCallsignsError: null,
  interceptedCallsignsLoaded: false,
  interceptedCallsignsLoading: false,
  interceptedCallsignsError: null,
  callsignCount: null,
  networkCallsigns: [],
  networkCallsignGroups: [],
  callsignActivityMap: new Map(),
  catalogCallsignGroups: [],
  unknownInterceptedCallsigns: [],
  relations: null,
  relationsLoaded: false,
  relationsLoading: false,
  relationsError: null,
  relationsSearch: '',
  relationsEnabledFreqs: [],
  relationsMinIntensity: NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY,
  relationsShowLabels: true,
  relationsSelectedNodeId: null,
  relationsSelectedEdgeId: null,
  relationsSince: '',
  relationsTill: '',
  callsignsLoaded: false,
  callsignsLoading: false,
  callsignsError: null,
  callsignStatusFilter: 'All',
  callsignSectionMode: 'network',
  callsignInterceptedExpanded: false,
  callsignCreateInFlightCallsigns: [],
  callsignCatalogAddInFlightIds: [],
  callsignUpdateInFlightIds: [],
  callsignDeleteInFlightIds: [],
  currentUser: null,
  currentUserLoaded: false,
  units: [],
  posts: [],
  aors: [],
  encryptions: [],
  callsignDrawerOpen: false,
  callsignDrawerMode: 'create',
  callsignDrawerForm: null,
  callsignDrawerSaving: false,
  callsignDrawerError: null,
  callsignDeleteDialogOpen: false,
  callsignDeleteTarget: null,
  callsignDeleteSubmitting: false,
  callsignDeleteError: null,
  callsignDeleteAlsoFromCatalog: false,
  loading: true,
  referenceLoading: true,
  error: null,
  referenceWarning: null,
  callsignWarning: null,
  expandedDescriptionIds: [],
  activeNetworkDetailsTab: 'descriptions',
  descriptionDrawerOpen: false,
  descriptionDrawerMode: 'create',
  descriptionDrawerDescrType: 'Confirmation',
  descriptionDrawerDescriptionId: null,
  descriptionDrawerForm: {
    topic: '',
    description: '',
    networkFreqId: null,
  },
  descriptionDrawerSaving: false,
  descriptionDrawerError: null,
  deleteDescriptionDialogOpen: false,
  deleteDescriptionTarget: null,
  deleteDescriptionSubmitting: false,
  deleteDescriptionError: null,
  expandedFrequencyGroupIds: [],
  freqRowActionMenuAnchorEl: null,
  freqRowActionTargetId: null,
  freqCreateWizardOpen: false,
  freqCreateWizardForm: {
    freq: '',
    modulation: 'DMR',
    encryptionId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  },
  freqCreateWizardSaving: false,
  freqCreateWizardError: null,
  freqEditDrawerOpen: false,
  freqEditDrawerForm: null,
  freqEditDrawerSaving: false,
  freqEditDrawerError: null,
  freqDeleteDialogOpen: false,
  freqDeleteTarget: null,
  freqDeleteSubmitting: false,
  freqDeleteError: null,
  etalonkaReport: createDefaultNetworkEtalonkaReportState(),
  deleteDialogOpen: false,
  deleteInProgress: false,
  menuAnchorEl: null,
  copyStatus: null,
  copyStatusTone: null,
  editDrawerOpen: false,
  editForm: null,
  editInProgress: false,
  editError: null,
};
