import LogoutIcon from '@mui/icons-material/Logout';
import SaveIcon from '@mui/icons-material/Save';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import {
  Alert,
  Autocomplete,
  Box,
  CircularProgress,
  Link,
  Stack,
  TextField,
  Typography,
  Button as MuiButton,
} from '@mui/material';
import React from 'react';

import { SettingsSaveReq, SigintZone } from '../../../../Bindings';
import { Button } from '../../components/mui-customized/button';
import { isUnauthorizedError } from '../../services/api/client';
import { fetchServerInfo } from '../../services/api/server-info';
import { fetchCurrentUser, logoutCurrentUser, saveUserSettings } from '../../services/api/user';
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
  const [zones, setZones] = React.useState<ZonePair[]>([]);
  const [zoneId, setZoneId] = React.useState<number | null>(null);
  const [initialZoneId, setInitialZoneId] = React.useState<number | null>(null);
  const [userName, setUserName] = React.useState<string>('');
  const [versionText, setVersionText] = React.useState<string>('невідома версія');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadInProgress, setLoadInProgress] = React.useState(true);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = React.useState(false);
  const [logoutInProgress, setLogoutInProgress] = React.useState(false);

  const zoneOptions = React.useMemo<ZoneOption[]>(
    () => zones.map(([id, zone]) => ({ id, label: zone.name })),
    [zones],
  );

  const selectedZone = React.useMemo(
    () => zoneOptions.find((option) => option.id === zoneId) ?? null,
    [zoneOptions, zoneId],
  );

  React.useEffect(() => {
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
        setUserName(user.name);
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
  const zoneFieldError = zoneId === null && isDirty;

  async function handleSave(event?: React.FormEvent) {
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

  async function handleLogout() {
    if (logoutInProgress) return;

    setLogoutInProgress(true);

    try {
      await logoutCurrentUser();
    } catch (_) {
      // Preserve current Elm behavior: navigate to login even if logout request fails.
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <div className="w-full">
      <div className="mb-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="py-4 text-[var(--text-color)]">налаштування</h1>
          <div className="flex items-center gap-4 text-sm">
            <MuiButton
              component={Link}
              href="https://signal.me/#p/+380502711438"
              target="_blank"
              rel="noreferrer"
              variant="text"
              startIcon={<SupportAgentIcon fontSize="small" />}
              sx={{ textTransform: 'none' }}
            >
              підтримка
            </MuiButton>
            <MuiButton
              onClick={handleLogout}
              disabled={logoutInProgress}
              variant="text"
              color="error"
              startIcon={<LogoutIcon fontSize="small" />}
              sx={{ textTransform: 'none' }}
            >
              {userName ? `вийти (${userName})` : 'вийти'}
            </MuiButton>
          </div>
        </div>
      </div>

      <div className="bg-[var(--card-color)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--border-color)] bg-[var(--color-bg-inactive)]">
          <Typography
            component="h2"
            sx={{ m: 0, fontSize: '1.75rem', lineHeight: 1.35, fontWeight: 600, color: 'text.primary' }}
          >
            Основні налаштування
          </Typography>
        </div>

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
                    required
                    error={Boolean(zoneFieldError)}
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
                disabled={saveInProgress || logoutInProgress || !isDirty || zoneFieldError}
                startIcon={saveInProgress ? <CircularProgress size={18} /> : <SaveIcon fontSize="small" />}
                sx={{ textTransform: 'none', fontWeight: 500 }}
              >
                зберегти
              </Button>
            </Box>
          </Stack>
        </Box>
      </div>
    </div>
  );
}
