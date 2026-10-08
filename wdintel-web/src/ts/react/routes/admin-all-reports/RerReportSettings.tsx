import {
  Autocomplete,
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { Login, RerReportMetadataItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { listLogins } from '../../services/api/logins';
import {
  getRerReportAccessList,
  listRerReportMetadata,
  replaceRerReportAccessList,
} from '../../services/api/rer-report-admin';
import { currentSystemSettings, setRerReportEnabled } from '../../services/api/system-settings';
import { RerReportMetadataTable } from './RerReportMetadataTable';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function isActiveHuman(login: Login): boolean {
  return (
    !login.deleted &&
    login.organismId !== null &&
    login.organismEnabled === true &&
    login.deactivationReason === null &&
    !login.roles.some((role) => role === 'Api' || role === 'ApiAgent')
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function RerReportSettings() {
  const { notify } = usePowerSnackbar();
  const [enabled, setEnabled] = useState(false);
  const [logins, setLogins] = useState<Login[]>([]);
  const [savedLoginIds, setSavedLoginIds] = useState<string[]>([]);
  const [selectedLoginIds, setSelectedLoginIds] = useState<string[]>([]);
  const [metadataRows, setMetadataRows] = useState<RerReportMetadataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSetting, setSavingSetting] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [settings, loginData, access, metadata] = await Promise.all([
        currentSystemSettings(),
        listLogins({ sortBy: 'LoginCreatedAtAsc', filterByRoles: null }),
        getRerReportAccessList(),
        listRerReportMetadata(),
      ]);
      setEnabled(settings.rerReportEnabled);
      setLogins(loginData.users);
      setSavedLoginIds(access.loginIds);
      setSelectedLoginIds(access.loginIds);
      setMetadataRows(metadata);
    } catch (nextError) {
      const message = `Не вдалося завантажити налаштування звіту РЕР: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function reloadMetadata() {
    setLoading(true);
    setError(null);
    try {
      setMetadataRows(await listRerReportMetadata());
    } catch (nextError) {
      const message = `Не вдалося завантажити метадані РЕР: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedIds = useMemo(() => new Set(selectedLoginIds), [selectedLoginIds]);
  const loginOptions = useMemo(
    () =>
      logins
        .filter((login) => isActiveHuman(login) || selectedIds.has(login.id))
        .sort((left, right) => left.login.localeCompare(right.login, 'uk')),
    [logins, selectedIds],
  );
  const selectedLogins = selectedLoginIds
    .map((id) => logins.find((login) => login.id === id))
    .filter((login): login is Login => login !== undefined);

  async function updateEnabled(nextEnabled: boolean) {
    const previousEnabled = enabled;
    setEnabled(nextEnabled);
    setSavingSetting(true);
    setError(null);
    try {
      const settings = await setRerReportEnabled(nextEnabled);
      setEnabled(settings.rerReportEnabled);
      notify({ severity: 'success', message: 'Налаштування звіту РЕР збережено.' });
    } catch (nextError) {
      const message = `Не вдалося зберегти налаштування: ${errorMessage(nextError)}`;
      setEnabled(previousEnabled);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSavingSetting(false);
    }
  }

  async function saveAccessList() {
    setSavingAccess(true);
    setError(null);
    try {
      const access = await replaceRerReportAccessList({ loginIds: selectedLoginIds });
      setSavedLoginIds(access.loginIds);
      setSelectedLoginIds(access.loginIds);
      notify({ severity: 'success', message: 'Список користувачів звіту РЕР збережено.' });
    } catch (nextError) {
      const message = `Не вдалося зберегти список користувачів: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSavingAccess(false);
    }
  }

  return (
    <Stack spacing={2.5} sx={{ height: '100%', minHeight: 0 }}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <Stack spacing={1.5} alignItems="flex-start" sx={{ flexShrink: 0 }}>
        <FormControlLabel
          control={
            <Switch
              checked={enabled}
              disabled={loading || savingSetting}
              onChange={(_, checked) => void updateEnabled(checked)}
              slotProps={{ input: { 'aria-label': 'enable rer report' } }}
            />
          }
          label="Звіт РЕР увімкнено в системі"
        />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <Autocomplete<Login, true>
            multiple
            disableCloseOnSelect
            options={loginOptions}
            value={selectedLogins}
            loading={loading}
            disabled={loading || savingAccess}
            getOptionLabel={(login) => login.login}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, selected) => setSelectedLoginIds(selected.map((login) => login.id))}
            getOptionDisabled={(login) => !isActiveHuman(login) && !selectedIds.has(login.id)}
            renderOption={(props, login) => (
              <li {...props} key={login.id}>
                <Box>
                  <Typography>{login.login}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {isActiveHuman(login)
                      ? login.organismName || 'Без організації'
                      : 'Неактивний або службовий обліковий запис'}
                  </Typography>
                </Box>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Працює над звітом РЕР"
                helperText="Тільки ці користувачі бачать прапорець «для звіту РЕР» в аналізі"
              />
            )}
            sx={{ width: { xs: '100%', md: 620 } }}
          />
          <PowerButton
            variant="contained"
            onClick={() => void saveAccessList()}
            disabled={loading || savingAccess || sameIds(selectedLoginIds, savedLoginIds)}
          >
            {savingAccess ? 'Збереження…' : 'Зберегти список'}
          </PowerButton>
        </Stack>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <RerReportMetadataTable
          rows={metadataRows}
          setRows={setMetadataRows}
          loading={loading}
          onReload={() => void reloadMetadata()}
        />
      </Box>
    </Stack>
  );
}
