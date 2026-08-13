import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, Card, FormControlLabel, Stack, Switch, Tab, Tabs, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { MyAdminSignalGroup } from '../../../../Bindings';
import { isNullOrUndefined } from '../../utils/misc';

import { PageHeader } from '../../components/PageHeader';
import { SettingsMyGroupsSection } from './SettingsMyGroupsSection';
import { SettingsMyOrganismSection } from './SettingsMyOrganismSection';
import { SettingsDutySection } from './SettingsDutySection';
import { SettingsAudioTranscriptionCard } from './SettingsAudioTranscriptionCard';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';
import { useGlobalSetting } from './use-global-settings';
import { useDutySettings } from '../../hooks/use-duty-settings';
import type { UserDutySettings } from '../../services/api/user-settings';
import { listMyAdminGroups } from '../../services/api/zones';

export type SettingsSection =
  'general' | 'myGroups' | 'myOrganism' | 'duty' | 'analysis' | 'myReports';

type SettingsNeoPageProps = {
  section?: string;
};

const SETTINGS_SECTION_QUERY_PARAM = 'section';
const MY_REPORTS_PATH = '/my-reports';

function serializeSettingsSection(section: SettingsSection): string {
  if (section === 'myGroups') return 'my-groups';
  if (section === 'myOrganism') return 'my-organism';
  if (section === 'myReports') return 'my-reports';
  return section;
}

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === 'my-groups') {
    return 'myGroups';
  }
  if (section === 'my-organism') {
    return 'myOrganism';
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
  return parseSettingsSection(
    new URLSearchParams(window.location.search).get(SETTINGS_SECTION_QUERY_PARAM),
  );
}

function buildSettingsSectionUrl(section: SettingsSection): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SETTINGS_SECTION_QUERY_PARAM, serializeSettingsSection(section));
  url.hash = '';
  return url.pathname + url.search + url.hash;
}

function navigateToMyReports(replace = false) {
  if (replace) {
    window.history.replaceState(window.history.state, '', MY_REPORTS_PATH);
  } else {
    window.history.pushState(window.history.state, '', MY_REPORTS_PATH);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function renderMyReportsTabLabel() {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}
    >
      <span>Мої звіти</span>
      <OpenInNewIcon sx={{ fontSize: 16 }} aria-hidden="true" />
    </Box>
  );
}

