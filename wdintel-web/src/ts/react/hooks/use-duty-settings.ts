import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from '../routes/rer-duty-neo/utils';
import {
  USER_SETTINGS_UPDATED_EVENT,
  fetchUserSettings,
  saveUserSettings,
  type UserDutySettings,
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
  scheduleSave: (nextSettings: DutySettingsSaveRequest) => void;
};

function normalizeDutySettings(
  settings: Partial<DutySettingsValue> | null | undefined,
): DutySettingsValue {
  return {
    tagsLayout: settings?.tagsLayout ?? DEFAULT_DUTY_TAGS_LAYOUT,
    disableAutoScroll: settings?.disableAutoScroll ?? false,
    analysisMapInSidebar: settings?.analysisMapInSidebar ?? false,
    dutyAudioTranscriptionCollapsed: settings?.dutyAudioTranscriptionCollapsed ?? false,
    analysisAudioTranscriptionCollapsed: settings?.analysisAudioTranscriptionCollapsed ?? false,
    showAnalysisCallsignAddForm: settings?.showAnalysisCallsignAddForm ?? false,
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
    scheduleSave,
  };
}
