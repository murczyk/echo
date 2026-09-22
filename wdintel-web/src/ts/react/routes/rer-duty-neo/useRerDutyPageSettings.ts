import { useEffect, useState } from 'react';
import type { User } from '../../../../Bindings';
import {
  DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  DEFAULT_MEDIA_SUMMARY_ENABLED,
} from '../../hooks/duty-settings-defaults';
import { currentSystemSettings } from '../../services/api/system-settings';
import { fetchCurrentUser } from '../../services/api/user';
import {
  USER_SETTINGS_UPDATED_EVENT,
  fetchUserSettings,
  type MessageTextPreviewLineLimit,
} from '../../services/api/user-settings';
import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from './utils';
import { canUseMessageDevices } from '../../utils/roles';

export type RerDutyPageSettings = {
  currentUser: User | null;
  cyberEchoEnabled: boolean;
  deviceAccess: DeviceAccess;
  tagsLayout: TagsLayoutVariant;
  audioTranscriptionCollapsed: boolean;
  audioTranscriptionEnabled: boolean;
  hideBotTags: boolean;
  collapseMediaPreviews: boolean;
  mediaSummaryEnabled: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
};

export type DeviceAccess =
  | { status: 'loading' }
  | { status: 'allowed' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

/** User preferences, system settings, and the auth user behind the Duty page chrome. */
export function useRerDutyPageSettings(): RerDutyPageSettings {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentUserStatus, setCurrentUserStatus] = useState<'loading' | 'success' | 'error'>(
    'loading',
  );
  const [devicesSectionEnabled, setDevicesSectionEnabled] = useState(false);
  const [devicesSettingsStatus, setDevicesSettingsStatus] = useState<
    'loading' | 'success' | 'error'
  >('loading');
  const [deviceAccessError, setDeviceAccessError] = useState<string | null>(null);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [audioTranscriptionCollapsed, setAudioTranscriptionCollapsed] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [hideBotTags, setHideBotTags] = useState(false);
  const [collapseMediaPreviews, setCollapseMediaPreviews] = useState(
    DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  );
  const [mediaSummaryEnabled, setMediaSummaryEnabled] = useState(DEFAULT_MEDIA_SUMMARY_ENABLED);
  const [messageTextPreviewLines, setMessageTextPreviewLines] =
    useState<MessageTextPreviewLineLimit>(20);

  useEffect(() => {
    let cancelled = false;
    const loadLayout = async () => {
      try {
        const prefs = await fetchUserSettings();
        if (cancelled) return;
        setTagsLayout(prefs.tagsLayout);
        setAudioTranscriptionCollapsed(prefs.dutyAudioTranscriptionCollapsed ?? false);
        setCollapseMediaPreviews(
          prefs.dutyCollapseMediaPreviews ?? DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
        );
        setMediaSummaryEnabled(prefs.mediaSummaryEnabled ?? DEFAULT_MEDIA_SUMMARY_ENABLED);
        setMessageTextPreviewLines(prefs.messageTextPreviewLines);
      } catch {
        if (cancelled) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
        setAudioTranscriptionCollapsed(false);
        setCollapseMediaPreviews(true);
        setMediaSummaryEnabled(DEFAULT_MEDIA_SUMMARY_ENABLED);
        setMessageTextPreviewLines(20);
      }
    };
    loadLayout();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          tagsLayout?: TagsLayoutVariant;
          dutyAudioTranscriptionCollapsed?: boolean;
          dutyCollapseMediaPreviews?: boolean;
          mediaSummaryEnabled?: boolean;
          messageTextPreviewLines?: MessageTextPreviewLineLimit;
        }>
      ).detail;
      if (detail?.tagsLayout) {
        setTagsLayout(detail.tagsLayout);
      }
      if (typeof detail?.dutyAudioTranscriptionCollapsed === 'boolean') {
        setAudioTranscriptionCollapsed(detail.dutyAudioTranscriptionCollapsed);
      }
      if (typeof detail?.dutyCollapseMediaPreviews === 'boolean') {
        setCollapseMediaPreviews(detail.dutyCollapseMediaPreviews);
      }
      if (typeof detail?.mediaSummaryEnabled === 'boolean') {
        setMediaSummaryEnabled(detail.mediaSummaryEnabled);
      }
      if (
        detail?.messageTextPreviewLines === 20 ||
        detail?.messageTextPreviewLines === 40 ||
        detail?.messageTextPreviewLines === null
      ) {
        setMessageTextPreviewLines(detail.messageTextPreviewLines);
      }
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void currentSystemSettings()
      .then((settings) => {
        if (abortController.signal.aborted) return;
        setDevicesSectionEnabled(settings.devicesSectionEnabled);
        setAudioTranscriptionEnabled(settings.enableAudioTranscription ?? false);
        setHideBotTags(settings.disableBotTags ?? false);
        setDevicesSettingsStatus('success');
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setDevicesSectionEnabled(false);
        setAudioTranscriptionEnabled(false);
        setHideBotTags(false);
        setDevicesSettingsStatus('error');
        setDeviceAccessError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void fetchCurrentUser(abortController.signal)
      .then((user) => {
        if (abortController.signal.aborted) return;
        setCurrentUser(user);
        setCurrentUserStatus('success');
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setCurrentUser(null);
        setCurrentUserStatus('error');
        setDeviceAccessError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      abortController.abort();
    };
  }, []);

  const deviceAccess: DeviceAccess =
    currentUserStatus === 'error' || devicesSettingsStatus === 'error'
      ? {
          status: 'error',
          message: deviceAccessError ?? 'Не вдалося перевірити доступ до пристроїв.',
        }
      : currentUserStatus === 'loading' || devicesSettingsStatus === 'loading'
        ? { status: 'loading' }
        : canUseMessageDevices(currentUser?.roles, devicesSectionEnabled)
          ? { status: 'allowed' }
          : { status: 'denied' };
  return {
    currentUser,
    cyberEchoEnabled: canUseMessageDevices(currentUser?.roles, devicesSectionEnabled),
    deviceAccess,
    tagsLayout,
    audioTranscriptionCollapsed,
    audioTranscriptionEnabled,
    hideBotTags,
    collapseMediaPreviews,
    mediaSummaryEnabled,
    messageTextPreviewLines,
  };
}
