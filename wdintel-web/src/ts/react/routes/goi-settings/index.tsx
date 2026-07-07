import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DownloadIcon from '@mui/icons-material/Download';
import LaunchIcon from '@mui/icons-material/Launch';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  Link,
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

import type { User } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { PowerAlert } from '../../components/PowerAlert';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { fetchCurrentUser } from '../../services/api/user';
import {
  downloadCurrentUserGoiPalettes,
  GoiRestartService,
  GoiWhatsappService,
  GoiUserIntegration,
  fetchCurrentUserGoiIntegrations,
  restartCurrentUserGoiService,
  unlinkCurrentUserGoiWhatsapp,
  updateCurrentUserGoiPauseWorker,
  uploadCurrentUserGoiCategories,
} from '../../services/api/goi-settings';
import { downloadBlob } from '../../utils/download-blob';
import { hasRole } from '../../utils/roles';
import { GoiReportTabOrderSection } from './GoiReportTabOrderSection';

const ECHO_MESSENGERS_DOC_URL = '/docs/goi-messengers/';

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
  return 'ГОІ';
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
    url.pathname = '/echo-im/';
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
  onDownloadPalettes: (integrationId: number) => void;
  onUploadCategories: (integrationId: number, file: File) => void;
  onUpdatePauseWorker: (integrationId: number, pauseWorker: boolean) => void;
};

type ShowMoreTableRowProps = {
  expanded: boolean;
  onToggle: () => void;
};

type ServiceTableRowProps = {
  integrationId: number;
  label: string;
  openLabel: string;
  url: string | null;
  unavailableLabel: string;
  docsUrl?: string;
  restartService: GoiRestartService;
  unlinkService?: GoiWhatsappService;
  pendingKey: string | null;
  restartPendingKey: string;
  unlinkPendingKey?: string;
  disabled: boolean;
  onRestart: (integrationId: number, service: GoiRestartService) => void;
  onUnlink: (integrationId: number, service: GoiWhatsappService) => void;
};

type GoiDataControlPanelProps = {
  integration: GoiUserIntegration;
  disabled: boolean;
  pendingKey: string | null;
  onDownloadPalettes: (integrationId: number) => void;
  onUploadCategories: (integrationId: number, file: File) => void;
  onUpdatePauseWorker: (integrationId: number, pauseWorker: boolean) => void;
};

type AdditionalFunctionRowProps = {
  title: string;
  description: string;
  children: React.ReactNode;
};

function AdditionalFunctionRow(props: AdditionalFunctionRowProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) auto' },
        gap: 1.5,
        alignItems: { xs: 'stretch', md: 'center' },
        py: 1.5,
      }}
    >
      <Stack spacing={0.5}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          {props.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {props.description}
        </Typography>
      </Stack>
      <Box sx={{ justifySelf: { xs: 'stretch', md: 'end' } }}>{props.children}</Box>
    </Box>
  );
}

