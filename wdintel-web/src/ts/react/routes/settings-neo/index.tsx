import { Autocomplete, Box, Card, CircularProgress, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, SyntheticEvent } from 'react';

import { SettingsSaveReq, SigintZone } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { isUnauthorizedError } from '../../services/api/client';
import { fetchServerInfo } from '../../services/api/server-info';
import { fetchCurrentUser, saveUserSettings as saveAccountSettings } from '../../services/api/user';
import { fetchUserSettings, saveUserSettings as saveUserDutySettings } from '../../services/api/user-settings';
import { listSigintZones } from '../../services/api/zones';
import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from '../rer-duty-neo/utils';
import { SettingsDutySection } from './SettingsDutySection';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';
import { PowerAlert } from '../../components/PowerAlert';
import { SettingsReportsSection } from './SettingsReportsSection';

type ZonePair = [number, SigintZone];
type ZoneOption = { id: number; label: string };

export type SettingsSection = 'general' | 'duty' | 'analysis' | 'reports';

type SettingsNeoPageProps = {
  section?: SettingsSection;
};

const SETTINGS_SECTION_QUERY_PARAM = 'section';

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function toSettingsSaveReq(sigintZoneId: number | null): SettingsSaveReq {
  return { sigintZoneId };
}

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === 'duty' || section === 'analysis' || section === 'reports') return section;
  return 'general';
}

function readSettingsSectionFromUrl(): SettingsSection {
  return parseSettingsSection(new URLSearchParams(window.location.search).get(SETTINGS_SECTION_QUERY_PARAM));
}

function buildSettingsSectionUrl(section: SettingsSection): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SETTINGS_SECTION_QUERY_PARAM, section);
  url.hash = '';
  return url.pathname + url.search + url.hash;
}

