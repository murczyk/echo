import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from '../routes/rer-duty-neo/utils';
import {
  DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
  DEFAULT_MEDIA_SUMMARY_ENABLED,
} from './duty-settings-defaults';
import {
  USER_SETTINGS_UPDATED_EVENT,
  fetchUserSettings,
  saveUserSettings,
  type UserDutySettings,
  type MessageTextPreviewLineLimit,
  type MessageTimeBasis,
} from '../services/api/user-settings';

type DutySettingsValue = UserDutySettings;

type DutySettingsSaveRequest = DutySettingsValue;

export type DutySettingsHook = DutySettingsValue & {
  loadInProgress: boolean;
  loadError: string | null;
  saveError: string | null;
  saveInProgress: boolean;
  setTagsLayout: (value: TagsLayoutVariant) => void;
  setDisableAutoScroll: (value: boolean) => void;
  setAnalysisMapInSidebar: (value: boolean) => void;
  setDutyAudioTranscriptionCollapsed: (value: boolean) => void;
  setAnalysisAudioTranscriptionCollapsed: (value: boolean) => void;
  setShowAnalysisCallsignAddForm: (value: boolean) => void;
  setShowClassicDuty: (value: boolean) => void;
  setShowClassicAnalysis: (value: boolean) => void;
  setDutyCollapseMediaPreviews: (value: boolean) => void;
  setMediaSummaryEnabled: (value: boolean) => void;
  setMessageTextPreviewLines: (value: MessageTextPreviewLineLimit) => void;
  setMessageSortBy: (value: MessageTimeBasis) => void;
  scheduleSave: (nextSettings: DutySettingsSaveRequest) => void;
};

function normalizeDutySettings(
  settings: Partial<DutySettingsValue> | null | undefined,
): DutySettingsValue {
  const messageTextPreviewLines = settings?.messageTextPreviewLines;

  return {
    messageSortBy: settings?.messageSortBy === 'creation' ? 'creation' : 'interception',
    messageTextPreviewLines: messageTextPreviewLines === undefined ? 20 : messageTextPreviewLines,
    tagsLayout: settings?.tagsLayout ?? DEFAULT_DUTY_TAGS_LAYOUT,
    disableAutoScroll: settings?.disableAutoScroll ?? false,
    analysisMapInSidebar: settings?.analysisMapInSidebar ?? false,
    dutyAudioTranscriptionCollapsed: settings?.dutyAudioTranscriptionCollapsed ?? false,
    analysisAudioTranscriptionCollapsed: settings?.analysisAudioTranscriptionCollapsed ?? false,
    showAnalysisCallsignAddForm: settings?.showAnalysisCallsignAddForm ?? false,
    showClassicDuty: settings?.showClassicDuty ?? false,
    showClassicAnalysis: settings?.showClassicAnalysis ?? false,
    dutyCollapseMediaPreviews:
      settings?.dutyCollapseMediaPreviews ?? DEFAULT_DUTY_COLLAPSE_MEDIA_PREVIEWS,
    mediaSummaryEnabled: settings?.mediaSummaryEnabled ?? DEFAULT_MEDIA_SUMMARY_ENABLED,
  };
}

export function useDutySettings(): DutySettingsHook {
  const [settings, setSettings] = useState<DutySettingsValue>(normalizeDutySettings(null));
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const pendingSaveRef = useRef<DutySettingsSaveRequest | null>(null);
  const saveRunningRef = useRef(false);

  const applySettings = useCallback((nextSettings: DutySettingsValue) => {
    setSettings(nextSettings);
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void fetchUserSettings(abortController.signal)
      .then((nextSettings) => {
        if (abortController.signal.aborted) return;
        applySettings(normalizeDutySettings(nextSettings));
        setLoadError(null);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        applySettings(normalizeDutySettings(null));
        setLoadError('Не вдалося завантажити налаштування.');
      })
      .finally(() => {
        if (abortController.signal.aborted) return;
        setLoadInProgress(false);
      });

    return () => {
      abortController.abort();
    };
  }, [applySettings]);

  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Partial<DutySettingsValue>>).detail;
      if (detail == null) return;
      applySettings(normalizeDutySettings(detail));
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, [applySettings]);

  const flushSaveQueue = useCallback(async () => {
    if (saveRunningRef.current) return;
    saveRunningRef.current = true;
    setSaveInProgress(true);

    try {
      while (pendingSaveRef.current != null) {
        const nextSettings = pendingSaveRef.current;
        pendingSaveRef.current = null;

        try {
          const savedSettings = await saveUserSettings(nextSettings);
          const normalized = normalizeDutySettings(savedSettings);
          applySettings(normalized);
          setSaveError(null);
          window.dispatchEvent(
            new CustomEvent(USER_SETTINGS_UPDATED_EVENT, { detail: normalized }),
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Помилка збереження налаштувань.';
          setSaveError(`Помилка збереження: ${message}`);
          break;
        }
      }
    } finally {
      saveRunningRef.current = false;
      setSaveInProgress(false);
      if (pendingSaveRef.current != null) {
        void flushSaveQueue();
      }
    }
  }, [applySettings]);

  const scheduleSave = useCallback(
    (nextSettings: DutySettingsSaveRequest) => {
      setSaveError(null);
      pendingSaveRef.current = nextSettings;
      void flushSaveQueue();
    },
    [flushSaveQueue],
  );

  return {
    ...settings,
    loadInProgress,
    loadError,
    saveError,
    saveInProgress,
    setTagsLayout: (value) => setSettings((current) => ({ ...current, tagsLayout: value })),
    setDisableAutoScroll: (value) =>
      setSettings((current) => ({ ...current, disableAutoScroll: value })),
    setAnalysisMapInSidebar: (value) =>
      setSettings((current) => ({ ...current, analysisMapInSidebar: value })),
    setDutyAudioTranscriptionCollapsed: (value) =>
      setSettings((current) => ({ ...current, dutyAudioTranscriptionCollapsed: value })),
    setAnalysisAudioTranscriptionCollapsed: (value) =>
      setSettings((current) => ({ ...current, analysisAudioTranscriptionCollapsed: value })),
    setShowAnalysisCallsignAddForm: (value) =>
      setSettings((current) => ({ ...current, showAnalysisCallsignAddForm: value })),
    setShowClassicDuty: (value) =>
      setSettings((current) => ({ ...current, showClassicDuty: value })),
    setShowClassicAnalysis: (value) =>
      setSettings((current) => ({ ...current, showClassicAnalysis: value })),
    setDutyCollapseMediaPreviews: (value) =>
      setSettings((current) => ({ ...current, dutyCollapseMediaPreviews: value })),
    setMediaSummaryEnabled: (value) =>
      setSettings((current) => ({ ...current, mediaSummaryEnabled: value })),
    setMessageTextPreviewLines: (value) =>
      setSettings((current) => ({ ...current, messageTextPreviewLines: value })),
    setMessageSortBy: (value) => setSettings((current) => ({ ...current, messageSortBy: value })),
    scheduleSave,
  };
}
