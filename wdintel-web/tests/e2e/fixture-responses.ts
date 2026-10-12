import type { SystemSettingsCurrentRsp } from '../../src/Bindings';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';

export function networkSettingsResponse() {
  return {
    showTableRowNumbers: true,
  };
}

export function systemSettingsCurrentResponse({
  enableAudioTranscription = false,
  shortUrlEnabled = false,
  dutyExcludeMenuEnabled = true,
  analysisAorFilterEnabled = true,
  hideNetworks = false,
}: {
  enableAudioTranscription?: boolean;
  shortUrlEnabled?: boolean;
  dutyExcludeMenuEnabled?: boolean;
  analysisAorFilterEnabled?: boolean;
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
    rerReportEnabled: false,
    supportNonRerInterceptions: false,
    defaultNeoAnalysis: false,
    autofixEchoimMissingMessages: false,
    pelengBoundsEnabled: false,
    pelengBoundsTopLeftLat: null,
    pelengBoundsTopLeftLng: null,
    pelengBoundsBottomRightLat: null,
    pelengBoundsBottomRightLng: null,
    devicesSectionEnabled: false,
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
    analysisAorFilterEnabled,
    hideNetworks,
    aiPositionHighlightsEnabled: false,
    twoFactorAuthEnabled: true,
    apiRateLimitReplenishIntervalMs: 500,
    apiRateLimitBurstSize: 5,
  };
  return transformCamelToSnake<Record<string, unknown>>(settings);
}