export function SettingsNeoPage({ section }: SettingsNeoPageProps = {}) {
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    parseSettingsSection(section ?? readSettingsSectionFromUrl()),
  );

  const dutySettings = useDutySettings();
  const scheduleDutySettingsSave = (overrides: Partial<UserDutySettings>) => {
    dutySettings.scheduleSave({
      tagsLayout: dutySettings.tagsLayout,
      disableAutoScroll: dutySettings.disableAutoScroll,
      analysisMapInSidebar: dutySettings.analysisMapInSidebar,
      dutyAudioTranscriptionCollapsed: dutySettings.dutyAudioTranscriptionCollapsed,
      analysisAudioTranscriptionCollapsed: dutySettings.analysisAudioTranscriptionCollapsed,
      showAnalysisCallsignAddForm: dutySettings.showAnalysisCallsignAddForm,
      showClassicDuty: dutySettings.showClassicDuty,
      showClassicAnalysis: dutySettings.showClassicAnalysis,
      dutyCollapseMediaPreviews: dutySettings.dutyCollapseMediaPreviews,
      ...overrides,
    });
  };
  const globalSettings = useGlobalSetting();
  const [myGroupsStatus, setMyGroupsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [myGroups, setMyGroups] = useState<MyAdminSignalGroup[]>([]);
  const [myGroupsError, setMyGroupsError] = useState<string | null>(null);

  const loadMyGroups = useCallback(async (signal?: AbortSignal) => {
    setMyGroupsStatus('loading');
    setMyGroupsError(null);

    try {
      const rsp = await listMyAdminGroups(signal);
      if (signal?.aborted) return;
      setMyGroups(rsp.groups);
      setMyGroupsStatus('success');
    } catch (error) {
      if (signal?.aborted) return;
      setMyGroups([]);
      setMyGroupsStatus('error');
      setMyGroupsError(
        `Помилка завантаження груп: ${error instanceof Error ? error.message : 'невідома помилка'}`,
      );
    }
  }, []);

  useEffect(() => {
    if (isNullOrUndefined(section)) return;
    const nextSection = parseSettingsSection(section);
    if (nextSection === 'myReports') {
      navigateToMyReports(true);
      return;
    }
    setSettingsSection(nextSection);
  }, [section]);

  useEffect(() => {
    if (settingsSection === 'myReports') {
      navigateToMyReports(true);
    }
  }, [settingsSection]);

  useEffect(() => {
    const handlePopState = () => {
      const nextSection = readSettingsSectionFromUrl();
      if (nextSection === 'myReports') {
        navigateToMyReports(true);
        return;
      }
      setSettingsSection(nextSection);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    void loadMyGroups(abortController.signal);

    return () => {
      abortController.abort();
    };
  }, [loadMyGroups]);

  function handleTabChange(_: SyntheticEvent, value: SettingsSection) {
    if (value === settingsSection) return;

    if (value === 'myReports') {
      navigateToMyReports();
      return;
    }

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
          sx={{
            borderRadius: 0,
            boxShadow: 'none',
            overflow: 'hidden',
            backgroundColor: 'background.paper',
          }}
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
              value="myOrganism"
              label="Мій організм"
              id="settings-neo-tab-my-organism"
              aria-controls="settings-neo-panel-my-organism"
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
            />
          </Tabs>

          {settingsSection === 'myGroups' ? (
            <SettingsMyGroupsSection
              status={myGroupsStatus}
              groups={myGroups}
              error={myGroupsError}
              enableEditActions={globalSettings.featureMyAdminGroupsEdit}
              onGroupsChanged={() => loadMyGroups()}
            />
          ) : null}

          {settingsSection === 'myOrganism' ? <SettingsMyOrganismSection /> : null}

          {settingsSection === 'duty' ? (
            <SettingsDutySection
              loadInProgress={globalSettings.loadInProgress || dutySettings.loadInProgress}
              prefsLoadError={dutySettings.loadError}
              saveError={dutySettings.saveError}
              tagsLayout={dutySettings.tagsLayout}
              onTagsLayoutChange={(layout) => {
                dutySettings.setTagsLayout(layout);
                scheduleDutySettingsSave({ tagsLayout: layout });
              }}
              disableAutoScroll={dutySettings.disableAutoScroll}
              onDisableAutoScrollChange={(value) => {
                dutySettings.setDisableAutoScroll(value);
                scheduleDutySettingsSave({ disableAutoScroll: value });
              }}
              audioTranscriptionCollapsed={dutySettings.dutyAudioTranscriptionCollapsed}
              showAudioTranscriptionSettings={globalSettings.audioTranscriptionEnabled}
              showClassicDutySetting={!globalSettings.showClassicDuty}
              showClassicDuty={dutySettings.showClassicDuty}
              onShowClassicDutyChange={(value) => {
                dutySettings.setShowClassicDuty(value);
                scheduleDutySettingsSave({ showClassicDuty: value });
              }}
              onAudioTranscriptionCollapsedChange={(value) => {
                dutySettings.setDutyAudioTranscriptionCollapsed(value);
                scheduleDutySettingsSave({ dutyAudioTranscriptionCollapsed: value });
              }}
              collapseMediaPreviews={dutySettings.dutyCollapseMediaPreviews}
              onCollapseMediaPreviewsChange={(value) => {
                dutySettings.setDutyCollapseMediaPreviews(value);
                scheduleDutySettingsSave({ dutyCollapseMediaPreviews: value });
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
                  <Typography
                    component="h2"
                    variant="h6"
                    sx={{ fontWeight: 700, lineHeight: 1.25 }}
                  >
                    Аналіз
                  </Typography>
                  <SettingsSharedTagsLayoutCard
                    tagsLayout={dutySettings.tagsLayout}
                    onTagsLayoutChange={(layout) => {
                      dutySettings.setTagsLayout(layout);
                      scheduleDutySettingsSave({ tagsLayout: layout });
                    }}
                    loadInProgress={globalSettings.loadInProgress || dutySettings.loadInProgress}
                  />
                  {!globalSettings.showClassicAnalysis ? (
                    <Box
                      sx={{
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 2,
                        bgcolor: 'background.paper',
                        p: { xs: 2, sm: 2.5 },
                      }}
                    >
                      <FormControlLabel
                        sx={{ m: 0 }}
                        control={
                          <Switch
                            checked={dutySettings.showClassicAnalysis}
                            onChange={(_, checked) => {
                              dutySettings.setShowClassicAnalysis(checked);
                              scheduleDutySettingsSave({ showClassicAnalysis: checked });
                            }}
                            disabled={globalSettings.loadInProgress || dutySettings.loadInProgress}
                          />
                        }
                        label="Показувати класичний аналіз"
                      />
                    </Box>
                  ) : null}
                  {globalSettings.audioTranscriptionEnabled ? (
                    <SettingsAudioTranscriptionCard
                      collapsedByDefault={dutySettings.analysisAudioTranscriptionCollapsed}
                      loadInProgress={globalSettings.loadInProgress || dutySettings.loadInProgress}
                      onCollapsedByDefaultChange={(value) => {
                        dutySettings.setAnalysisAudioTranscriptionCollapsed(value);
                        scheduleDutySettingsSave({ analysisAudioTranscriptionCollapsed: value });
                      }}
                    />
                  ) : null}
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
                      <Typography
                        variant="overline"
                        sx={{ color: 'text.secondary', letterSpacing: 0.8 }}
                      >
                        Позивні
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
                            checked={dutySettings.showAnalysisCallsignAddForm}
                            onChange={(_, checked) => {
                              dutySettings.setShowAnalysisCallsignAddForm(checked);
                              scheduleDutySettingsSave({
                                showAnalysisCallsignAddForm: checked,
                              });
                            }}
                            disabled={globalSettings.loadInProgress || dutySettings.loadInProgress}
                          />
                        }
                        label={
                          <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                            Відображати форму додавання позивного
                          </Typography>
                        }
                      />
                    </Stack>
                  </Box>
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
                      <Typography
                        variant="overline"
                        sx={{ color: 'text.secondary', letterSpacing: 0.8 }}
                      >
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
                              scheduleDutySettingsSave({ analysisMapInSidebar: checked });
                            }}
                            disabled={globalSettings.loadInProgress || dutySettings.loadInProgress}
                          />
                        }
                        label={
                          <Stack spacing={0.75} sx={{ pt: 0.25 }}>
                            <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                              Мапа в бічній панелі
                            </Typography>
                            <Typography
                              variant="body2"
                              sx={{ color: 'text.secondary', lineHeight: 1.6 }}
                            >
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
        </Card>
      </Stack>
    </Box>
  );
}
