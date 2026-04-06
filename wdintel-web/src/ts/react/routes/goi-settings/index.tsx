import LaunchIcon from '@mui/icons-material/Launch';
import {
  Alert,
  Card,
  CardActions,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';

import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { isUnauthorizedError } from '../../services/api/client';
import {
  GoiRestartService,
  GoiUserIntegration,
  fetchCurrentUserGoiIntegrations,
  restartCurrentUserGoiService,
} from '../../services/api/goi-settings';

type ActionStatus = {
  kind: 'success' | 'error';
  integrationId: number;
  message: string;
} | null;

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
  return service === 'swapp' ? 'SWAPP' : 'GOI';
}

type IntegrationCardProps = {
  integration: GoiUserIntegration;
  actionStatus: ActionStatus;
  pendingKey: string | null;
  onRestart: (integrationId: number, service: GoiRestartService) => void;
};

function IntegrationCard(props: IntegrationCardProps) {
  const { integration } = props;
  const goiKey = `${integration.id}:goi`;
  const swappKey = `${integration.id}:swapp`;

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <Stack spacing={2}>
          <div>
            <Typography variant="h6" component="h2" className="!text-lg !font-semibold">
              {integration.serverLabel || 'ГОІ сервер'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Власник: {integration.ownerOrganismName}
            </Typography>
          </div>

          {integration.goiUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outlined"
                endIcon={<LaunchIcon />}
                onClick={() => window.open(integration.goiUrl!, '_blank', 'noopener,noreferrer')}
              >
                Відкрити ГОІ
              </Button>
              <Typography variant="body2" color="text.secondary">
                {integration.goiUrl}
              </Typography>
            </div>
          ) : (
            <Alert severity="warning">Для цієї інтеграції не вказано URL / host ГОІ.</Alert>
          )}

          {integration.swappUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outlined"
                endIcon={<LaunchIcon />}
                onClick={() => window.open(integration.swappUrl!, '_blank', 'noopener,noreferrer')}
              >
                Відкрити SWAPP
              </Button>
              <Typography variant="body2" color="text.secondary">
                {integration.swappUrl}
              </Typography>
            </div>
          ) : null}

          {!integration.canRestart && integration.restartUnavailableReason ? (
            <Alert severity="info">{integration.restartUnavailableReason}</Alert>
          ) : null}

          {props.actionStatus?.integrationId === integration.id ? (
            <Alert severity={props.actionStatus.kind}>{props.actionStatus.message}</Alert>
          ) : null}
        </Stack>
      </CardContent>
      <CardActions sx={{ px: 3, pb: 3, pt: 0, gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          color="error"
          disabled={!integration.canRestart || props.pendingKey !== null}
          onClick={() => props.onRestart(integration.id, 'swapp')}
        >
          Перезапуск SWAPP
        </Button>
        {props.pendingKey === swappKey ? <CircularProgress size={18} /> : null}
        <Button
          variant="contained"
          color="error"
          disabled={!integration.canRestart || props.pendingKey !== null}
          onClick={() => props.onRestart(integration.id, 'goi')}
        >
          Перезапуск GOI
        </Button>
        {props.pendingKey === goiKey ? <CircularProgress size={18} /> : null}
      </CardActions>
    </Card>
  );
}

export function GoiSettingsPage() {
  const [integrations, setIntegrations] = React.useState<GoiUserIntegration[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  const [actionStatus, setActionStatus] = React.useState<ActionStatus>(null);

  React.useEffect(() => {
    const abortController = new AbortController();

    void (async () => {
      try {
        const nextIntegrations = await fetchCurrentUserGoiIntegrations(abortController.signal);
        if (abortController.signal.aborted) return;
        setIntegrations(nextIntegrations);
        setLoadError(null);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(formatErrorMessage(error));
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => abortController.abort();
  }, []);

  async function handleRestart(integrationId: number, service: GoiRestartService) {
    const nextPendingKey = `${integrationId}:${service}`;
    if (pendingKey) return;

    setPendingKey(nextPendingKey);
    setActionStatus(null);

    try {
      await restartCurrentUserGoiService(integrationId, service);
      setActionStatus({
        kind: 'success',
        integrationId,
        message: `${restartServiceLabel(service)} успішно перезапущено`,
      });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setActionStatus({
        kind: 'error',
        integrationId,
        message: formatErrorMessage(error),
      });
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title="ГОІ: налаштування"
        titleInfo="Доступні для поточного користувача інтеграції ГОІ, посилання та перезапуск сервісів."
      />

      {loading ? <Alert severity="info">Завантажую інтеграції ГОІ...</Alert> : null}
      {loadError ? <Alert severity="error">{loadError}</Alert> : null}
      {!loading && !loadError && integrations.length === 0 ? (
        <Alert severity="info">Для поточного користувача немає доступних інтеграцій ГОІ.</Alert>
      ) : null}

      {integrations.map((integration) => (
        <IntegrationCard
          key={integration.id}
          integration={integration}
          actionStatus={actionStatus}
          pendingKey={pendingKey}
          onRestart={handleRestart}
        />
      ))}
    </Stack>
  );
}
