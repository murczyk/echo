import type { ListNetworksRsp, ListUnitsRsp, SystemSettingsCurrentRsp } from '../../src/Bindings';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';

export function emptyUnitsListResponse() {
  const response: ListUnitsRsp = {
    showLoadMore: false,
    totalCount: 0,
    statusCounts: { active: 0, inactive: 0 },
    units: [],
  };
  return transformCamelToSnake<Record<string, unknown>>(response);
}

export function emptyNetworksListResponse() {
  const response: ListNetworksRsp = {
    list: [],
    statusCounts: { active: 0, inactive: 0, archived: 0 },
  };
  return transformCamelToSnake<Record<string, unknown>>(response);
}

export function networkSettingsResponse() {
  return {
    showTableRowNumbers: true,
  };
}

export function systemSettingsCurrentResponse({
  enableAudioTranscription = false,
  shortUrlEnabled = false,
  dutyExcludeMenuEnabled = true,
  dutySelectedGroupsEnabled = true,
  analysisAorFilterEnabled = true,
  rerReportEnabled = false,
  hideNetworks = false,
}: {
  enableAudioTranscription?: boolean;
  shortUrlEnabled?: boolean;
  dutyExcludeMenuEnabled?: boolean;
  dutySelectedGroupsEnabled?: boolean;
  analysisAorFilterEnabled?: boolean;
  rerReportEnabled?: boolean;
  hideNetworks?: boolean;
} = {}) {
  const settings: SystemSettingsCurrentRsp = {
    id: null,
    rerAnalysisUnitsExactMatchOnlyDefault: false,
    rerDutyTestEnabled: false,
    rerDutyInsertHistoricalInterceptions: false,
    rerDutyTestSinceMs: 0,
    rerDutyTestLimit: 1,
    rerDutyPollIntervalSec: 1,
    rerDutyTestReplayIntervalSec: 1,
    shortUrlEnabled,
    rerReportEnabled,
    supportNonRerInterceptions: false,
    defaultNeoAnalysis: false,
    autofixEchoimMissingMessages: false,
    pelengBoundsEnabled: false,
    pelengBoundsTopLeftLat: null,
    pelengBoundsTopLeftLng: null,
    pelengBoundsBottomRightLat: null,
    pelengBoundsBottomRightLng: null,
    devicesSectionEnabled: false,
    docMediaServeFromB2: false,
    sigintCommentParsingEnabled: false,
    doNotStoreDuplicateEchoimFailures: false,
    goiAssociationMessageUidWorkerEnabled: false,
    reportChunkingHours: 1,
    limitBigReports: false,
    enableAudioTranscription,
    showClassicDuty: false,
    showClassicAnalysis: false,
    showPelengDistanceToBattleline: false,
    hideOrbitData: false,
    excludeOrbitOtherUnits: false,
    disableBotTags: false,
    dutyExcludeMenuEnabled,
    dutySelectedGroupsEnabled,
    analysisAorFilterEnabled,
    hideNetworks,
    aiPositionHighlightsEnabled: false,
    aiNetworkMatchEnabled: false,
    importantNotifyAllEnabled: true,
    twoFactorAuthEnabled: true,
    apiRateLimitReplenishIntervalMs: 500,
    apiRateLimitBurstSize: 5,
  };
  return transformCamelToSnake<Record<string, unknown>>(settings);
}
