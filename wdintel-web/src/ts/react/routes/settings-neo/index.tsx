import { Box, Card, FormControlLabel, Stack, Switch, Tab, Tabs, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { MyAdminSignalGroup } from '../../../../Bindings';
import { isNullOrUndefined } from '../../utils/misc';

import { PageHeader } from '../../components/PageHeader';
import { SettingsMyGroupsSection } from './SettingsMyGroupsSection';
import { SettingsDutySection } from './SettingsDutySection';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';
import { SettingsMyReportsSection } from './SettingsMyReportsSection';
import { useGlobalSetting } from './use-global-settings';
import { useDutySettings } from '../../hooks/use-duty-settings';
import { listMyAdminGroups } from '../../services/api/zones';

export type SettingsSection = 'general' | 'myGroups' | 'duty' | 'analysis' | 'myReports';

type SettingsNeoPageProps = {
  section?: string;
};

const SETTINGS_SECTION_QUERY_PARAM = 'section';

function serializeSettingsSection(section: SettingsSection): string {
  if (section === 'myGroups') return 'my-groups';
  if (section === 'myReports') return 'my-reports';
  return section;
}

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === 'my-groups') {
    return 'myGroups';
  }
  if (section === 'my-reports') {
    return 'myReports';
  }
  if (section === 'duty' || section === 'analysis') {
    return section;
  }
  return 'myGroups';
}

function readSettingsSectionFromUrl(): SettingsSection {
  return parseSettingsSection(new URLSearchParams(window.location.search).get(SETTINGS_SECTION_QUERY_PARAM));
}

function buildSettingsSectionUrl(section: SettingsSection): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SETTINGS_SECTION_QUERY_PARAM, serializeSettingsSection(section));
  url.hash = '';
  return url.pathname + url.search + url.hash;
}

function renderMyReportsTabLabel() {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}>
      <span>Мої звіти</span>
      <Box
        component="span"
        sx={(theme) => ({
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 0.5,
          py: 0.15,
          borderRadius: 9999,
          border: 1,
          borderColor: theme.palette.mode === 'dark' ? 'var(--ochre-normal)' : '#d28b1d',
          bgcolor: theme.palette.mode === 'dark' ? 'var(--ochre-dark)' : '#f0c97a',
          color: theme.palette.mode === 'dark' ? 'var(--ochre-light)' : '#8a4f00',
          fontSize: '0.65rem',
          fontWeight: 600,
          lineHeight: 1,
          minHeight: 22,
        })}
      >
        BETA
      </Box>
    </Box>
  );
}

export function SettingsNeoPage({ section }: SettingsNeoPageProps = {}) {
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    parseSettingsSection(section ?? readSettingsSectionFromUrl()),
  );

  const dutySettings = useDutySettings();
  const globalSettings = useGlobalSetting();
  const [myGroupsStatus, setMyGroupsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [myGroups, setMyGroups] = useState<MyAdminSignalGroup[]>([]);
  const [myGroupsError, setMyGroupsError] = useState<string | null>(null);

  useEffect(() => {
    if (isNullOrUndefined(section)) return;
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
    setMyGroupsStatus('loading');
    setMyGroupsError(null);

    void listMyAdminGroups(abortController.signal)
      .then((rsp) => {
        if (abortController.signal.aborted) return;
        setMyGroups(rsp.groups);
        setMyGroupsStatus('success');
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setMyGroups([]);
        setMyGroupsStatus('error');
        setMyGroupsError(`Помилка завантаження груп: ${error instanceof Error ? error.message : 'невідома помилка'}`);
      });

    return () => {
      abortController.abort();
    };
  }, []);

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
              value="myGroups"
              label="Мої групи"
              id="settings-neo-tab-my-groups"
              aria-controls="settings-neo-panel-my-groups"
            />
            <Tab
              value="duty"
              label="Оперативний"
              id="settings-neo-tab-duty"
              aria-controls="settings-neo-panel-duty"
            />
            <Tab
              value="analysis"
              label="Аналіз"
              id="settings-neo-tab-analysis"
              aria-controls="settings-neo-panel-analysis"
            />
            <Tab
              value="myReports"
              label={renderMyReportsTabLabel()}
              id="settings-neo-tab-my-reports"
              aria-controls="settings-neo-panel-my-reports"
            />
          </Tabs>

          {settingsSection === 'myGroups' ? (
            <SettingsMyGroupsSection
              status={myGroupsStatus}
              groups={myGroups}
              error={myGroupsError}
            />
          ) : null}

          {settingsSection === 'duty' ? (
            <SettingsDutySection
              loadInProgress={globalSettings.loadInProgress || dutySettings.loadInProgress}
              prefsLoadError={dutySettings.loadError}
              saveError={dutySettings.saveError}
              tagsLayout={dutySettings.tagsLayout}
              onTagsLayoutChange={(layout) => {
                dutySettings.setTagsLayout(layout);
                dutySettings.scheduleSave({
                  tagsLayout: layout,
                  disableAutoScroll: dutySettings.disableAutoScroll,
                  analysisMapInSidebar: dutySettings.analysisMapInSidebar,
                });
              }}
              disableAutoScroll={dutySettings.disableAutoScroll}
              onDisableAutoScrollChange={(value) => {
                dutySettings.setDisableAutoScroll(value);
                dutySettings.scheduleSave({
                  tagsLayout: dutySettings.tagsLayout,
                  disableAutoScroll: value,
                  analysisMapInSidebar: dutySettings.analysisMapInSidebar,
                });
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
                    tagsLayout={dutySettings.tagsLayout}
                    onTagsLayoutChange={(layout) => {
                      dutySettings.setTagsLayout(layout);
                      dutySettings.scheduleSave({
                        tagsLayout: layout,
                        disableAutoScroll: dutySettings.disableAutoScroll,
                        analysisMapInSidebar: dutySettings.analysisMapInSidebar,
                      });
                    }}
                    loadInProgress={globalSettings.loadInProgress || dutySettings.loadInProgress}
                  />
                  <Box
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 2,
                      bgcolor: 'background.paper',
                      p: { xs: 2, sm: 2.5 },
                    }}
                  >
                    <Stack spacing={1.5}>
                      <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
                        Мапа
                      </Typography>
                      <FormControlLabel
                        sx={{
                          alignItems: 'flex-start',
                          m: 0,
                          gap: 1.5,
                          '& .MuiFormControlLabel-label': { width: '100%' },
                        }}
                        control={
                          <Switch
                            checked={dutySettings.analysisMapInSidebar}
                            onChange={(_, checked) => {
                              dutySettings.setAnalysisMapInSidebar(checked);
                              dutySettings.scheduleSave({
                                tagsLayout: dutySettings.tagsLayout,
                                disableAutoScroll: dutySettings.disableAutoScroll,
                                analysisMapInSidebar: checked,
                              });
                            }}
                            disabled={globalSettings.loadInProgress || dutySettings.loadInProgress}
                          />
                        }
                        label={
                          <Stack spacing={0.75} sx={{ pt: 0.25 }}>
                            <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                              Мапа в бічній панелі
                            </Typography>
                            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                              Дозволяє одночасно переглядати мапу та повідомлення.
                            </Typography>
                          </Stack>
                        }
                      />
                    </Stack>
                  </Box>
                </Stack>
              </Box>
            </Box>
          ) : null}

          {settingsSection === 'myReports' ? (
            <SettingsMyReportsSection active={settingsSection === 'myReports'} />
          ) : null}

        </Card>
      </Stack>
    </Box>
  );
}
