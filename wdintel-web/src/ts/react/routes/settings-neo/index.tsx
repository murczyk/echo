import { Autocomplete, Box, Card, CircularProgress, FormControlLabel, Stack, Switch, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { MyAdminSignalGroup } from '../../../../Bindings';
import { ELLIPSIS, isNullOrUndefined } from '../../utils/misc';

import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { SettingsDutySection } from './SettingsDutySection';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';
import { PowerAlert } from '../../components/PowerAlert';
import { SettingsReportsSection } from './SettingsReportsSection';
import { useGlobalSetting } from './use-global-settings';
import { useDutySettings } from '../../hooks/use-duty-settings';
import { listMyAdminGroups } from '../../services/api/zones';

export type SettingsSection = 'general' | 'myGroups' | 'duty' | 'analysis' | 'reports';

type SettingsNeoPageProps = {
  section?: SettingsSection;
};

const SETTINGS_SECTION_QUERY_PARAM = 'section';

function parseSettingsSection(section: string | null | undefined): SettingsSection {
  if (section === 'myGroups' || section === 'my-groups') {
    return 'myGroups';
  }
  if (section === 'duty' || section === 'analysis' || section === 'reports') {
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

function formatOptionalText(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

function formatAors(group: MyAdminSignalGroup): string {
  const aors = group.areasOfResponsibility ?? [];
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function formatAllowedUsers(group: MyAdminSignalGroup): string {
  if (!group.isGroupSecret) return 'без обмежень';
  if (group.allowedUsers.length === 0) return '—';
  return group.allowedUsers.join(', ');
}

function SettingsMyGroupsSection(props: {
  status: 'idle' | 'loading' | 'success' | 'error';
  groups: MyAdminSignalGroup[];
  error: string | null;
}) {
  return (
    <Box role="tabpanel" id="settings-neo-panel-my-groups" aria-labelledby="settings-neo-tab-my-groups">
      <Box sx={{ p: 3 }}>
        <Stack spacing={3}>
          <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
            Мої групи
          </Typography>

          <PowerAlert severity="info">
            Для того щоби додати вашу приватну групу, додайте в неї телефон бота, написаний в описі групи підтримки, і напишіть адміністраторам повідомлення у форматі:
            <br />
            1. Додано групу МОЯ_ГРУПА (WhatsApp), зробіть мене (DeltaUser) адміном та групу приватною, видиму користувачам Delta1, Delta2, Delta3
            <br />
            2. Додано групу МОЯ_ГРУПА (Signal), зробіть мене (DeltaUser) адміном та групу публічною, на смугу 99АК
          </PowerAlert>

          {props.error ? <PowerAlert severity="error">{props.error}</PowerAlert> : null}

          {props.status === 'loading' ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Завантаження груп{ELLIPSIS}
              </Typography>
            </Box>
          ) : null}

          {props.status === 'success' ? (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Група</TableCell>
                    <TableCell>Джерело</TableCell>
                    <TableCell>Смуги</TableCell>
                    <TableCell>Приватність</TableCell>
                    <TableCell>Логіни приватної групи</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {props.groups.map((group) => (
                    <TableRow key={group.masterKey}>
                      <TableCell>{group.name || group.masterKey.slice(-5)}</TableCell>
                      <TableCell>{formatOptionalText(group.datasourceName ?? group.datasourceKind)}</TableCell>
                      <TableCell>{formatAors(group)}</TableCell>
                      <TableCell>{group.isGroupSecret ? 'приватна' : 'публічна'}</TableCell>
                      <TableCell>{formatAllowedUsers(group)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </Stack>
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
  const hasMyGroups = myGroups.length > 0;
  const showMyGroupsTab = hasMyGroups || myGroupsStatus === 'loading' || settingsSection === 'myGroups';

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
              value="general"
              label="Загальні"
              id="settings-neo-tab-general"
              aria-controls="settings-neo-panel-general"
            />
            {showMyGroupsTab ? (
              <Tab
                value="myGroups"
                label="Мої групи"
                id="settings-neo-tab-my-groups"
                aria-controls="settings-neo-panel-my-groups"
              />
            ) : null}
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
              value="reports"
              label="Звіти"
              id="settings-neo-tab-reports"
              aria-controls="settings-neo-panel-reports"
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
                      loadingText={`Завантаження${ELLIPSIS}`}
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

          {settingsSection === 'reports' ? (
            <SettingsReportsSection
              active={settingsSection === 'reports'}
              userRoles={globalSettings.userRoles}
              rolesLoading={globalSettings.loadInProgress}
            />
          ) : null}

        </Card>
      </Stack>
    </Box>
  );
}
