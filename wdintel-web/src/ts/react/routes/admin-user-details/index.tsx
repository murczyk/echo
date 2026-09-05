import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Login } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  AiAgentUserStatus,
  getAiAgentUserStatus,
  startAiAgentContainer,
  stopAiAgentContainer,
  testAiAgentConnection,
} from '../../services/api/ai-agent';
import { listLogins } from '../../services/api/logins';

type TabName = 'details' | 'ai-agent';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Невідома помилка';
}

function goBack() {
  window.history.pushState({}, '', '/admin/users-neo');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(180px, 0.35fr) 1fr' },
        gap: 1,
        py: 1,
      }}
    >
      <Typography color="text.secondary">{label}</Typography>
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{value}</Box>
    </Box>
  );
}

function UserDetailsTab({ login }: { login: Login }) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 0 }}>
      <CardContent>
        <DetailRow
          label="UUID"
          value={<Typography fontFamily="monospace">{login.id}</Typography>}
        />
        <Divider />
        <DetailRow label="Логін" value={login.login} />
        <Divider />
        <DetailRow
          label="Ролі"
          value={
            <Stack direction="row" spacing={0.5} flexWrap="wrap">
              {login.roles.map((role) => (
                <Chip key={role} label={role} size="small" />
              ))}
            </Stack>
          }
        />
        <Divider />
        <DetailRow label="Організм" value={login.organismName ?? '—'} />
        <Divider />
        <DetailRow label="Зона" value={login.sigintZoneName ?? '—'} />
        <Divider />
        <DetailRow
          label="Автентифікація паролем"
          value={login.passwordAuthEnabled ? 'Так' : 'Ні'}
        />
        <Divider />
        <DetailRow label="2FA" value={login.totpEnabled ? 'Увімкнено' : 'Вимкнено'} />
        <Divider />
        <DetailRow label="Стан" value={login.deleted ? 'Вимкнено' : 'Активний'} />
      </CardContent>
    </Card>
  );
}

