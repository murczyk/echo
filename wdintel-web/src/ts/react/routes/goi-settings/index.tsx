import LaunchIcon from '@mui/icons-material/Launch';
import {
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { PowerAlert } from '../../components/PowerAlert';
import {
  GoiRestartService,
  GoiWhatsappService,
  GoiUserIntegration,
  fetchCurrentUserGoiIntegrations,
  restartCurrentUserGoiService,
  unlinkCurrentUserGoiWhatsapp,
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

function restartServiceLabel(service: GoiRestartService): string {
  if (service === 'swapp') return 'Swapp';
  if (service === 'swapp_alt') return 'Swapp Додатковий';
  if (service === 'echo_swapp') return 'Месенджери';
  return 'GOI';
}

function whatsappServiceLabel(service: GoiWhatsappService): string {
  return service === 'swapp_alt' ? 'Swapp Додатковий' : 'Swapp';
}

function swappAltUrl(swappUrl: string | null): string | null {
  if (!swappUrl) return null;

  try {
    const url = new URL(swappUrl);
    url.port = '4003';
    return url.toString();
  } catch {
    return null;
  }
}

function echoSwappUrl(goiUrl: string | null): string | null {
  if (!goiUrl) return null;

  try {
    const url = new URL(goiUrl);
    url.pathname = '/messengers/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

type IntegrationCardProps = {
  integration: GoiUserIntegration;
  actionStatus: ActionStatus;
  pendingKey: string | null;
  onRestart: (integrationId: number, service: GoiRestartService) => void;
  onUnlink: (integrationId: number, service: GoiWhatsappService) => void;
};

type ServiceTableRowProps = {
  integrationId: number;
  label: string;
  openLabel: string;
  url: string | null;
  unavailableLabel: string;
  restartService: GoiRestartService;
  unlinkService?: GoiWhatsappService;
  pendingKey: string | null;
  restartPendingKey: string;
  unlinkPendingKey?: string;
  disabled: boolean;
  onRestart: (integrationId: number, service: GoiRestartService) => void;
  onUnlink: (integrationId: number, service: GoiWhatsappService) => void;
};

function ServiceTableRow(props: ServiceTableRowProps) {
  const url = props.url;
  const unlinkService = props.unlinkService;
  const pending =
    props.pendingKey === props.restartPendingKey ||
    props.pendingKey === props.unlinkPendingKey;

  return (
    <TableRow>
      <TableCell sx={{ width: 170, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {props.label}
      </TableCell>
      <TableCell>
        {url ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <PowerButton
              variant="outlined"
              endIcon={<LaunchIcon />}
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            >
              {props.openLabel}
            </PowerButton>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              {url}
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {props.unavailableLabel}
          </Typography>
        )}
      </TableCell>
      <TableCell sx={{ width: 260 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <PowerButton
            variant="contained"
            disabled={props.disabled}
            onClick={() => props.onRestart(props.integrationId, props.restartService)}
          >
            ПЕРЕЗАПУСК
          </PowerButton>
          {unlinkService ? (
            <PowerButton
              variant="outlined"
              color="error"
              disabled={props.disabled}
              onClick={() => props.onUnlink(props.integrationId, unlinkService)}
            >
              ВІДВ'ЯЗАТИ
            </PowerButton>
          ) : null}
          {pending ? <CircularProgress size={18} /> : null}
        </Stack>
      </TableCell>
    </TableRow>
  );
}

function IntegrationCard(props: IntegrationCardProps) {
  const { integration } = props;
  const integrationSwappAltUrl = swappAltUrl(integration.swappUrl);
  const integrationEchoSwappUrl = echoSwappUrl(integration.goiUrl);
  const goiKey = `${integration.id}:restart:goi`;
  const echoSwappKey = `${integration.id}:restart:echo_swapp`;
  const swappKey = `${integration.id}:restart:swapp`;
  const swappUnlinkKey = `${integration.id}:unlink:swapp`;
  const swappAltKey = `${integration.id}:restart:swapp_alt`;
  const swappAltUnlinkKey = `${integration.id}:unlink:swapp_alt`;
  const disabled = !integration.canRestart || props.pendingKey !== null;

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

          <TableContainer>
            <Table size="small" sx={{ minWidth: 860 }} aria-label="GOI services">
              <TableHead>
                <TableRow>
                  <TableCell>Сервіс</TableCell>
                  <TableCell>Посилання</TableCell>
                  <TableCell>Керування</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <ServiceTableRow
                  integrationId={integration.id}
                  label="GOI"
                  openLabel="Відкрити ГОІ"
                  url={integration.goiUrl}
                  unavailableLabel="URL / host ГОІ не вказано"
                  restartService="goi"
                  pendingKey={props.pendingKey}
                  restartPendingKey={goiKey}
                  disabled={disabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
                <ServiceTableRow
                  integrationId={integration.id}
                  label="Месенджери"
                  openLabel="Відкрити Месенджери"
                  url={integrationEchoSwappUrl}
                  unavailableLabel="URL Месенджерів не вказано"
                  restartService="echo_swapp"
                  pendingKey={props.pendingKey}
                  restartPendingKey={echoSwappKey}
                  disabled={disabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
                <ServiceTableRow
                  integrationId={integration.id}
                  label="Swapp"
                  openLabel="Відкрити Swapp"
                  url={integration.swappUrl}
                  unavailableLabel="URL Swapp не вказано"
                  restartService="swapp"
                  unlinkService="swapp"
                  pendingKey={props.pendingKey}
                  restartPendingKey={swappKey}
                  unlinkPendingKey={swappUnlinkKey}
                  disabled={disabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
                <ServiceTableRow
                  integrationId={integration.id}
                  label="Swapp Додатковий"
                  openLabel="Відкрити Swapp Додатковий"
                  url={integrationSwappAltUrl}
                  unavailableLabel="URL Swapp Додатковий не вказано"
                  restartService="swapp_alt"
                  unlinkService="swapp_alt"
                  pendingKey={props.pendingKey}
                  restartPendingKey={swappAltKey}
                  unlinkPendingKey={swappAltUnlinkKey}
                  disabled={disabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
              </TableBody>
            </Table>
          </TableContainer>

          {!integration.canRestart && integration.restartUnavailableReason ? (
            <PowerAlert severity="info">{integration.restartUnavailableReason}</PowerAlert>
          ) : null}

          {props.actionStatus?.integrationId === integration.id ? (
            <PowerAlert severity={props.actionStatus.kind}>{props.actionStatus.message}</PowerAlert>
          ) : null}
        </Stack>
      </CardContent>
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
    const nextPendingKey = `${integrationId}:restart:${service}`;
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
      setActionStatus({
        kind: 'error',
        integrationId,
        message: formatErrorMessage(error),
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function handleUnlink(integrationId: number, service: GoiWhatsappService) {
    const nextPendingKey = `${integrationId}:unlink:${service}`;
    if (pendingKey) return;

    setPendingKey(nextPendingKey);
    setActionStatus(null);

    try {
      await unlinkCurrentUserGoiWhatsapp(integrationId, service);
      setActionStatus({
        kind: 'success',
        integrationId,
        message: `${whatsappServiceLabel(service)} успішно відв'язано`,
      });
    } catch (error) {
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

      {loading ? <PowerAlert severity="info">Завантажую інтеграції ГОІ...</PowerAlert> : null}
      {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
      {!loading && !loadError && integrations.length === 0 ? (
        <PowerAlert severity="info">Для поточного користувача немає доступних інтеграцій ГОІ.</PowerAlert>
      ) : null}

      {integrations.map((integration) => (
        <IntegrationCard
          key={integration.id}
          integration={integration}
          actionStatus={actionStatus}
          pendingKey={pendingKey}
          onRestart={handleRestart}
          onUnlink={handleUnlink}
        />
      ))}
    </Stack>
  );
}