function ShowMoreTableRow(props: ShowMoreTableRowProps) {
  return (
    <TableRow>
      <TableCell colSpan={3} sx={{ py: 1.25 }}>
        <Button
          size="small"
          variant="text"
          onClick={props.onToggle}
          endIcon={
            <ExpandMoreIcon
              fontSize="small"
              sx={{
                transform: props.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 150ms ease',
              }}
            />
          }
          aria-expanded={props.expanded}
        >
          {props.expanded ? 'Показати менше' : 'Показати більше'}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ServiceTableRow(props: ServiceTableRowProps) {
  const url = props.url;
  const unlinkService = props.unlinkService;
  const pending =
    props.pendingKey === props.restartPendingKey || props.pendingKey === props.unlinkPendingKey;

  return (
    <TableRow>
      <TableCell sx={{ width: 170, whiteSpace: 'nowrap' }}>
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {props.label}
          </Typography>
          {props.docsUrl ? (
            <Typography variant="caption" color="text.secondary">
              <Link href={props.docsUrl} target="_blank" rel="noopener noreferrer">
                документація з налаштування
              </Link>
            </Typography>
          ) : null}
        </Stack>
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

function GoiDataControlPanel(props: GoiDataControlPanelProps) {
  const [categoriesFile, setCategoriesFile] = React.useState<File | null>(null);
  const [pauseDialogValue, setPauseDialogValue] = React.useState<boolean | null>(null);
  const categoriesInputRef = React.useRef<HTMLInputElement | null>(null);
  const pausePendingKey = `${props.integration.id}:pause-worker`;
  const downloadPendingKey = `${props.integration.id}:download-palettes`;
  const uploadPendingKey = `${props.integration.id}:upload-categories`;
  const pausePending = props.pendingKey === pausePendingKey;
  const downloading = props.pendingKey === downloadPendingKey;
  const uploading = props.pendingKey === uploadPendingKey;
  const pauseWorkerDisabled = props.pendingKey !== null || !props.integration.canChangePauseWorker;
  const pauseDialogDescription =
    pauseDialogValue === true
      ? "Дана дія зупинить підвантаження нових палітр, позивних, прив'язок частот із ЕХО"
      : "Дана дія може стерти ваші дані (позивні, прив'язки частот) із ГОІ";

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    setCategoriesFile(event.target.files?.[0] ?? null);
  }

  function closePauseDialog() {
    setPauseDialogValue(null);
  }

  function confirmPauseDialog() {
    if (pauseDialogValue === null) return;
    props.onUpdatePauseWorker(props.integration.id, pauseDialogValue);
    setPauseDialogValue(null);
  }

  return (
    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>
        Додаткові функції
      </Typography>
      <Stack spacing={0.5} sx={{ mt: 1.5 }}>
        <AdditionalFunctionRow
          title="Призупинити синхронізацію"
          description={
            props.integration.canChangePauseWorker
              ? 'Тимчасово зупиняє синхронізацію для цього ГОІ.'
              : 'Змінити може відповідальний за інтеграцію або адміністратор.'
          }
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Checkbox
              checked={props.integration.pauseWorker}
              disabled={pauseWorkerDisabled}
              inputProps={{ 'aria-label': 'Призупинити синхронізацію' }}
              onChange={(event) => setPauseDialogValue(event.target.checked)}
            />
            {pausePending ? <CircularProgress size={18} /> : null}
          </Stack>
        </AdditionalFunctionRow>

        <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
          <AdditionalFunctionRow
            title="Завантажити палітри"
            description="Завантажує ZIP-архів папки palettes з цього ГОІ."
          >
            <PowerButton
              variant="outlined"
              startIcon={
                downloading ? <CircularProgress size={16} /> : <DownloadIcon fontSize="small" />
              }
              disabled={props.disabled}
              onClick={() => props.onDownloadPalettes(props.integration.id)}
            >
              Завантажити
            </PowerButton>
          </AdditionalFunctionRow>
        </Box>

        <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
          <AdditionalFunctionRow
            title="Оновити категорії"
            description="Надсилає JSON-файл категорій на цей ГОІ як categories.json."
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ xs: 'stretch', sm: 'center' }}
            >
              <Box
                ref={categoriesInputRef}
                component="input"
                type="file"
                accept=".json,application/json"
                aria-label="Файл категорій"
                disabled={props.disabled}
                onChange={onFileChange}
                sx={{ display: 'none' }}
              />
              <PowerButton
                variant="outlined"
                startIcon={<UploadFileIcon fontSize="small" />}
                disabled={props.disabled}
                onClick={() => categoriesInputRef.current?.click()}
              >
                Вибрати файл
              </PowerButton>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  maxWidth: { xs: '100%', sm: 220 },
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {categoriesFile?.name ?? 'Файл не вибрано'}
              </Typography>
              <PowerButton
                variant="contained"
                startIcon={
                  uploading ? (
                    <CircularProgress color="inherit" size={16} />
                  ) : (
                    <UploadFileIcon fontSize="small" />
                  )
                }
                disabled={props.disabled || !categoriesFile}
                onClick={() => {
                  if (categoriesFile) {
                    props.onUploadCategories(props.integration.id, categoriesFile);
                  }
                }}
              >
                Надіслати
              </PowerButton>
            </Stack>
          </AdditionalFunctionRow>
        </Box>
      </Stack>
      <ConfirmDangerDialog
        open={pauseDialogValue !== null}
        title="Ви впевнені?"
        description={pauseDialogDescription}
        cancelLabel="Скасувати"
        confirmLabel="Підтвердити"
        onClose={closePauseDialog}
        onConfirm={confirmPauseDialog}
      />
    </Box>
  );
}

function IntegrationCard(props: IntegrationCardProps) {
  const { integration } = props;
  const [showLegacySwappRows, setShowLegacySwappRows] = React.useState(false);
  const integrationSwappAltUrl = swappAltUrl(integration.swappUrl);
  const integrationEchoSwappUrl = echoSwappUrl(integration.goiUrl);
  const goiKey = `${integration.id}:restart:goi`;
  const echoSwappKey = `${integration.id}:restart:echo_swapp`;
  const swappKey = `${integration.id}:restart:swapp`;
  const swappUnlinkKey = `${integration.id}:unlink:swapp`;
  const swappAltKey = `${integration.id}:restart:swapp_alt`;
  const swappAltUnlinkKey = `${integration.id}:unlink:swapp_alt`;
  const actionDisabled = !integration.canRestart || props.pendingKey !== null;

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
            <Table size="small" sx={{ minWidth: 860 }} aria-label="Сервіси ГОІ">
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
                  label="ГОІ"
                  openLabel="Відкрити ГОІ"
                  url={integration.goiUrl}
                  unavailableLabel="URL / host ГОІ не вказано"
                  restartService="goi"
                  pendingKey={props.pendingKey}
                  restartPendingKey={goiKey}
                  disabled={actionDisabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
                <ServiceTableRow
                  integrationId={integration.id}
                  label="Месенджери"
                  openLabel="Відкрити Месенджери"
                  url={integrationEchoSwappUrl}
                  unavailableLabel="URL Месенджерів не вказано"
                  docsUrl={ECHO_MESSENGERS_DOC_URL}
                  restartService="echo_swapp"
                  pendingKey={props.pendingKey}
                  restartPendingKey={echoSwappKey}
                  disabled={actionDisabled}
                  onRestart={props.onRestart}
                  onUnlink={props.onUnlink}
                />
                <ShowMoreTableRow
                  expanded={showLegacySwappRows}
                  onToggle={() => setShowLegacySwappRows((prev) => !prev)}
                />
                {showLegacySwappRows ? (
                  <>
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
                      disabled={actionDisabled}
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
                      disabled={actionDisabled}
                      onRestart={props.onRestart}
                      onUnlink={props.onUnlink}
                    />
                  </>
                ) : null}
              </TableBody>
            </Table>
          </TableContainer>

          <GoiDataControlPanel
            integration={integration}
            disabled={actionDisabled}
            pendingKey={props.pendingKey}
            onDownloadPalettes={props.onDownloadPalettes}
            onUploadCategories={props.onUploadCategories}
            onUpdatePauseWorker={props.onUpdatePauseWorker}
          />

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
  const [currentUser, setCurrentUser] = React.useState<User | null>(null);
  const [integrations, setIntegrations] = React.useState<GoiUserIntegration[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  const [actionStatus, setActionStatus] = React.useState<ActionStatus>(null);
  const isAdmin = currentUser ? hasRole(currentUser.roles, 'Admin') : false;

  React.useEffect(() => {
    const abortController = new AbortController();

    void (async () => {
      try {
        const nextCurrentUser = await fetchCurrentUser(abortController.signal);
        if (abortController.signal.aborted) return;
        setCurrentUser(nextCurrentUser);

        const nextIntegrations = hasRole(nextCurrentUser.roles, 'Rer')
          ? await fetchCurrentUserGoiIntegrations(abortController.signal)
          : [];
        if (abortController.signal.aborted) return;
        setIntegrations(nextIntegrations);
        setLoadError(null);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        setCurrentUser(null);
        setIntegrations([]);
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

  async function handleUpdatePauseWorker(integrationId: number, pauseWorker: boolean) {
    const nextPendingKey = `${integrationId}:pause-worker`;
    if (pendingKey) return;

    setPendingKey(nextPendingKey);
    setActionStatus(null);

    try {
      const updated = await updateCurrentUserGoiPauseWorker(integrationId, pauseWorker);
      setIntegrations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setActionStatus({
        kind: 'success',
        integrationId,
        message: 'Налаштування синхронізації оновлено',
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

  async function handleDownloadPalettes(integrationId: number) {
    const nextPendingKey = `${integrationId}:download-palettes`;
    if (pendingKey) return;

    setPendingKey(nextPendingKey);
    setActionStatus(null);

    try {
      const blob = await downloadCurrentUserGoiPalettes(integrationId);
      downloadBlob(blob, `goi-palettes-${integrationId}.zip`);
      setActionStatus({
        kind: 'success',
        integrationId,
        message: 'Архів палітр завантажено',
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

  async function handleUploadCategories(integrationId: number, file: File) {
    const nextPendingKey = `${integrationId}:upload-categories`;
    if (pendingKey) return;

    setPendingKey(nextPendingKey);
    setActionStatus(null);

    try {
      await uploadCurrentUserGoiCategories(integrationId, file);
      setActionStatus({
        kind: 'success',
        integrationId,
        message: 'categories.json завантажено на ГОІ',
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
      {!loading && !loadError && !isAdmin && integrations.length === 0 ? (
        <PowerAlert severity="info">
          Для поточного користувача немає доступних інтеграцій ГОІ.
        </PowerAlert>
      ) : null}

      {integrations.map((integration) => (
        <IntegrationCard
          key={integration.id}
          integration={integration}
          actionStatus={actionStatus}
          pendingKey={pendingKey}
          onRestart={handleRestart}
          onUnlink={handleUnlink}
          onDownloadPalettes={handleDownloadPalettes}
          onUploadCategories={handleUploadCategories}
          onUpdatePauseWorker={handleUpdatePauseWorker}
        />
      ))}

      {!loading && !loadError && currentUser ? (
        <GoiReportTabOrderSection integrations={integrations} isAdmin={isAdmin} />
      ) : null}
    </Stack>
  );
}