function AiAgentTab({ loginId }: { loginId: string }) {
  const [status, setStatus] = useState<AiAgentUserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'start' | 'stop' | 'test' | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load();
  }, [loginId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getAiAgentUserStatus(loginId));
    } catch (loadError) {
      const message = `Не вдалося завантажити ШІ агента: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function runLifecycle(nextAction: 'start' | 'stop') {
    setAction(nextAction);
    try {
      if (nextAction === 'start') await startAiAgentContainer(loginId);
      else await stopAiAgentContainer(loginId);
      notify({
        severity: 'success',
        message: nextAction === 'start' ? 'Запуск агента розпочато.' : 'Агента примусово зупинено.',
      });
      await load();
    } catch (actionError) {
      notify({
        severity: 'error',
        message: `Не вдалося змінити стан агента: ${errorMessage(actionError)}`,
      });
    } finally {
      setAction(null);
    }
  }

  async function testConnection() {
    setAction('test');
    try {
      await testAiAgentConnection(loginId);
      notify({ severity: 'success', message: 'Автентифікацію ECHO з контейнера перевірено.' });
      await load();
    } catch (testError) {
      notify({
        severity: 'error',
        message: `Тест з’єднання не пройдено: ${errorMessage(testError)}`,
      });
    } finally {
      setAction(null);
    }
  }

  if (loading && !status) return <PageLoadingState />;
  if (!status) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        <PowerAlert severity="error">{error ?? 'Пов’язаний ШІ агент не знайдений.'}</PowerAlert>
        <PowerButton variant="outlined" onClick={() => void load()}>
          Спробувати ще раз
        </PowerButton>
      </Stack>
    );
  }

  const running = status.container?.status === 'running';
  const transitioning = ['starting', 'stopping'].includes(status.container?.status ?? '');
  return (
    <Stack spacing={2}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <PowerButton
          variant="contained"
          disabled={running || transitioning || action !== null}
          startIcon={action === 'start' ? <CircularProgress size={16} /> : undefined}
          onClick={() => void runLifecycle('start')}
        >
          Start
        </PowerButton>
        <PowerButton
          color="error"
          variant="outlined"
          disabled={!running || action !== null}
          startIcon={action === 'stop' ? <CircularProgress size={16} /> : undefined}
          onClick={() => void runLifecycle('stop')}
        >
          Force stop
        </PowerButton>
        <PowerButton
          variant="outlined"
          disabled={!running || action !== null}
          startIcon={action === 'test' ? <CircularProgress size={16} /> : undefined}
          onClick={() => void testConnection()}
        >
          Test connection
        </PowerButton>
      </Stack>

      <Card variant="outlined" sx={{ borderRadius: 0 }}>
        <CardContent>
          <DetailRow label="Пов’язаний логін" value={status.linkedLogin ?? 'Не створено'} />
          <Divider />
          <DetailRow label="UUID пов’язаного логіна" value={status.linkedLoginId ?? '—'} />
          <Divider />
          <DetailRow label="Логін активний" value={status.linkedLoginEnabled ? 'Так' : 'Ні'} />
          <Divider />
          <DetailRow
            label="Ролі"
            value={
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {status.roles.map((role) => (
                  <Chip key={role} label={role} size="small" />
                ))}
              </Stack>
            }
          />
          <Divider />
          <DetailRow label="Організм" value={status.organismName ?? '—'} />
          <Divider />
          <DetailRow label="Зона" value={status.zoneName ?? '—'} />
          <Divider />
          <DetailRow
            label="Прямі приховані групи"
            value={status.hiddenGroups.length > 0 ? status.hiddenGroups.join(', ') : 'Немає'}
          />
          <Divider />
          <DetailRow
            label="Контейнер"
            value={
              status.container ? (
                <Stack spacing={0.5}>
                  <Box>
                    <Chip
                      size="small"
                      label={status.container.status}
                      color={running ? 'success' : 'default'}
                    />{' '}
                    {status.container.instanceName}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {status.container.cpuCount} vCPU · {status.container.memoryMib} MiB RAM ·{' '}
                    {status.container.storageGib} GiB · {status.container.processLimit} процесів
                  </Typography>
                  {status.container.lastError ? (
                    <PowerAlert severity="error">{status.container.lastError}</PowerAlert>
                  ) : null}
                </Stack>
              ) : (
                'Ще не створено'
              )
            }
          />
        </CardContent>
      </Card>
    </Stack>
  );
}

export function AdminUserDetailsPage({ loginId }: { loginId: string }) {
  const [login, setLogin] = useState<Login | null>(null);
  const [tab, setTab] = useState<TabName>('details');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listLogins({ sortBy: null, filterByRoles: null });
        const next = response.users.find((item) => item.id === loginId) ?? null;
        setLogin(next);
        if (!next) setError('Користувача не знайдено.');
      } catch (loadError) {
        const message = `Не вдалося завантажити користувача: ${errorMessage(loadError)}`;
        setError(message);
        notify({ severity: 'error', message });
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [loginId]);

  if (loading) return <PageLoadingState />;

  return (
    <Stack spacing={2}>
      <PageHeader
        title={login?.login ?? 'Користувач'}
        titleLeadingActions={
          <PowerButton variant="text" startIcon={<ArrowBackIcon />} onClick={goBack}>
            Назад
          </PowerButton>
        }
      />
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {login ? (
        <>
          <Tabs value={tab} onChange={(_, value: TabName) => setTab(value)}>
            <Tab value="details" label="Дані користувача" />
            <Tab value="ai-agent" label="AI Agent" />
          </Tabs>
          {tab === 'details' ? <UserDetailsTab login={login} /> : null}
          {tab === 'ai-agent' ? <AiAgentTab loginId={login.id} /> : null}
        </>
      ) : null}
    </Stack>
  );
}
