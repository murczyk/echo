import LaunchIcon from '@mui/icons-material/Launch';
import {
  Alert,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';

import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import {
  isUnauthorizedError,
} from '../../services/api/client';
import {
  CurrentUserGoiControlState,
  GoiRestartService,
  fetchCurrentUserGoiControlState,
  restartCurrentUserGoiService,
} from '../../services/api/goi-settings';

type GoiSettingsPageProps = {
  goiHost: string | null;
};

type ActionStatus =
  | {
      kind: 'success' | 'error';
      message: string;
    }
  | null;

function buildSwappUrl(rawHost: string | null): string | null {
  const host = rawHost?.trim();
  if (!host) return null;

  const normalizedHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;

  try {
    const url = new URL(normalizedHost);
    url.protocol = 'http:';
    url.port = '4002';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return null;
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function redirectToLogin() {
  window.location.assign('/login');
}

function restartServiceLabel(service: GoiRestartService): string {
  switch (service) {
    case 'swapp':
      return 'SWAPP';
    case 'goi':
      return 'GOI';
  }
}

type RestartActionCardProps = {
  title: string;
  description: string;
  buttonLabel: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
};

function RestartActionCard(props: RestartActionCardProps) {
  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <Stack spacing={2.5}>
          <div>
            <Typography variant="h6" component="h2" className="!text-lg !font-semibold">
              {props.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {props.description}
            </Typography>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="contained" color="error" disabled={props.disabled} onClick={props.onClick}>
              {props.buttonLabel}
            </Button>
            {props.loading ? <CircularProgress size={18} /> : null}
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function GoiSettingsPage(props: GoiSettingsPageProps) {
  const swappUrl = buildSwappUrl(props.goiHost);
  const [controlState, setControlState] = React.useState<CurrentUserGoiControlState | null>(null);
  const [controlStateError, setControlStateError] = React.useState<string | null>(null);
  const [pendingService, setPendingService] = React.useState<GoiRestartService | null>(null);
  const [actionStatus, setActionStatus] = React.useState<ActionStatus>(null);

  React.useEffect(() => {
    const abortController = new AbortController();

    void (async () => {
      try {
        const nextControlState = await fetchCurrentUserGoiControlState(abortController.signal);
        if (abortController.signal.aborted) return;
        setControlState(nextControlState);
        setControlStateError(null);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        setControlState(null);
        setControlStateError(formatErrorMessage(error));
      }
    })();

    return () => {
      abortController.abort();
    };
  }, []);

  async function handleRestart(service: GoiRestartService) {
    if (pendingService) return;

    setPendingService(service);
    setActionStatus(null);

    try {
      await restartCurrentUserGoiService(service);
      setActionStatus({
        kind: 'success',
        message: `${restartServiceLabel(service)} успішно перезапущено`,
      });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setActionStatus({
        kind: 'error',
        message: formatErrorMessage(error),
      });
    } finally {
      setPendingService(null);
    }
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title="ГОІ: налаштування"
        titleInfo="Перезапуск сервісів для GOI інстансу організму поточного користувача."
      />

      {actionStatus ? <Alert severity={actionStatus.kind}>{actionStatus.message}</Alert> : null}
      {controlStateError ? <Alert severity="error">{controlStateError}</Alert> : null}
      {!controlState && !controlStateError ? <Alert severity="info">Перевіряю доступність перезапуску GOI...</Alert> : null}
      {controlState && !controlState.canRestart && controlState.restartUnavailableReason ? (
        <Alert severity="info">{controlState.restartUnavailableReason}</Alert>
      ) : null}

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Stack spacing={2}>
            <div>
              <Typography variant="h6" component="h2" className="!text-lg !font-semibold">
                SWAPP
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Відкриває SWAPP на порту 4002 поточного інстансу ГОІ.
              </Typography>
            </div>
            {swappUrl ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outlined"
                  endIcon={<LaunchIcon />}
                  onClick={() => window.open(swappUrl, '_blank', 'noopener,noreferrer')}
                >
                  Відкрити SWAPP
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {swappUrl}
                </Typography>
              </div>
            ) : (
              <Alert severity="warning">Для організму не вказано GOI host, тому посилання на SWAPP недоступне.</Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      <RestartActionCard
        title="Перезапуск SWAPP"
        description="Виконує на GOI інстансі команду sudo systemctl restart swapp."
        buttonLabel="Перезапуск SWAPP"
        disabled={!controlState?.canRestart || pendingService !== null}
        loading={pendingService === 'swapp'}
        onClick={() => handleRestart('swapp')}
      />

      <RestartActionCard
        title="Перезапуск GOI"
        description="Виконує на GOI інстансі команду sudo systemctl restart goi."
        buttonLabel="Перезапуск GOI"
        disabled={!controlState?.canRestart || pendingService !== null}
        loading={pendingService === 'goi'}
        onClick={() => handleRestart('goi')}
      />
    </Stack>
  );
}
