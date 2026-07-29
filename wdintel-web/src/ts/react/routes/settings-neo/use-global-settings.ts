import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SettingsSaveReq, SigintZone } from '../../../../Bindings';
import { fetchServerInfo } from '../../services/api/server-info';
import { currentSystemSettings } from '../../services/api/system-settings';
import { fetchCurrentUser, saveUserSettings as saveAccountSettings } from '../../services/api/user';
import { listSigintZones } from '../../services/api/zones';

type ZonePair = [number, SigintZone];
type ZoneOption = { id: number; label: string };

export type GlobalSettingsHook = {
  zoneOptions: ZoneOption[];
  selectedZone: ZoneOption | null;
  loadInProgress: boolean;
  loadError: string | null;
  saveError: string | null;
  saveSuccess: string | null;
  saveInProgress: boolean;
  versionText: string;
  featureMyAdminGroupsEdit: boolean;
  audioTranscriptionEnabled: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  userRoles: string[];
  isDirty: boolean;
  setZoneId: (value: number | null) => void;
  save: () => Promise<void>;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function toSettingsSaveReq(sigintZoneId: number | null): SettingsSaveReq {
  return { sigintZoneId };
}

export function useGlobalSetting(): GlobalSettingsHook {
  const [zones, setZones] = useState<ZonePair[]>([]);
  const [zoneId, setZoneIdState] = useState<number | null>(null);
  const [initialZoneId, setInitialZoneId] = useState<number | null>(null);
  const [versionText, setVersionText] = useState<string>('невідома версія');
  const [featureMyAdminGroupsEdit, setFeatureMyAdminGroupsEdit] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [showClassicDuty, setShowClassicDuty] = useState(true);
  const [showClassicAnalysis, setShowClassicAnalysis] = useState(true);
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);

  const zoneOptions = useMemo(() => zones.map(([id, zone]) => ({ id, label: zone.name })), [zones]);
  const selectedZone = useMemo(
    () => zoneOptions.find((option) => option.id === zoneId) ?? null,
    [zoneOptions, zoneId],
  );
  const isDirty = zoneId !== initialZoneId;

  useEffect(() => {
    const abortController = new AbortController();

    async function loadPageData() {
      setLoadInProgress(true);
      setLoadError(null);

      try {
        const [zonesData, user] = await Promise.all([
          listSigintZones(abortController.signal),
          fetchCurrentUser(abortController.signal),
        ]);

        if (abortController.signal.aborted) return;
        setZones(zonesData);
        setZoneIdState(user.sigintZoneId);
        setInitialZoneId(user.sigintZoneId);
        setUserRoles(user.roles ?? []);

        void fetchServerInfo(abortController.signal)
          .then((serverInfo) => {
            if (abortController.signal.aborted) return;
            setVersionText(serverInfo.version || 'невідома версія');
            setFeatureMyAdminGroupsEdit(Boolean(serverInfo.featureMyAdminGroupsEdit));
          })
          .catch(() => {
            if (abortController.signal.aborted) return;
            setVersionText('невідома версія');
            setFeatureMyAdminGroupsEdit(false);
          });
        void currentSystemSettings()
          .then((systemSettings) => {
            if (abortController.signal.aborted) return;
            setAudioTranscriptionEnabled(systemSettings.enableAudioTranscription ?? false);
            setShowClassicDuty(systemSettings.showClassicDuty ?? true);
            setShowClassicAnalysis(systemSettings.showClassicAnalysis ?? true);
          })
          .catch(() => {
            if (abortController.signal.aborted) return;
            setAudioTranscriptionEnabled(false);
            setShowClassicDuty(true);
            setShowClassicAnalysis(true);
          });
      } catch (error) {
        if (abortController.signal.aborted) return;
        setLoadError(`Помилка завантаження налаштувань: ${formatErrorMessage(error)}`);
      } finally {
        if (abortController.signal.aborted) return;
        setLoadInProgress(false);
      }
    }

    void loadPageData();

    return () => {
      abortController.abort();
    };
  }, []);

  const setZoneId = useCallback((value: number | null) => {
    setSaveSuccess(null);
    setZoneIdState(value);
  }, []);

  const save = useCallback(async () => {
    if (saveInProgress || !isDirty) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      await saveAccountSettings(toSettingsSaveReq(zoneId));
      setInitialZoneId(zoneId);
      setSaveSuccess('Налаштування збережено');
    } catch (error) {
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }, [isDirty, saveInProgress, zoneId]);

  return {
    zoneOptions,
    selectedZone,
    loadInProgress,
    loadError,
    saveError,
    saveSuccess,
    saveInProgress,
    versionText,
    featureMyAdminGroupsEdit,
    audioTranscriptionEnabled,
    showClassicDuty,
    showClassicAnalysis,
    userRoles,
    isDirty,
    setZoneId,
    save,
  };
}

export const useGlobalSettings = useGlobalSetting;
