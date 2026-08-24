import type { DutyTagsLayout, UserDutySettingsDto } from '../../../../Bindings';

import { getJson, putJson } from './client';
import { DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS } from '../../hooks/duty-settings-defaults';
import type { TagsLayoutVariant } from '../../routes/rer-duty-neo/utils';

export const USER_SETTINGS_UPDATED_EVENT = 'user-settings-updated';

export type { UserDutySettingsDto };
export type UserDutySettings = {
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  tagsLayout: TagsLayoutVariant;
  disableAutoScroll: boolean;
  analysisMapInSidebar: boolean;
  dutyAudioTranscriptionCollapsed: boolean;
  analysisAudioTranscriptionCollapsed: boolean;
  showAnalysisCallsignAddForm: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  dutyCollapseMediaPreviews: boolean;
};

export type MessageTextPreviewLineLimit = 20 | 40 | null;

type DutyTagsLayoutWire = DutyTagsLayout | 'full' | 'compact' | 'hidden';
type UserDutySettingsWire = Omit<
  UserDutySettingsDto,
  | 'tagsLayout'
  | 'analysisMapInSidebar'
  | 'dutyAudioTranscriptionCollapsed'
  | 'analysisAudioTranscriptionCollapsed'
  | 'showAnalysisCallsignAddForm'
  | 'showClassicDuty'
  | 'showClassicAnalysis'
  | 'dutyCollapseMediaPreviews'
> & {
  messageTextPreviewLines?: string | null;
  tagsLayout: DutyTagsLayoutWire;
  analysisMapInSidebar?: boolean | null;
  dutyAudioTranscriptionCollapsed?: boolean | null;
  analysisAudioTranscriptionCollapsed?: boolean | null;
  showAnalysisCallsignAddForm?: boolean | null;
  showClassicDuty?: boolean | null;
  showClassicAnalysis?: boolean | null;
  dutyCollapseMediaPreviews?: boolean | null;
};

function normalizeMessageTextPreviewLines(
  value: string | number | null | undefined,
): MessageTextPreviewLineLimit {
  switch (value) {
    case 'forty':
    case 'Forty':
    case 40:
      return 40;
    case 'off':
    case 'Off':
      return null;
    case 'twenty':
    case 'Twenty':
    case 20:
    default:
      return 20;
  }
}

function serializeMessageTextPreviewLines(value: MessageTextPreviewLineLimit): string {
  return value === 40 ? 'forty' : value === null ? 'off' : 'twenty';
}

function normalizeTagsLayout(tagsLayout: DutyTagsLayoutWire | null | undefined): TagsLayoutVariant {
  switch (tagsLayout) {
    case 'compact':
    case 'Compact':
      return 'compact';
    case 'full':
    case 'Full':
      return 'full';
    case 'hidden':
    case 'Hidden':
      return 'hidden';
    default:
      return 'compact';
  }
}

function serializeTagsLayout(tagsLayout: TagsLayoutVariant): DutyTagsLayoutWire {
  switch (tagsLayout) {
    case 'full':
      return 'full';
    case 'compact':
      return 'compact';
    case 'hidden':
      return 'hidden';
    default:
      return 'compact';
  }
}

function normalizeUserDutySettings(raw: UserDutySettingsWire): UserDutySettings {
  return {
    messageTextPreviewLines: normalizeMessageTextPreviewLines(raw.messageTextPreviewLines),
    tagsLayout: normalizeTagsLayout(raw.tagsLayout),
    disableAutoScroll: raw.disableAutoScroll,
    analysisMapInSidebar: raw.analysisMapInSidebar ?? false,
    dutyAudioTranscriptionCollapsed: raw.dutyAudioTranscriptionCollapsed ?? false,
    analysisAudioTranscriptionCollapsed: raw.analysisAudioTranscriptionCollapsed ?? false,
    showAnalysisCallsignAddForm: raw.showAnalysisCallsignAddForm ?? false,
    showClassicDuty: raw.showClassicDuty ?? false,
    showClassicAnalysis: raw.showClassicAnalysis ?? false,
    dutyCollapseMediaPreviews:
      raw.dutyCollapseMediaPreviews ?? DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  };
}

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserDutySettings> {
  const response = await getJson<UserDutySettingsWire>('/api/user/settings', { signal });
  return normalizeUserDutySettings(response);
}

export async function saveUserSettings(
  body: UserDutySettings,
  signal?: AbortSignal,
): Promise<UserDutySettings> {
  const response = await putJson<UserDutySettingsWire>(
    '/api/user/settings',
    {
      messageTextPreviewLines: serializeMessageTextPreviewLines(body.messageTextPreviewLines),
      tagsLayout: serializeTagsLayout(body.tagsLayout),
      disableAutoScroll: body.disableAutoScroll,
      analysisMapInSidebar: body.analysisMapInSidebar,
      dutyAudioTranscriptionCollapsed: body.dutyAudioTranscriptionCollapsed,
      analysisAudioTranscriptionCollapsed: body.analysisAudioTranscriptionCollapsed,
      showAnalysisCallsignAddForm: body.showAnalysisCallsignAddForm,
      showClassicDuty: body.showClassicDuty,
      showClassicAnalysis: body.showClassicAnalysis,
      dutyCollapseMediaPreviews: body.dutyCollapseMediaPreviews,
    },
    { signal },
  );
  return normalizeUserDutySettings(response);
}
