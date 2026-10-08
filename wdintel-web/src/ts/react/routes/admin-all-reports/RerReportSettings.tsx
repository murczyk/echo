import { Autocomplete, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

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

type LoginOption = Pick<Login, 'id' | 'login' | 'organismName'> & { activeHuman: boolean };

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
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [savingSetting, setSavingSetting] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  async function load() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const [settings, loginData, access, metadata] = await Promise.allSettled([
        settingsLoaded ? Promise.resolve(null) : currentSystemSettings(),
        accessLoaded
          ? Promise.resolve(null)
          : listLogins({ sortBy: 'LoginCreatedAtAsc', filterByRoles: null }),
        accessLoaded ? Promise.resolve(null) : getRerReportAccessList(),
        metadataLoaded ? Promise.resolve(null) : listRerReportMetadata(),
      ]);
      if (generation !== loadGeneration.current) return;
      setSettingsLoaded(settings.status === 'fulfilled');
      setAccessLoaded(loginData.status === 'fulfilled' && access.status === 'fulfilled');
      setMetadataLoaded(metadata.status === 'fulfilled');
      if (settings.status === 'fulfilled' && settings.value)
        setEnabled(settings.value.rerReportEnabled);
      if (loginData.status === 'fulfilled' && loginData.value) setLogins(loginData.value.users);
      if (access.status === 'fulfilled' && access.value) {
        setSavedLoginIds(access.value.loginIds);
        setSelectedLoginIds(access.value.loginIds);
      }
      if (metadata.status === 'fulfilled' && metadata.value) setMetadataRows(metadata.value);
      const failures = [settings, loginData, access, metadata].flatMap((result) =>
        result.status === 'rejected' ? [errorMessage(result.reason)] : [],
      );
      if (failures.length > 0) throw new Error(failures.join('; '));
    } catch (nextError) {
      if (generation !== loadGeneration.current) return;
      const message = `Не вдалося завантажити налаштування звіту РЕР: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }

  async function reloadMetadata() {
    const generation = loadGeneration.current;
    setLoading(true);
    try {
      const metadata = await listRerReportMetadata();
      if (generation !== loadGeneration.current) return;
      setMetadataRows(metadata);
      setMetadataLoaded(true);
      if (settingsLoaded && accessLoaded) setError(null);
    } catch (nextError) {
      if (generation !== loadGeneration.current) return;
      setMetadataLoaded(false);
      const message = `Не вдалося завантажити метадані РЕР: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, []);

  const selectedIds = useMemo(() => new Set(selectedLoginIds), [selectedLoginIds]);
  const loginOptions = useMemo<LoginOption[]>(
    () =>
      [
        ...logins
          .filter((login) => isActiveHuman(login) || selectedIds.has(login.id))
          .map((login) => ({
            id: login.id,
            login: login.login,
            organismName: login.organismName,
            activeHuman: isActiveHuman(login),
          })),
        ...selectedLoginIds
          .filter((id) => !logins.some((login) => login.id === id))
          .map((id) => ({
            id,
            login: `Недоступний користувач (${id})`,
            organismName: null,
            activeHuman: false,
          })),
      ].sort((left, right) => left.login.localeCompare(right.login, 'uk')),
    [logins, selectedIds, selectedLoginIds],
  );
  const selectedLogins = selectedLoginIds
    .map((id) => loginOptions.find((login) => login.id === id))
    .filter((login): login is LoginOption => login !== undefined);

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
    <div className="flex h-full min-h-0 flex-col gap-5">
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {!loading && (!settingsLoaded || !accessLoaded || !metadataLoaded) ? (
        <PowerButton
          variant="outlined"
          disabled={savingSetting || savingAccess}
          onClick={() => void load()}
        >
          Повторити завантаження
        </PowerButton>
      ) : null}
      <div className="flex shrink-0 flex-col items-start gap-echo-md">
        <FormControlLabel
          control={
            <Switch
              checked={enabled}
              disabled={loading || !settingsLoaded || savingSetting}
              onChange={(_, checked) => void updateEnabled(checked)}
              slotProps={{ input: { 'aria-label': 'enable rer report' } }}
            />
          }
          label="Звіт РЕР увімкнено в системі"
        />
        <div className="flex w-full flex-col gap-echo-md min-[900px]:flex-row min-[900px]:items-center">
          <Autocomplete<LoginOption, true>
            multiple
            disableCloseOnSelect
            options={loginOptions}
            value={selectedLogins}
            loading={loading}
            disabled={loading || !accessLoaded || savingAccess}
            getOptionLabel={(login) => login.login}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, selected) => setSelectedLoginIds(selected.map((login) => login.id))}
            getOptionDisabled={(login) => !login.activeHuman && !selectedIds.has(login.id)}
            renderOption={(props, login) => (
              <li {...props} key={login.id}>
                <div>
                  <Typography>{login.login}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {login.activeHuman
                      ? login.organismName || 'Без організації'
                      : 'Неактивний або службовий обліковий запис'}
                  </Typography>
                </div>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Працює над звітом РЕР"
                helperText="Тільки ці користувачі бачать прапорець «для звіту РЕР» в аналізі"
              />
            )}
            className="w-full min-[900px]:w-[620px]"
          />
          <PowerButton
            variant="contained"
            onClick={() => void saveAccessList()}
            disabled={
              loading || !accessLoaded || savingAccess || sameIds(selectedLoginIds, savedLoginIds)
            }
          >
            {savingAccess ? 'Збереження…' : 'Зберегти список'}
          </PowerButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <RerReportMetadataTable
          rows={metadataRows}
          setRows={setMetadataRows}
          loading={loading}
          disabled={!metadataLoaded}
          onReload={() => void reloadMetadata()}
        />
      </div>
    </div>
  );
}
