import { Autocomplete, Box, Card, CircularProgress, FormControlLabel, Stack, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { SettingsDutySection } from './SettingsDutySection';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';
import { PowerAlert } from '../../components/PowerAlert';
import { SettingsReportsSection } from './SettingsReportsSection';
import { SettingsKeywordSetsSection } from './SettingsKeywordSetsSection';
import { useGlobalSetting } from './use-global-settings';
import { useDutySettings } from '../../hooks/use-duty-settings';

export type SettingsSection = 'general' | 'duty' | 'analysis' | 'reports' | 'keywords';

type SettingsNeoPageProps = {
  section?: SettingsSection;
};

const SETTINGS_SECTION_QUERY_PARAM = 'section';

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === 'duty' || section === 'analysis' || section === 'reports' || section === 'keywords') {
    return section;
  }
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    parseSettingsSection(section ?? readSettingsSectionFromUrl()),
  );

  const dutySettings = useDutySettings();
  const globalSettings = useGlobalSetting();

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
            <Tab
              value="keywords"
              label="КЛЮЧОВІ СЛОВА"
              id="settings-neo-tab-keywords"
              aria-controls="settings-neo-panel-keywords"
            />
          </Tabs>

          {settingsSection === 'general' ? (
            <Box role="tabpanel" id="settings-neo-panel-general" aria-labelledby="settings-neo-tab-general">
              <Box component="form" onSubmit={(event) => { event.preventDefault(); void globalSettings.save(); }} noValidate sx={{ p: 3 }}>
                <Stack spacing={3} sx={{ width: '100%' }}>
                  <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
                    Загальні
                  </Typography>
                  {globalSettings.loadError ? <PowerAlert severity="error">{globalSettings.loadError}</PowerAlert> : null}
                  {globalSettings.saveError ? <PowerAlert severity="error">{globalSettings.saveError}</PowerAlert> : null}
                  {globalSettings.saveSuccess ? (
                    <PowerAlert severity="success" role="status">
                      {globalSettings.saveSuccess}
                    </PowerAlert>
                  ) : null}

                  <Box>
                    <Autocomplete
                      size="small"
                      options={globalSettings.zoneOptions}
                      value={globalSettings.selectedZone}
                      onChange={(_, option) => {
                        globalSettings.setZoneId(option?.id ?? null);
                      }}
                      isOptionEqualToValue={(option, value) => option.id === value.id}
                      getOptionLabel={(option) => option.label}
                      clearText="Очистити"
                      noOptionsText="Немає варіантів"
                      loading={globalSettings.loadInProgress}
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
                      Версія: {globalSettings.versionText}
                    </Typography>
                    <PowerButton
                      variant="contained"
                      type="submit"
                      disabled={globalSettings.saveInProgress || !globalSettings.isDirty}
                      startIcon={globalSettings.saveInProgress ? <CircularProgress size={18} /> : undefined}
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

          {settingsSection === 'reports' ? (
            <SettingsReportsSection
              active={settingsSection === 'reports'}
              userRoles={globalSettings.userRoles}
              rolesLoading={globalSettings.loadInProgress}
            />
          ) : null}

          {settingsSection === 'keywords' ? <SettingsKeywordSetsSection /> : null}
        </Card>
      </Stack>
    </Box>
  );
}
