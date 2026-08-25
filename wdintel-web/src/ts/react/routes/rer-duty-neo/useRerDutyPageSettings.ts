import { useEffect, useState } from 'react';
import type { User } from '../../../../Bindings';
import { DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS } from '../../hooks/duty-settings-defaults';
import { currentSystemSettings } from '../../services/api/system-settings';
import { fetchCurrentUser } from '../../services/api/user';
import {
  USER_SETTINGS_UPDATED_EVENT,
  fetchUserSettings,
  type MessageTextPreviewLineLimit,
} from '../../services/api/user-settings';
import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from './utils';

export type RerDutyPageSettings = {
  currentUser: User | null;
  cyberEchoEnabled: boolean;
  tagsLayout: TagsLayoutVariant;
  audioTranscriptionCollapsed: boolean;
  audioTranscriptionEnabled: boolean;
  collapseMediaPreviews: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
};

/** User preferences, system settings, and the auth user behind the Duty page chrome. */
export function useRerDutyPageSettings(): RerDutyPageSettings {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [cyberEchoEnabled, setCyberEchoEnabled] = useState(false);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [audioTranscriptionCollapsed, setAudioTranscriptionCollapsed] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [collapseMediaPreviews, setCollapseMediaPreviews] = useState(
    DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  );
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
        setMessageTextPreviewLines(prefs.messageTextPreviewLines);
      } catch {
        if (cancelled) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
        setAudioTranscriptionCollapsed(false);
        setCollapseMediaPreviews(true);
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
        setCyberEchoEnabled(settings.devicesSectionEnabled);
        setAudioTranscriptionEnabled(settings.enableAudioTranscription ?? false);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setCyberEchoEnabled(false);
        setAudioTranscriptionEnabled(false);
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
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setCurrentUser(null);
      });

    return () => {
      abortController.abort();
    };
  }, []);

  return {
    currentUser,
    cyberEchoEnabled,
    tagsLayout,
    audioTranscriptionCollapsed,
    audioTranscriptionEnabled,
    collapseMediaPreviews,
    messageTextPreviewLines,
  };
}
