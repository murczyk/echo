import type {
  DutyTagsLayout,
  MessageCardQuickAction,
  UserDutySettingsDto,
} from '../../../../Bindings';

import { getJson, putJson } from './client';
import {
  DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  DEFAULT_MEDIA_SUMMARY_ENABLED,
  DEFAULT_MESSAGE_AUTO_PARSE_ENABLED,
} from '../../hooks/duty-settings-defaults';
import type { TagsLayoutVariant } from '../../routes/rer-duty-neo/utils';

export const USER_SETTINGS_UPDATED_EVENT = 'user-settings-updated';

export enum MessageAttachmentPreviewMode {
  Collapsed = 'collapsed',
  Compact = 'compact',
  Large = 'large',
}

export type { MessageCardQuickAction, UserDutySettingsDto };

export const MESSAGE_CARD_QUICK_ACTION_OPTIONS: ReadonlyArray<{
  value: MessageCardQuickAction;
  label: string;
}> = [
  { value: 'createReport', label: 'Створити розвіддонесення' },
  { value: 'reply', label: 'Відповісти' },
  { value: 'important', label: 'Позначити як важливе' },
  { value: 'bookmark', label: 'Додати в закладки' },
  { value: 'copyText', label: 'Копіювати повідомлення' },
  { value: 'copyLink', label: 'Копіювати посилання на повідомлення' },
  { value: 'edit', label: 'Редагувати' },
  { value: 'delete', label: 'Видалити' },
];

export function normalizeMessageCardQuickAction(value: unknown): MessageCardQuickAction {
  return (
    MESSAGE_CARD_QUICK_ACTION_OPTIONS.find((option) => option.value === value)?.value ??
    'createReport'
  );
}
export type UserDutySettings = {
  messageCardQuickAction: MessageCardQuickAction;
  /** Analysis time basis. Duty always uses creation time. */
  messageSortBy: MessageTimeBasis;
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
  largeMediaPreviews: boolean;
  largeMessageCardText: boolean;
  mediaSummaryEnabled: boolean;
  messageAutoParseEnabled: boolean;
  aiPositionHighlightsEnabled: UserDutySettingsDto['aiPositionHighlightsEnabled'];
  minimalReportWindowEnabled: boolean;
};

export type UserDutySettingsUpdate = Omit<UserDutySettings, 'messageCardQuickAction'> & {
  messageCardQuickAction?: MessageCardQuickAction;
};

export type MessageTimeBasis = 'interception' | 'creation';

export type MessageTextPreviewLineLimit = 20 | 40 | null;

type DutyTagsLayoutWire = DutyTagsLayout | 'full' | 'compact' | 'hidden';
type UserDutySettingsWire = Omit<
  UserDutySettingsDto,
  | 'messageCardQuickAction'
  | 'tagsLayout'
  | 'analysisMapInSidebar'
  | 'dutyAudioTranscriptionCollapsed'
  | 'analysisAudioTranscriptionCollapsed'
  | 'showAnalysisCallsignAddForm'
  | 'showClassicDuty'
  | 'showClassicAnalysis'
  | 'dutyCollapseMediaPreviews'
  | 'largeMediaPreviews'
  | 'largeMessageCardText'
  | 'mediaSummaryEnabled'
  | 'messageSortBy'
  | 'messageAutoParseEnabled'
  | 'aiPositionHighlightsEnabled'
  | 'minimalReportWindowEnabled'
> & {
  messageCardQuickAction?: MessageCardQuickAction | null;
  messageTextPreviewLines?: string | null;
  tagsLayout: DutyTagsLayoutWire;
  analysisMapInSidebar?: boolean | null;
  dutyAudioTranscriptionCollapsed?: boolean | null;
  analysisAudioTranscriptionCollapsed?: boolean | null;
  showAnalysisCallsignAddForm?: boolean | null;
  showClassicDuty?: boolean | null;
  showClassicAnalysis?: boolean | null;
  dutyCollapseMediaPreviews?: boolean | null;
  largeMediaPreviews?: boolean | null;
  largeMessageCardText?: boolean | null;
  mediaSummaryEnabled?: boolean | null;
  messageSortBy?: MessageTimeBasis | null;
  messageAutoParseEnabled?: boolean | null;
  aiPositionHighlightsEnabled?: UserDutySettingsDto['aiPositionHighlightsEnabled'] | null;
  minimalReportWindowEnabled?: boolean | null;
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
    messageCardQuickAction: normalizeMessageCardQuickAction(raw.messageCardQuickAction),
    messageSortBy: raw.messageSortBy === 'creation' ? 'creation' : 'interception',
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
    largeMediaPreviews: raw.largeMediaPreviews ?? false,
    largeMessageCardText: raw.largeMessageCardText ?? false,
    mediaSummaryEnabled: raw.mediaSummaryEnabled ?? DEFAULT_MEDIA_SUMMARY_ENABLED,
    aiPositionHighlightsEnabled: raw.aiPositionHighlightsEnabled ?? false,
    messageAutoParseEnabled: raw.messageAutoParseEnabled ?? DEFAULT_MESSAGE_AUTO_PARSE_ENABLED,
    minimalReportWindowEnabled: raw.minimalReportWindowEnabled ?? false,
  };
}

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserDutySettings> {
  const response = await getJson<UserDutySettingsWire>('/api/user/settings', { signal });
  return normalizeUserDutySettings(response);
}

export async function saveUserSettings(
  body: UserDutySettingsUpdate,
  signal?: AbortSignal,
): Promise<UserDutySettings> {
  const response = await putJson<UserDutySettingsWire>(
    '/api/user/settings',
    {
      messageCardQuickAction: body.messageCardQuickAction,
      messageSortBy: body.messageSortBy,
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
      largeMediaPreviews: body.largeMediaPreviews,
      largeMessageCardText: body.largeMessageCardText,
      mediaSummaryEnabled: body.mediaSummaryEnabled,
      aiPositionHighlightsEnabled: body.aiPositionHighlightsEnabled,
      messageAutoParseEnabled: body.messageAutoParseEnabled,
      minimalReportWindowEnabled: body.minimalReportWindowEnabled,
    },
    { signal },
  );
  return normalizeUserDutySettings(response);
}