export function SettingsNeoPage({ section }: SettingsNeoPageProps = {}) {
  const [zones, setZones] = useState<ZonePair[]>([]);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [initialZoneId, setInitialZoneId] = useState<number | null>(null);
  const [versionText, setVersionText] = useState<string>('невідома версія');
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    parseSettingsSection(section ?? readSettingsSectionFromUrl()),
  );

  const zoneOptions = useMemo<ZoneOption[]>(() => zones.map(([id, zone]) => ({ id, label: zone.name })), [zones]);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [initialTagsLayout, setInitialTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [dutyDisableAutoScroll, setDutyDisableAutoScroll] = useState(false);
  const [initialDutyDisableAutoScroll, setInitialDutyDisableAutoScroll] = useState(false);
  const [dutyPrefsLoadError, setDutyPrefsLoadError] = useState<string | null>(null);
  const [dutySaveError, setDutySaveError] = useState<string | null>(null);
  const [dutySaveSuccess, setDutySaveSuccess] = useState<string | null>(null);
  const dutySavePendingRef = useRef<{ tagsLayout: TagsLayoutVariant; disableAutoScroll: boolean } | null>(null);
  const dutySaveRunningRef = useRef(false);

  const selectedZone = useMemo(() => zoneOptions.find((option) => option.id === zoneId) ?? null, [zoneOptions, zoneId]);

  useEffect(() => {
    if (section == null) return;
    setSettingsSection(parseSettingsSection(section));
  }, [section]);

  useEffect(() => {
    const handlePopState = () => {
      setSettingsSection(readSettingsSectionFromUrl());
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    async function loadPageData() {
      setLoadInProgress(true);
      setLoadError(null);

      try {
        const [zonesData, user, prefsRsp] = await Promise.all([
          listSigintZones(abortController.signal),
          fetchCurrentUser(abortController.signal),
          fetchUserSettings(abortController.signal).catch(() => null),
        ]);

        setZones(zonesData);
        setZoneId(user.sigintZoneId);
        setInitialZoneId(user.sigintZoneId);
        setUserRoles(user.roles ?? []);

        setDutyPrefsLoadError(null);
        if (prefsRsp == null) {
          setDutyPrefsLoadError('Не вдалося завантажити налаштування.');
          setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
          setInitialTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
          setDutyDisableAutoScroll(false);
          setInitialDutyDisableAutoScroll(false);
        } else {
          setTagsLayout(prefsRsp.tagsLayout);
          setInitialTagsLayout(prefsRsp.tagsLayout);
          setDutyDisableAutoScroll(prefsRsp.disableAutoScroll);
          setInitialDutyDisableAutoScroll(prefsRsp.disableAutoScroll);
        }
        try {
          const serverInfo = await fetchServerInfo(abortController.signal);
          if (!abortController.signal.aborted) {
            setVersionText(serverInfo.version || 'невідома версія');
          }
        } catch (_) {
          if (!abortController.signal.aborted) {
            setVersionText('невідома версія');
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isUnauthorizedError(error)) {
          window.location.assign('/login');
          return;
        }
        setLoadError(`Помилка завантаження налаштувань: ${formatErrorMessage(error)}`);
      } finally {
        if (abortController.signal.aborted) return;
        setLoadInProgress(false);
      }
    }

    loadPageData();

    return () => {
      abortController.abort();
    };
  }, []);

  const isDirty = zoneId !== initialZoneId;
  function scheduleDutySave(nextSettings: { tagsLayout: TagsLayoutVariant; disableAutoScroll: boolean }) {
    setDutySaveError(null);
    setDutySaveSuccess(null);
    dutySavePendingRef.current = nextSettings;
    void flushDutySaveQueue();
  }

  async function flushDutySaveQueue() {
    if (dutySaveRunningRef.current) return;
    dutySaveRunningRef.current = true;
    let shouldRetryPendingSave = true;

    try {
      while (dutySavePendingRef.current != null) {
        const nextSettings = dutySavePendingRef.current;
        dutySavePendingRef.current = null;

        try {
          await saveUserDutySettings(nextSettings);
          setInitialTagsLayout(nextSettings.tagsLayout);
          setInitialDutyDisableAutoScroll(nextSettings.disableAutoScroll);
          setDutySaveSuccess('Збережено');
        } catch (error) {
          if (isUnauthorizedError(error)) {
            shouldRetryPendingSave = false;
            window.location.assign('/login');
            return;
          }
          setDutySaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
          break;
        }
      }
    } finally {
      dutySaveRunningRef.current = false;
      // Retry any queued write after a transient failure; a newer payload may have arrived while the failed save was in flight.
      if (shouldRetryPendingSave && dutySavePendingRef.current != null) {
        void flushDutySaveQueue();
      }
    }
  }

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      await saveAccountSettings(toSettingsSaveReq(zoneId));
      setInitialZoneId(zoneId);
      setSaveSuccess('Налаштування збережено');
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign('/login');
        return;
      }
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }

  function handleTabChange(_: SyntheticEvent, value: SettingsSection) {
    if (value === settingsSection) return;

    setSettingsSection(value);
    window.history.pushState(window.history.state, '', buildSettingsSectionUrl(value));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  return (
    <Box className="w-full" sx={{ maxWidth: 980, mx: 'auto' }}>
      <Stack spacing={2} useFlexGap>
        <PageHeader title="Налаштування" titleInfo="Зберігається для вашого облікового запису" />
        <Card
          variant="outlined"
          sx={{ borderRadius: 0, boxShadow: 'none', overflow: 'hidden', backgroundColor: 'background.paper' }}
        >
          <Tabs
            value={settingsSection}
            onChange={handleTabChange}
            variant="scrollable"
            allowScrollButtonsMobile
            sx={{
              minHeight: 48,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
              '& .MuiTab-root': {
                minHeight: 48,
                alignItems: 'center',
                textAlign: 'center',
              },
            }}
          >
            <Tab
              value="general"
              label="ЗАГАЛЬНІ"
              id="settings-neo-tab-general"
              aria-controls="settings-neo-panel-general"
            />
            <Tab
              value="duty"
              label="ОПЕРАТИВНИЙ"
              id="settings-neo-tab-duty"
              aria-controls="settings-neo-panel-duty"
            />
            <Tab
              value="analysis"
              label="АНАЛІЗ"
              id="settings-neo-tab-analysis"
              aria-controls="settings-neo-panel-analysis"
            />
            <Tab
              value="reports"
              label="ЗВІТИ"
              id="settings-neo-tab-reports"
              aria-controls="settings-neo-panel-reports"
            />
          </Tabs>

          {settingsSection === 'general' ? (
            <Box role="tabpanel" id="settings-neo-panel-general" aria-labelledby="settings-neo-tab-general">
              <Box component="form" onSubmit={handleSave} noValidate sx={{ p: 3 }}>
                <Stack spacing={3} sx={{ width: '100%' }}>
                  {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
                  {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
                  {saveSuccess ? (
                    <PowerAlert severity="success" role="status">
                      {saveSuccess}
                    </PowerAlert>
                  ) : null}

                  <Box>
                    <Autocomplete
                      size="small"
                      options={zoneOptions}
                      value={selectedZone}
                      onChange={(_, option) => {
                        setSaveSuccess(null);
                        setZoneId(option?.id ?? null);
                      }}
                      isOptionEqualToValue={(option, value) => option.id === value.id}
                      getOptionLabel={(option) => option.label}
                      clearText="Очистити"
                      noOptionsText="Немає варіантів"
                      loading={loadInProgress}
                      loadingText="Завантаження..."
                      renderOption={(props, option) => {
                        const { key: _unusedKey, ...optionProps } = props;
                        return (
                          <Box component="li" {...optionProps} key={option.id}>
                            {option.label}
                          </Box>
                        );
                      }}
                      sx={{
                        width: { xs: '100%', sm: '420px' },
                        maxWidth: '100%',
                        '& .MuiOutlinedInput-root': {
                          backgroundColor: 'var(--bs-body-bg)',
                        },
                        '& .MuiAutocomplete-clearIndicator': {
                          visibility: 'visible',
                          opacity: 1,
                        },
                      }}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="settings-zone"
                          name="settings-zone"
                          label="РЕР-напрямок"
                          placeholder="Оберіть зону"
                          helperText="Оберіть зону РЕР-напрямку для вашого облікового запису"
                        />
                      )}
                    />
                  </Box>

                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: { xs: 'flex-start', sm: 'center' },
                      justifyContent: 'space-between',
                      gap: 2,
                      flexWrap: 'wrap',
                      pt: 2,
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      Версія: {versionText}
                    </Typography>
                    <PowerButton
                      variant="contained"
                      type="submit"
                      disabled={saveInProgress || !isDirty}
                      startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                      sx={{ fontWeight: 500 }}
                    >
                      зберегти
                    </PowerButton>
                  </Box>
                </Stack>
              </Box>
            </Box>
          ) : null}

          {settingsSection === 'duty' ? (
            <SettingsDutySection
              loadInProgress={loadInProgress}
              prefsLoadError={dutyPrefsLoadError}
              saveError={dutySaveError}
              saveSuccess={dutySaveSuccess}
              tagsLayout={tagsLayout}
              onTagsLayoutChange={(layout) => {
                setTagsLayout(layout);
                scheduleDutySave({ tagsLayout: layout, disableAutoScroll: dutyDisableAutoScroll });
              }}
              disableAutoScroll={dutyDisableAutoScroll}
              onDisableAutoScrollChange={(value) => {
                setDutyDisableAutoScroll(value);
                scheduleDutySave({ tagsLayout, disableAutoScroll: value });
              }}
            />
          ) : null}

          {settingsSection === 'analysis' ? (
            <Box
              id="settings-neo-panel-analysis"
              role="tabpanel"
              aria-labelledby="settings-neo-tab-analysis"
            >
              <Box sx={{ p: 3 }}>
                <Stack spacing={3} sx={{ maxWidth: 960 }}>
                  <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
                    Аналіз
                  </Typography>
                  <SettingsSharedTagsLayoutCard
                    tagsLayout={tagsLayout}
                    onTagsLayoutChange={(layout) => {
                      setTagsLayout(layout);
                      scheduleDutySave({ tagsLayout: layout, disableAutoScroll: dutyDisableAutoScroll });
                    }}
                    loadInProgress={loadInProgress}
                  />
                </Stack>
              </Box>
            </Box>
          ) : null}

          {settingsSection === 'reports' ? (
            <SettingsReportsSection
              active={settingsSection === 'reports'}
              userRoles={userRoles}
              rolesLoading={loadInProgress}
            />
          ) : null}
        </Card>
      </Stack>
    </Box>
  );
}
