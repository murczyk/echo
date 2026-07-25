import type {
  CallsignActivityItem,
  NetworkCallsign,
  NetworkCallsignRes,
} from '../../../../Bindings';

export type NetworkCallsignSectionMode = 'network' | 'catalog' | 'intercepted';

export type NetworkCallsignStatusFilter = 'All' | 'Developing' | 'Catalog' | 'Unknown';

export type NetworkCallsignStatus = 'developing' | 'catalog' | 'unknown';
export type NetworkCallsignMarkerMode = 'mainRadioStation' | 'commandControl' | 'none';

export enum NetworkCallsignSourceId {
  RO = 2,
}

export type NetworkCallsignDrawerMode = 'create' | 'edit';

export type NetworkCallsignDrawerForm = {
  id: number | null;
  networkId: number;
  callsign: string;
  fullName: string;
  position: string;
  comment: string;
  sourceId: number | null;
  radioFreq: string;
  unitId: number | null;
  unitDeveloping: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  commandControl: boolean;
};

export type NetworkCallsignRowView = {
  id: number;
  callsign: string;
  fullName: string;
  status: NetworkCallsignStatus;
  statusLabel: string;
  position: string;
  unitId: number | null;
  unitName: string;
  lastDatetime: number | null;
  messageCount: number;
  comment: string;
  sourceName: string;
  knownCallsignId: number | null;
  active: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  unitDeveloping: boolean;
  sourceId: number | null;
  radioFreq: string | null;
  networkId: number;
  commandControl: boolean;
};

export type NetworkCallsignCatalogCallsign = {
  id: number;
  callsign: string;
  position: string;
  comment: string;
  unitId: number;
  unitName: string;
  sourceName: string;
  createdAt: number;
};

export type NetworkCallsignCatalogGroupView = {
  callsign: string;
  knownCallsigns: NetworkCallsignCatalogCallsign[];
  messageCount: number;
  lastDatetime: number | null;
  freqs: string[] | null;
  isOld: boolean;
  isInDictionary: boolean;
  activity: CallsignActivityItem | null;
};

export type NetworkCallsignInterceptedView = {
  callsign: string;
  messageCount: number;
  lastDatetime: number | null;
  freqs: string[] | null;
  isOld: boolean;
  isInDictionary: boolean;
  activity: CallsignActivityItem | null;
};

export type NetworkCallsignCatalogRowView = {
  id: number;
  knownCallsignId: number;
  callsign: string;
  position: string;
  unitName: string;
  lastDatetime: number | null;
  messageCount: number;
  comment: string;
  dateBoundAt: number;
  sourceName: string;
  networkCallsign: string;
  freqs: string[] | null;
};

export type NetworkCallsignStatusCounts = {
  all: number;
  developing: number;
  catalog: number;
  unknown: number;
};

export type NetworkCallsignActivityMap = Map<string, CallsignActivityItem>;

export type NetworkCallsignsDerivedData = {
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
};

export type NetworkCallsignTabStore = {
  networkCallsignGroups: NetworkCallsignRes[];
  activityMap: NetworkCallsignActivityMap;
  networkCallsigns: NetworkCallsign[];
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
};
