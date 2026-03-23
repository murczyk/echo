import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Autocomplete,
  Box,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { SettingsSaveReq, SigintZone } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { isUnauthorizedError } from '../../services/api/client';
import { fetchServerInfo } from '../../services/api/server-info';
import { fetchCurrentUser, saveUserSettings } from '../../services/api/user';
import { listSigintZones } from '../../services/api/zones';

type ZonePair = [number, SigintZone];
type ZoneOption = { id: number; label: string };

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function toSettingsSaveReq(sigintZoneId: number | null): SettingsSaveReq {
  return { sigintZoneId };
}

export function SettingsNeoPage() {
  const [zones, setZones] = useState<ZonePair[]>([]);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [initialZoneId, setInitialZoneId] = useState<number | null>(null);
  const [versionText, setVersionText] = useState<string>('невідома версія');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [settingsTab, setSettingsTab] = useState(0);

  const zoneOptions = useMemo<ZoneOption[]>(
    () => zones.map(([id, zone]) => ({ id, label: zone.name })),
    [zones],
  );

  const selectedZone = useMemo(
    () => zoneOptions.find((option) => option.id === zoneId) ?? null,
    [zoneOptions, zoneId],
  );

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

        setZones(zonesData);
        setZoneId(user.sigintZoneId);
        setInitialZoneId(user.sigintZoneId);
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

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      await saveUserSettings(toSettingsSaveReq(zoneId));
      setInitialZoneId(zoneId);
      setSaveSuccess('Налаштування збережено.');
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

  return (
    <Box className="w-full" sx={{ height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: '100%' }}>
        <PageHeader title="налаштування" className="px-4" />

        <div className="bg-[var(--card-color)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden">
          <Tabs
            value={settingsTab}
            onChange={(_, value: number) => setSettingsTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{
              px: 2,
              pt: 1,
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: 'var(--color-bg-inactive)',
              '& .MuiTab-root': {
                textTransform: 'none',
                fontSize: '1.75rem',
                lineHeight: 1.35,
                fontWeight: 600,
                minHeight: 52,
                py: 1.5,
                color: 'text.secondary',
              },
              '& .MuiTab-root.Mui-selected': {
                color: 'text.primary',
              },
            }}
          >
            <Tab label="Основні" id="settings-neo-tab-main" aria-controls="settings-neo-panel-main" />
            <Tab label="Оперативний" id="settings-neo-tab-duty" aria-controls="settings-neo-panel-duty" />
          </Tabs>

          {settingsTab === 0 ? (
            <div role="tabpanel" id="settings-neo-panel-main" aria-labelledby="settings-neo-tab-main">
              <Box component="form" onSubmit={handleSave} noValidate className="p-6">
                <Stack spacing={3}>
                  {loadError ? <Alert severity="error">{loadError}</Alert> : null}
                  {saveError ? <Alert severity="error">{saveError}</Alert> : null}
                  {saveSuccess ? (
                    <Alert severity="success" role="status">
                      {saveSuccess}
                    </Alert>
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

                  <Box className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
                    <Typography variant="caption" color="text.secondary">
                      Версія: {versionText}
                    </Typography>
                    <Button
                      variant="contained"
                      type="submit"
                      disabled={saveInProgress || !isDirty}
                      startIcon={saveInProgress ? <CircularProgress size={18} /> : <SaveIcon fontSize="small" />}
                      sx={{ fontWeight: 500 }}
                    >
                      зберегти
                    </Button>
                  </Box>
                </Stack>
              </Box>
            </div>
          ) : (
            <div className="p-6" id="settings-neo-panel-duty" role="tabpanel" aria-labelledby="settings-neo-tab-duty">
              <Typography variant="body2" color="text.secondary">
                Налаштування оперативного режиму з’являться тут.
              </Typography>
            </div>
          )}
        </div>
      </Stack>
    </Box>
  );
}
