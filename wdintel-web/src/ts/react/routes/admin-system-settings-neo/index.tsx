import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerDateTimePicker } from '../../components/PowerDateTimePicker';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  cleanupOrbitOtherUnits,
  createSystemSettings,
  getRerDutyTestReplayStatus,
  listSystemSettings,
  type RerDutyTestReplayStatus,
  type SystemSettingsItem,
} from '../../services/api/system-settings';
import { APP_TIME_ZONE } from '../../utils/misc';
import { handleNavigateWithinSpaClick } from '../../utils/browser';
import { AdminControlPanelNeoSection } from '../admin-control-panel-neo';
import { CacheBackfillSection } from './CacheBackfillSection';
import { RerReportSettings } from './RerReportSettings';
import { ReportWorkerRestart } from './ReportWorkerRestart';
import {
  readSystemSettingsTab,
  replaceSystemSettingsTabUrl,
  type SystemSettingsTab,
} from './url-state';

type SystemSettingsForm = {
  exactMatchOnlyDefault: boolean;
  rerReportEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  disableBotTags: boolean;
  hideNetworks: boolean;
  dutyExcludeMenuEnabled: boolean;
  analysisAorFilterEnabled: boolean;
  aiPositionHighlightsEnabled: boolean;
  apiRateLimitReplenishIntervalMs: number;
  apiRateLimitBurstSize: number;
  twoFactorAuthEnabled: boolean;
  excludeOrbitOtherUnits: boolean;
  messengerMediaCacheMinFreeGib: SystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messengerMediaCacheMaxSizeGib: SystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messengerMediaCacheRetentionHours: SystemSettingsItem['messengerMediaCacheRetentionHours'];
  messengerMediaCacheEnabled: SystemSettingsItem['messengerMediaCacheEnabled'];
  dutyTestEnabled: boolean;
  dutyTestSinceMs: number;
  dutyTestLimit: number;
  dutyPollIntervalSec: number;
  dutyTestReplayIntervalSec: number;
  shortUrlEnabled: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
  reportChunkingHours: number;
  reportGlobalConcurrency: SystemSettingsItem['reportGlobalConcurrency'];
  reportKindConcurrency: SystemSettingsItem['reportKindConcurrency'];
  reportEtalonkaConcurrency: SystemSettingsItem['reportEtalonkaConcurrency'];
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: string;
  pelengBoundsTopLeftLng: string;
  pelengBoundsBottomRightLat: string;
  pelengBoundsBottomRightLng: string;
  echoRestapiErrorDiscordWebhookUrl: string;
};

type PatchSystemSettingsForm = (patch: Partial<SystemSettingsForm>) => void;

type SystemSettingsPayload = {
  exactMatchOnlyDefault: boolean;
  rerReportEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  disableBotTags: boolean;
  hideNetworks: boolean;
  dutyExcludeMenuEnabled: boolean;
  analysisAorFilterEnabled: boolean;
  aiPositionHighlightsEnabled: boolean;
  apiRateLimitReplenishIntervalMs: number;
  apiRateLimitBurstSize: number;
  twoFactorAuthEnabled: boolean;
  excludeOrbitOtherUnits: boolean;
  messengerMediaCacheMinFreeGib: SystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messengerMediaCacheMaxSizeGib: SystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messengerMediaCacheRetentionHours: SystemSettingsItem['messengerMediaCacheRetentionHours'];
  messengerMediaCacheEnabled: SystemSettingsItem['messengerMediaCacheEnabled'];
  dutyTestEnabled: boolean;
  dutyTestSinceMs: number;
  dutyTestLimit: number;
  dutyPollIntervalSec: number;
  dutyTestReplayIntervalSec: number;
  shortUrlEnabled: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
  reportChunkingHours: number;
  reportGlobalConcurrency: SystemSettingsItem['reportGlobalConcurrency'];
  reportKindConcurrency: SystemSettingsItem['reportKindConcurrency'];
  reportEtalonkaConcurrency: SystemSettingsItem['reportEtalonkaConcurrency'];
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: number | null;
  pelengBoundsTopLeftLng: number | null;
  pelengBoundsBottomRightLat: number | null;
  pelengBoundsBottomRightLng: number | null;
  echoRestapiErrorDiscordWebhookUrl: string | null;
};

const DUTY_POLL_INTERVAL_SEC_MIN = 5;

const EMPTY_FORM: SystemSettingsForm = {
  exactMatchOnlyDefault: true,
  rerReportEnabled: false,
  supportNonRerInterceptions: false,
  defaultNeoAnalysis: false,
  showClassicDuty: true,
  showClassicAnalysis: true,
  showPelengDistanceToBattleline: false,
  disableBotTags: false,
  hideNetworks: false,
  dutyExcludeMenuEnabled: true,
  analysisAorFilterEnabled: true,
  aiPositionHighlightsEnabled: false,
  apiRateLimitReplenishIntervalMs: 500,
  apiRateLimitBurstSize: 5,
  twoFactorAuthEnabled: true,
  excludeOrbitOtherUnits: true,
  messengerMediaCacheEnabled: false,
  messengerMediaCacheRetentionHours: 24,
  messengerMediaCacheMaxSizeGib: 32,
  messengerMediaCacheMinFreeGib: 10,
  dutyTestEnabled: false,
  dutyTestSinceMs: 0,
  dutyTestLimit: 1,
  dutyPollIntervalSec: DUTY_POLL_INTERVAL_SEC_MIN,
  dutyTestReplayIntervalSec: 1,
  shortUrlEnabled: false,
  autofixEchoimMissingMessages: false,
  devicesSectionEnabled: false,
  sigintCommentParsingEnabled: true,
  doNotStoreDuplicateEchoimFailures: false,
  goiAssociationMessageUidWorkerEnabled: false,
  reportChunkingHours: 24,
  reportGlobalConcurrency: 4,
  reportKindConcurrency: 1,
  reportEtalonkaConcurrency: 2,
  limitBigReports: false,
  enableAudioTranscription: false,
  pelengBoundsEnabled: false,
  pelengBoundsTopLeftLat: '',
  pelengBoundsTopLeftLng: '',
  pelengBoundsBottomRightLat: '',
  pelengBoundsBottomRightLng: '',
  echoRestapiErrorDiscordWebhookUrl: '',
};

const SUPPORT_NON_RER_TOOLTIP =
  "Потрібно для кібер роботи. Вмикає підтримку перехоплень добутих з альтернативних джерел. Якщо група має саме такі перехоплення а не традиційний РЕР - змініть категорію групи в її налаштуваннях, тоді перехоплення з такої групи буде прив'язано до мережі по масці підрозділу; налаштування маски підрозділу - в Оперативних Параметрах мережі, в Базі Даних";
const REPORT_CHUNKING_TOOLTIP =
  'якщо звіт охоплює більший період - ми розбиваємо цей період на вікна вказаного розміру, обраховуємо їх окремо і агрегуємо в цілий звіт';
const REPORT_CHUNKING_HOURS_MAX = 2_147_483_647;
const DUTY_TEST_SOURCE_MAX = 10_000;
const DUTY_TEST_REPLAY_INTERVAL_SEC_MAX = 31_536_000;
const DUTY_TEST_ENABLED_TOOLTIP =
  'Фоновий процес по одному відтворює вибрані історичні повідомлення як нові. Після вимкнення або зміни параметрів створені ним копії автоматично прибираються.';
const DUTY_TEST_SINCE_TOOLTIP =
  'Початок історії, з якого буде вибрано наступні повідомлення. Дата й час указуються за київським часом.';
const DUTY_TEST_LIMIT_TOOLTIP = 'Кількість послідовних історичних повідомлень у циклі відтворення.';
const DUTY_POLL_INTERVAL_TOOLTIP =
  'Резервна перевірка нових повідомлень; події надходять одразу між перевірками.';
const DUTY_TEST_REPLAY_INTERVAL_TOOLTIP =
  'Пауза між тестовими повідомленнями. Перше повідомлення надходить одразу, після останнього цикл починається знову.';
const DISABLE_BOT_TAGS_TOOLTIP =
  'Приховує теги, додані ботом, на сторінках «Аналіз» та «Оперативний Neo» і призупиняє створення нових. Після вимкнення наявні теги знову відображатимуться, а бот продовжить роботу.';

function dutyTestSinceDateTime(value: number) {
  return value > 0 ? dayjs(value).tz(APP_TIME_ZONE) : null;
}

function dutyTestSinceMs(value: Dayjs | null): number {
  return value ? value.tz(APP_TIME_ZONE, true).valueOf() : 0;
}

function dutyTestReplayStatusLabel(status: string): string {
  return (
    {
      disabled: 'вимкнено',
      preparing: 'підготовка',
      running: 'працює',
      empty: 'немає повідомлень після вказаної дати',
      cleaning: 'прибирання тестових повідомлень',
      error: 'помилка',
    }[status] ?? status
  );
}

function InfoLabel({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {label}
      <Tooltip title={tooltip} arrow>
        <InfoOutlinedIcon color="action" fontSize="small" />
      </Tooltip>
    </Box>
  );
}

function formFromSettings(item: SystemSettingsItem | undefined): SystemSettingsForm {
  return {
    exactMatchOnlyDefault: item?.rerAnalysisUnitsExactMatchOnlyDefault ?? true,
    rerReportEnabled: item?.rerReportEnabled ?? false,
    supportNonRerInterceptions: item?.supportNonRerInterceptions ?? false,
    defaultNeoAnalysis: item?.defaultNeoAnalysis ?? false,
    showClassicDuty: item?.showClassicDuty ?? true,
    showClassicAnalysis: item?.showClassicAnalysis ?? true,
    showPelengDistanceToBattleline: item?.showPelengDistanceToBattleline ?? false,
    disableBotTags: item?.disableBotTags ?? false,
    hideNetworks: item?.hideNetworks ?? false,
    dutyExcludeMenuEnabled: item?.dutyExcludeMenuEnabled ?? true,
    analysisAorFilterEnabled: item?.analysisAorFilterEnabled ?? true,
    aiPositionHighlightsEnabled: item?.aiPositionHighlightsEnabled ?? false,
    apiRateLimitReplenishIntervalMs: item?.apiRateLimitReplenishIntervalMs ?? 500,
    apiRateLimitBurstSize: item?.apiRateLimitBurstSize ?? 5,
    twoFactorAuthEnabled: item?.twoFactorAuthEnabled ?? true,
    excludeOrbitOtherUnits: item?.excludeOrbitOtherUnits ?? true,
    messengerMediaCacheMinFreeGib: item?.messengerMediaCacheMinFreeGib ?? 10,
    messengerMediaCacheMaxSizeGib: item?.messengerMediaCacheMaxSizeGib ?? 32,
    messengerMediaCacheRetentionHours: item?.messengerMediaCacheRetentionHours ?? 24,
    messengerMediaCacheEnabled: item?.messengerMediaCacheEnabled ?? false,
    dutyTestEnabled: item?.rerDutyTestEnabled ?? false,
    dutyTestSinceMs: item?.rerDutyTestSinceMs ?? 0,
    dutyTestLimit: item?.rerDutyTestLimit ?? 1,
    dutyPollIntervalSec: Math.max(
      DUTY_POLL_INTERVAL_SEC_MIN,
      item?.rerDutyPollIntervalSec ?? DUTY_POLL_INTERVAL_SEC_MIN,
    ),
    dutyTestReplayIntervalSec: item?.rerDutyTestReplayIntervalSec ?? 1,
    shortUrlEnabled: item?.rerShortUrlEnabled ?? false,
    autofixEchoimMissingMessages: item?.autofixEchoimMissingMessages ?? false,
    devicesSectionEnabled: item?.devicesSectionEnabled ?? false,
    sigintCommentParsingEnabled: item?.sigintCommentParsingEnabled ?? true,
    doNotStoreDuplicateEchoimFailures: item?.doNotStoreDuplicateEchoimFailures ?? false,
    goiAssociationMessageUidWorkerEnabled: item?.goiAssociationMessageUidWorkerEnabled ?? false,
    reportChunkingHours: item?.reportChunkingHours ?? 24,
    reportGlobalConcurrency: item?.reportGlobalConcurrency ?? 4,
    reportKindConcurrency: item?.reportKindConcurrency ?? 1,
    reportEtalonkaConcurrency: item?.reportEtalonkaConcurrency ?? 2,
    limitBigReports: item?.limitBigReports ?? false,
    enableAudioTranscription: item?.enableAudioTranscription ?? false,
    pelengBoundsEnabled: item?.pelengBoundsEnabled ?? false,
    pelengBoundsTopLeftLat: coordinateToInput(item?.pelengBoundsTopLeftLat ?? null),
    pelengBoundsTopLeftLng: coordinateToInput(item?.pelengBoundsTopLeftLng ?? null),
    pelengBoundsBottomRightLat: coordinateToInput(item?.pelengBoundsBottomRightLat ?? null),
    pelengBoundsBottomRightLng: coordinateToInput(item?.pelengBoundsBottomRightLng ?? null),
    echoRestapiErrorDiscordWebhookUrl: item?.echoRestapiErrorDiscordWebhookUrl ?? '',
  };
}

function formsEqual(a: SystemSettingsForm, b: SystemSettingsForm): boolean {
  return (
    a.exactMatchOnlyDefault === b.exactMatchOnlyDefault &&
    a.rerReportEnabled === b.rerReportEnabled &&
    a.supportNonRerInterceptions === b.supportNonRerInterceptions &&
    a.defaultNeoAnalysis === b.defaultNeoAnalysis &&
    a.showClassicDuty === b.showClassicDuty &&
    a.showClassicAnalysis === b.showClassicAnalysis &&
    a.showPelengDistanceToBattleline === b.showPelengDistanceToBattleline &&
    a.disableBotTags === b.disableBotTags &&
    a.hideNetworks === b.hideNetworks &&
    a.dutyExcludeMenuEnabled === b.dutyExcludeMenuEnabled &&
    a.analysisAorFilterEnabled === b.analysisAorFilterEnabled &&
    a.aiPositionHighlightsEnabled === b.aiPositionHighlightsEnabled &&
    a.apiRateLimitReplenishIntervalMs === b.apiRateLimitReplenishIntervalMs &&
    a.apiRateLimitBurstSize === b.apiRateLimitBurstSize &&
    a.twoFactorAuthEnabled === b.twoFactorAuthEnabled &&
    a.excludeOrbitOtherUnits === b.excludeOrbitOtherUnits &&
    a.messengerMediaCacheMinFreeGib === b.messengerMediaCacheMinFreeGib &&
    a.messengerMediaCacheMaxSizeGib === b.messengerMediaCacheMaxSizeGib &&
    a.messengerMediaCacheRetentionHours === b.messengerMediaCacheRetentionHours &&
    a.messengerMediaCacheEnabled === b.messengerMediaCacheEnabled &&
    a.dutyTestEnabled === b.dutyTestEnabled &&
    a.dutyTestSinceMs === b.dutyTestSinceMs &&
    a.dutyTestLimit === b.dutyTestLimit &&
    a.dutyPollIntervalSec === b.dutyPollIntervalSec &&
    a.dutyTestReplayIntervalSec === b.dutyTestReplayIntervalSec &&
    a.shortUrlEnabled === b.shortUrlEnabled &&
    a.autofixEchoimMissingMessages === b.autofixEchoimMissingMessages &&
    a.devicesSectionEnabled === b.devicesSectionEnabled &&
    a.sigintCommentParsingEnabled === b.sigintCommentParsingEnabled &&
    a.doNotStoreDuplicateEchoimFailures === b.doNotStoreDuplicateEchoimFailures &&
    a.goiAssociationMessageUidWorkerEnabled === b.goiAssociationMessageUidWorkerEnabled &&
    a.reportChunkingHours === b.reportChunkingHours &&
    a.reportGlobalConcurrency === b.reportGlobalConcurrency &&
    a.reportKindConcurrency === b.reportKindConcurrency &&
    a.reportEtalonkaConcurrency === b.reportEtalonkaConcurrency &&
    a.limitBigReports === b.limitBigReports &&
    a.enableAudioTranscription === b.enableAudioTranscription &&
    a.pelengBoundsEnabled === b.pelengBoundsEnabled &&
    a.pelengBoundsTopLeftLat === b.pelengBoundsTopLeftLat &&
    a.pelengBoundsTopLeftLng === b.pelengBoundsTopLeftLng &&
    a.pelengBoundsBottomRightLat === b.pelengBoundsBottomRightLat &&
    a.pelengBoundsBottomRightLng === b.pelengBoundsBottomRightLng &&
    a.echoRestapiErrorDiscordWebhookUrl === b.echoRestapiErrorDiscordWebhookUrl
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Невідома помилка. Спробуйте ще раз.';
}

function coordinateToInput(value: number | null): string {
  return value === null ? '' : String(value);
}

function parseCoordinateInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const next = Number(trimmed);
  return Number.isFinite(next) ? next : null;
}

function normalizeCoordinateInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  const next = parseCoordinateInput(trimmed);
  return next === null ? trimmed : String(next);
}

function coordinateToPayload(value: string): number | null {
  return parseCoordinateInput(value);
}

function normalizeForm(form: SystemSettingsForm): SystemSettingsForm {
  return {
    ...form,
    dutyTestSinceMs: Math.max(0, Math.floor(form.dutyTestSinceMs) || 0),
    dutyTestLimit: Math.max(1, Math.min(DUTY_TEST_SOURCE_MAX, Math.floor(form.dutyTestLimit) || 1)),
    dutyPollIntervalSec: Math.max(
      DUTY_POLL_INTERVAL_SEC_MIN,
      Math.floor(form.dutyPollIntervalSec) || DUTY_POLL_INTERVAL_SEC_MIN,
    ),
    dutyTestReplayIntervalSec: Math.max(
      1,
      Math.min(DUTY_TEST_REPLAY_INTERVAL_SEC_MAX, Math.floor(form.dutyTestReplayIntervalSec) || 1),
    ),
    reportChunkingHours: Math.min(
      REPORT_CHUNKING_HOURS_MAX,
      Math.max(1, Math.floor(form.reportChunkingHours) || 24),
    ),
    pelengBoundsTopLeftLat: normalizeCoordinateInput(form.pelengBoundsTopLeftLat),
    pelengBoundsTopLeftLng: normalizeCoordinateInput(form.pelengBoundsTopLeftLng),
    pelengBoundsBottomRightLat: normalizeCoordinateInput(form.pelengBoundsBottomRightLat),
    pelengBoundsBottomRightLng: normalizeCoordinateInput(form.pelengBoundsBottomRightLng),
    echoRestapiErrorDiscordWebhookUrl: form.echoRestapiErrorDiscordWebhookUrl.trim(),
  };
}

function formToPayload(form: SystemSettingsForm): SystemSettingsPayload {
  return {
    exactMatchOnlyDefault: form.exactMatchOnlyDefault,
    rerReportEnabled: form.rerReportEnabled,
    supportNonRerInterceptions: form.supportNonRerInterceptions,
    defaultNeoAnalysis: form.defaultNeoAnalysis,
    showClassicDuty: form.showClassicDuty,
    showClassicAnalysis: form.showClassicAnalysis,
    showPelengDistanceToBattleline: form.showPelengDistanceToBattleline,
    disableBotTags: form.disableBotTags,
    hideNetworks: form.hideNetworks,
    dutyExcludeMenuEnabled: form.dutyExcludeMenuEnabled,
    analysisAorFilterEnabled: form.analysisAorFilterEnabled,
    aiPositionHighlightsEnabled: form.aiPositionHighlightsEnabled,
    apiRateLimitReplenishIntervalMs: form.apiRateLimitReplenishIntervalMs,
    apiRateLimitBurstSize: form.apiRateLimitBurstSize,
    twoFactorAuthEnabled: form.twoFactorAuthEnabled,
    excludeOrbitOtherUnits: form.excludeOrbitOtherUnits,
    messengerMediaCacheMinFreeGib: form.messengerMediaCacheMinFreeGib,
    messengerMediaCacheMaxSizeGib: form.messengerMediaCacheMaxSizeGib,
    messengerMediaCacheRetentionHours: form.messengerMediaCacheRetentionHours,
    messengerMediaCacheEnabled: form.messengerMediaCacheEnabled,
    dutyTestEnabled: form.dutyTestEnabled,
    dutyTestSinceMs: form.dutyTestSinceMs,
    dutyTestLimit: form.dutyTestLimit,
    dutyPollIntervalSec: form.dutyPollIntervalSec,
    dutyTestReplayIntervalSec: form.dutyTestReplayIntervalSec,
    shortUrlEnabled: form.shortUrlEnabled,
    autofixEchoimMissingMessages: form.autofixEchoimMissingMessages,
    devicesSectionEnabled: form.devicesSectionEnabled,
    sigintCommentParsingEnabled: form.sigintCommentParsingEnabled,
    doNotStoreDuplicateEchoimFailures: form.doNotStoreDuplicateEchoimFailures,
    goiAssociationMessageUidWorkerEnabled: form.goiAssociationMessageUidWorkerEnabled,
    reportChunkingHours: form.reportChunkingHours,
    reportGlobalConcurrency: form.reportGlobalConcurrency,
    reportKindConcurrency: form.reportKindConcurrency,
    reportEtalonkaConcurrency: form.reportEtalonkaConcurrency,
    limitBigReports: form.limitBigReports,
    enableAudioTranscription: form.enableAudioTranscription,
    pelengBoundsEnabled: form.pelengBoundsEnabled,
    pelengBoundsTopLeftLat: coordinateToPayload(form.pelengBoundsTopLeftLat),
    pelengBoundsTopLeftLng: coordinateToPayload(form.pelengBoundsTopLeftLng),
    pelengBoundsBottomRightLat: coordinateToPayload(form.pelengBoundsBottomRightLat),
    pelengBoundsBottomRightLng: coordinateToPayload(form.pelengBoundsBottomRightLng),
    echoRestapiErrorDiscordWebhookUrl: form.echoRestapiErrorDiscordWebhookUrl || null,
  };
}

function validateCoordinate(
  label: string,
  rawValue: string,
  min: number,
  max: number,
): string | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return `${label} не задана.`;

  const value = parseCoordinateInput(trimmed);
  if (value === null) return `${label} має бути числом.`;
  if (value < min || value > max) return `${label} має бути в межах від ${min} до ${max}.`;
  return null;
}

function validatePelengBounds(form: SystemSettingsForm): string | null {
  if (!form.pelengBoundsEnabled) return null;

  return (
    validateCoordinate('Широта верхнього лівого кута', form.pelengBoundsTopLeftLat, -90, 90) ??
    validateCoordinate('Довгота верхнього лівого кута', form.pelengBoundsTopLeftLng, -180, 180) ??
    validateCoordinate('Широта нижнього правого кута', form.pelengBoundsBottomRightLat, -90, 90) ??
    validateCoordinate('Довгота нижнього правого кута', form.pelengBoundsBottomRightLng, -180, 180)
  );
}

type CoordinateFieldProps = {
  disabled: boolean;
  label: string;
  onBlur: (value: string) => void;
  onChange: (value: string) => void;
  value: string;
};

function CoordinateField({ disabled, label, onBlur, onChange, value }: CoordinateFieldProps) {
  return (
    <TextField
      disabled={disabled}
      fullWidth
      label={label}
      type="text"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onBlur={(event) => {
        onBlur(event.target.value);
      }}
      inputProps={{ inputMode: 'decimal' }}
    />
  );
}

const mainSettingsGroupSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

const mainSettingsRowSx = {
  alignItems: 'center',
  margin: 0,
  gap: 1.5,
  '& .MuiFormControlLabel-label': { width: '100%' },
};

function MainSettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={mainSettingsGroupSx}>
      <Stack spacing={1.5}>
        <Typography
          component="h2"
          variant="overline"
          sx={{ color: 'text.secondary', letterSpacing: 0.8 }}
        >
          {title}
        </Typography>
        {children}
      </Stack>
    </Box>
  );
}

function MainSettingsSwitchRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <FormControlLabel
      sx={mainSettingsRowSx}
      control={<Switch checked={checked} onChange={(_, nextChecked) => onChange(nextChecked)} />}
      label={
        <Typography variant="body1" sx={{ fontWeight: 400, lineHeight: 1.35 }}>
          {label}
        </Typography>
      }
    />
  );
}

function ApiSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  return (
    <Stack spacing={2}>
      <Typography>Обмеження запитів для кожного користувача з роллю Api.</Typography>
      <TextField
        type="number"
        label="Інтервал поповнення одного запиту, мс"
        value={form.apiRateLimitReplenishIntervalMs}
        onChange={(event) =>
          patchForm({ apiRateLimitReplenishIntervalMs: Number(event.target.value) })
        }
        helperText="500 мс відповідає 2 запитам на секунду."
        slotProps={{ htmlInput: { min: 1, max: 2147483647, step: 1 } }}
      />
      <TextField
        type="number"
        label="Максимальний запас запитів"
        value={form.apiRateLimitBurstSize}
        onChange={(event) => patchForm({ apiRateLimitBurstSize: Number(event.target.value) })}
        helperText="Кількість запитів, які можна виконати поспіль без очікування."
        slotProps={{ htmlInput: { min: 1, max: 2147483647, step: 1 } }}
      />
    </Stack>
  );
}

function validateReportConcurrencySettings(form: SystemSettingsForm): string | null {
  return [
    form.reportGlobalConcurrency,
    form.reportKindConcurrency,
    form.reportEtalonkaConcurrency,
  ].every((value) => Number.isInteger(value) && value > 0 && value <= 2147483647)
    ? null
    : 'Кількість одночасних звітів має бути додатним цілим числом до 2147483647.';
}

function validateApiRateLimitSettings(form: SystemSettingsForm): string | null {
  if (
    ![form.apiRateLimitReplenishIntervalMs, form.apiRateLimitBurstSize].every(
      (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647,
    )
  ) {
    return 'API: інтервал поповнення та запас запитів мають бути додатними цілими числами в межах 2147483647.';
  }
  if (form.apiRateLimitReplenishIntervalMs * form.apiRateLimitBurstSize > 9223372036854) {
    return 'API: поєднання інтервалу поповнення та запасу запитів завелике.';
  }
  return null;
}

function MainSettingsSection({
  form,
  patchForm,
  audioTranscriptionSaved,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
  audioTranscriptionSaved: boolean;
}) {
  return (
    <Stack spacing={3}>
      <MainSettingsGroup title="Інтерфейс і значення за замовчуванням">
        <MainSettingsSwitchRow
          checked={form.exactMatchOnlyDefault}
          label="Прапорець «точний збіг за еталонкою» на Аналізі увімкнений"
          onChange={(checked) => patchForm({ exactMatchOnlyDefault: checked })}
        />
        <MainSettingsSwitchRow
          checked={form.defaultNeoAnalysis}
          label="Використовувати новий Аналіз за замовчуванням"
          onChange={(checked) => patchForm({ defaultNeoAnalysis: checked })}
        />
        <MainSettingsSwitchRow
          checked={!form.hideNetworks}
          label={
            <InfoLabel
              label="Режим РЕР"
              tooltip="показати радіомережі. групи за замовчуванням закриті, фільтри за замовчуванням відкриті. оптимізований дизайн картки перехопення під роботу РЕР"
            />
          }
          onChange={(checked) => patchForm({ hideNetworks: !checked })}
        />
        <MainSettingsSwitchRow
          checked={form.aiPositionHighlightsEnabled}
          label={
            <InfoLabel
              label="Показувати ШІ-позиції всім користувачам (Оперативний та Аналіз)"
              tooltip="Коли вимкнено, користувачі можуть увімкнути показ у своїх налаштуваннях. Розпізнавання позицій продовжує працювати."
            />
          }
          onChange={(checked) => patchForm({ aiPositionHighlightsEnabled: checked })}
        />
      </MainSettingsGroup>

      <MainSettingsGroup title="Безпека">
        <MainSettingsSwitchRow
          checked={form.twoFactorAuthEnabled}
          label="Двофакторна автентифікація (2FA)"
          onChange={(checked) => patchForm({ twoFactorAuthEnabled: checked })}
        />
      </MainSettingsGroup>

      <MainSettingsGroup title="Обробка повідомлень">
        <MainSettingsSwitchRow
          checked={form.disableBotTags}
          label={<InfoLabel label="Вимкнути теги бота" tooltip={DISABLE_BOT_TAGS_TOOLTIP} />}
          onChange={(checked) => patchForm({ disableBotTags: checked })}
        />
        <MainSettingsSwitchRow
          checked={form.enableAudioTranscription}
          label="Увімкнути транскрибування аудіо"
          onChange={(checked) => patchForm({ enableAudioTranscription: checked })}
        />
        {form.enableAudioTranscription && !audioTranscriptionSaved ? (
          <PowerAlert severity="info">
            Збережіть налаштування, щоб відкрити «Транскрибація» в меню «Адмін».
          </PowerAlert>
        ) : null}
        <MainSettingsSwitchRow
          checked={form.sigintCommentParsingEnabled}
          label="Парсити коментарі"
          onChange={(checked) => patchForm({ sigintCommentParsingEnabled: checked })}
        />
      </MainSettingsGroup>

      <MainSettingsGroup title="Можливості системи">
        <MainSettingsSwitchRow
          checked={form.supportNonRerInterceptions}
          label={
            <InfoLabel
              label="Підтримка альтернативних перехоплень"
              tooltip={SUPPORT_NON_RER_TOOLTIP}
            />
          }
          onChange={(checked) => patchForm({ supportNonRerInterceptions: checked })}
        />
        <MainSettingsSwitchRow
          checked={form.devicesSectionEnabled}
          label="Увімкнути розділ «Пристрої»"
          onChange={(checked) => patchForm({ devicesSectionEnabled: checked })}
        />
      </MainSettingsGroup>

      <MainSettingsGroup title="Службова обробка">
        <MainSettingsSwitchRow
          checked={form.doNotStoreDuplicateEchoimFailures}
          label="Не зберігати дублікати помилок Echo IM"
          onChange={(checked) => patchForm({ doNotStoreDuplicateEchoimFailures: checked })}
        />
        <MainSettingsSwitchRow
          checked={form.goiAssociationMessageUidWorkerEnabled}
          label="Заповнювати UID повідомлень висновків ГОІ"
          onChange={(checked) => patchForm({ goiAssociationMessageUidWorkerEnabled: checked })}
        />
      </MainSettingsGroup>
    </Stack>
  );
}

function ReportSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  return (
    <MainSettingsGroup title="Звіти">
      <TextField
        label="Одночасних звітів загалом"
        type="number"
        value={form.reportGlobalConcurrency}
        onChange={(event) => patchForm({ reportGlobalConcurrency: Number(event.target.value) })}
        inputProps={{ min: 1, max: 2147483647, step: 1 }}
        helperText="Зміни застосовуються до нових завдань. Поточні звіти завершуються без переривання."
      />
      <TextField
        label="Одночасних звітів кожного типу (крім еталонки)"
        type="number"
        value={form.reportKindConcurrency}
        onChange={(event) => patchForm({ reportKindConcurrency: Number(event.target.value) })}
        inputProps={{ min: 1, max: 2147483647, step: 1 }}
      />
      <TextField
        label="Одночасних звітів еталонки"
        type="number"
        value={form.reportEtalonkaConcurrency}
        onChange={(event) => patchForm({ reportEtalonkaConcurrency: Number(event.target.value) })}
        inputProps={{ min: 1, max: 2147483647, step: 1 }}
        helperText="Звіти еталонки одного користувача виконуються послідовно."
      />
      <TextField
        label={
          <InfoLabel label="Вікно обробки звітів (в годинах)" tooltip={REPORT_CHUNKING_TOOLTIP} />
        }
        type="number"
        value={form.reportChunkingHours}
        onChange={(event) => {
          const next = Number(event.target.value);
          patchForm({ reportChunkingHours: Number.isFinite(next) ? next : 24 });
        }}
        inputProps={{ min: 1, max: REPORT_CHUNKING_HOURS_MAX, step: 1 }}
      />

      <MainSettingsSwitchRow
        checked={form.limitBigReports}
        label="Обмежити неоптимізовані звіти лімітом в 10 тис. рядків"
        onChange={(checked) => patchForm({ limitBigReports: checked })}
      />
    </MainSettingsGroup>
  );
}

function DutySettingsSection({
  form,
  patchForm,
  onDutyTestEnabledChange,
  loading,
  saving,
  replayStatus,
  replayStatusError,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
  onDutyTestEnabledChange: (enabled: boolean) => void;
  loading: boolean;
  saving: boolean;
  replayStatus: RerDutyTestReplayStatus | null;
  replayStatusError: string | null;
}) {
  return (
    <>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Меню
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.dutyExcludeMenuEnabled}
            onChange={(_, checked) => patchForm({ dutyExcludeMenuEnabled: checked })}
          />
        }
        label="Меню «—» (мінус) в оперативному"
      />
      <FormControlLabel
        control={
          <Switch
            checked={form.showClassicDuty}
            onChange={(_, checked) => {
              patchForm({ showClassicDuty: checked });
            }}
          />
        }
        label="Показувати класичний оперативний"
      />

      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Тестові повідомлення
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.dutyTestEnabled}
            disabled={loading || saving}
            onChange={(_, checked) => {
              onDutyTestEnabledChange(checked);
            }}
          />
        }
        label={
          <InfoLabel
            label="Увімкнути тестове надходження повідомлень"
            tooltip={DUTY_TEST_ENABLED_TOOLTIP}
          />
        }
      />
      <PowerDateTimePicker
        label={<InfoLabel label="Дата старту" tooltip={DUTY_TEST_SINCE_TOOLTIP} />}
        value={dutyTestSinceDateTime(form.dutyTestSinceMs)}
        onChange={(value) => {
          patchForm({ dutyTestSinceMs: dutyTestSinceMs(value) });
        }}
        allowEmpty
      />
      <TextField
        label={<InfoLabel label="Ліміт повідомлень" tooltip={DUTY_TEST_LIMIT_TOOLTIP} />}
        type="number"
        value={form.dutyTestLimit}
        onChange={(event) => {
          const next = Number(event.target.value);
          patchForm({ dutyTestLimit: Number.isFinite(next) ? next : 1 });
        }}
        inputProps={{ min: 1, max: DUTY_TEST_SOURCE_MAX, step: 1 }}
        helperText="Мінімум 1"
      />
      <TextField
        label={
          <InfoLabel
            label="Інтервал тестових повідомлень (сек)"
            tooltip={DUTY_TEST_REPLAY_INTERVAL_TOOLTIP}
          />
        }
        type="number"
        value={form.dutyTestReplayIntervalSec}
        onChange={(event) => {
          const next = Number(event.target.value);
          patchForm({ dutyTestReplayIntervalSec: Number.isFinite(next) ? next : 1 });
        }}
        inputProps={{ min: 1, max: DUTY_TEST_REPLAY_INTERVAL_SEC_MAX, step: 1 }}
        helperText="Пауза між тестовими повідомленнями"
      />
      {replayStatusError ? <PowerAlert severity="error">{replayStatusError}</PowerAlert> : null}
      {replayStatus ? (
        <Box>
          <Typography variant="body2">
            Стан: {dutyTestReplayStatusLabel(replayStatus.status)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Джерело: {replayStatus.nextSourcePosition ?? 0}/{replayStatus.sourceCount}; створено:{' '}
            {replayStatus.generatedCount}
          </Typography>
          {replayStatus.nextEmitAtMs ? (
            <Typography variant="body2" color="text.secondary">
              Наступне повідомлення:{' '}
              {dayjs(replayStatus.nextEmitAtMs).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm:ss')}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      <TextField
        label={
          <InfoLabel
            label="Інтервал запиту нових повідомлень (сек)"
            tooltip={DUTY_POLL_INTERVAL_TOOLTIP}
          />
        }
        type="number"
        value={form.dutyPollIntervalSec}
        onChange={(event) => {
          const next = Number(event.target.value);
          patchForm({
            dutyPollIntervalSec: Number.isFinite(next) ? next : DUTY_POLL_INTERVAL_SEC_MIN,
          });
        }}
        inputProps={{ min: DUTY_POLL_INTERVAL_SEC_MIN, step: 1 }}
        helperText="Як часто перевіряти нові повідомлення"
      />

      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Echo IM
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={form.autofixEchoimMissingMessages}
            onChange={(_, checked) => {
              patchForm({ autofixEchoimMissingMessages: checked });
            }}
          />
        }
        label="Автоматично відновлювати відсутні Echo IM повідомлення"
      />

      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Короткий URL
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={form.shortUrlEnabled}
            onChange={(_, checked) => {
              patchForm({ shortUrlEnabled: checked });
            }}
          />
        }
        label="Увімкнути короткий URL для оперативного"
      />
    </>
  );
}

function AnalysisSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  return (
    <>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Меню
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.showClassicAnalysis}
            onChange={(_, checked) => {
              patchForm({ showClassicAnalysis: checked });
            }}
          />
        }
        label="Показувати класичний аналіз"
      />
      <FormControlLabel
        control={
          <Switch
            checked={form.analysisAorFilterEnabled}
            onChange={(_, checked) => patchForm({ analysisAorFilterEnabled: checked })}
          />
        }
        label="Фільтр смуг"
      />
    </>
  );
}

function PelengSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  const coordinateFieldsDisabled = !form.pelengBoundsEnabled;

  return (
    <>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Пеленги
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.showPelengDistanceToBattleline}
            onChange={(_, checked) => {
              patchForm({ showPelengDistanceToBattleline: checked });
            }}
          />
        }
        label="Показувати відстань пеленга до ЛБЗ"
      />
      <FormControlLabel
        control={
          <Switch
            checked={form.pelengBoundsEnabled}
            onChange={(_, checked) => {
              patchForm({ pelengBoundsEnabled: checked });
            }}
          />
        }
        label="Обмежити пеленги квадратом"
      />
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        }}
      >
        <CoordinateField
          disabled={coordinateFieldsDisabled}
          label="Широта верхнього лівого кута"
          value={form.pelengBoundsTopLeftLat}
          onChange={(value) => {
            patchForm({ pelengBoundsTopLeftLat: value });
          }}
          onBlur={(value) => {
            patchForm({ pelengBoundsTopLeftLat: normalizeCoordinateInput(value) });
          }}
        />
        <CoordinateField
          disabled={coordinateFieldsDisabled}
          label="Довгота верхнього лівого кута"
          value={form.pelengBoundsTopLeftLng}
          onChange={(value) => {
            patchForm({ pelengBoundsTopLeftLng: value });
          }}
          onBlur={(value) => {
            patchForm({ pelengBoundsTopLeftLng: normalizeCoordinateInput(value) });
          }}
        />
        <CoordinateField
          disabled={coordinateFieldsDisabled}
          label="Широта нижнього правого кута"
          value={form.pelengBoundsBottomRightLat}
          onChange={(value) => {
            patchForm({ pelengBoundsBottomRightLat: value });
          }}
          onBlur={(value) => {
            patchForm({ pelengBoundsBottomRightLat: normalizeCoordinateInput(value) });
          }}
        />
        <CoordinateField
          disabled={coordinateFieldsDisabled}
          label="Довгота нижнього правого кута"
          value={form.pelengBoundsBottomRightLng}
          onChange={(value) => {
            patchForm({ pelengBoundsBottomRightLng: value });
          }}
          onBlur={(value) => {
            patchForm({ pelengBoundsBottomRightLng: normalizeCoordinateInput(value) });
          }}
        />
      </Box>
    </>
  );
}

function NotificationsSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  return (
    <>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Нотифікації
      </Typography>
      <TextField
        fullWidth
        label="Discord webhook для помилок Echo REST API"
        type="url"
        value={form.echoRestapiErrorDiscordWebhookUrl}
        onChange={(event) => {
          patchForm({
            echoRestapiErrorDiscordWebhookUrl: event.target.value,
          });
        }}
        onBlur={(event) => {
          patchForm({
            echoRestapiErrorDiscordWebhookUrl: event.target.value.trim(),
          });
        }}
        helperText="Порожнє значення вимикає Discord нотифікації"
      />
    </>
  );
}

type OrbitCleanupDialogStep = 'first-confirmation' | 'final-confirmation' | 'roadblocks' | null;

function OrbitIntegrationsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  const [dialogStep, setDialogStep] = useState<OrbitCleanupDialogStep>(null);
  const [cleanupInProgress, setCleanupInProgress] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [roadblocks, setRoadblocks] = useState<Array<{ id: number; name: string }>>([]);
  const { notify } = usePowerSnackbar();

  const closeDialog = () => {
    if (cleanupInProgress) return;
    setDialogStep(null);
    setCleanupError(null);
    setRoadblocks([]);
  };

  const runCleanup = async (ignoreActive: boolean) => {
    setCleanupInProgress(true);
    setCleanupError(null);
    try {
      const response = await cleanupOrbitOtherUnits(ignoreActive);
      if (!ignoreActive && response.activeUnits.length > 0) {
        setRoadblocks(response.activeUnits);
        setDialogStep('roadblocks');
        return;
      }
      notify({
        severity: 'success',
        message: `Видалено підрозділів: ${response.deletedCount}.`,
      });
      setDialogStep(null);
      setRoadblocks([]);
    } catch (error) {
      setCleanupError(`Помилка видалення: ${formatErrorMessage(error)}`);
    } finally {
      setCleanupInProgress(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Orbit
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.excludeOrbitOtherUnits}
            onChange={(event) => {
              patchForm({ excludeOrbitOtherUnits: event.target.checked });
            }}
          />
        }
        label="Не імпортувати підрозділи управління, штаби, полігони"
      />
      <Box>
        <PowerButton
          type="button"
          color="error"
          variant="contained"
          onClick={() => {
            setCleanupError(null);
            setDialogStep('first-confirmation');
          }}
        >
          Видалити підрозділи управління
        </PowerButton>
      </Box>

      <Dialog open={dialogStep !== null} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>
          {dialogStep === 'roadblocks' ? 'Операцію заблоковано' : 'Видалити підрозділи управління?'}
        </DialogTitle>
        <DialogContent>
          {cleanupError ? <PowerAlert severity="error">{cleanupError}</PowerAlert> : null}
          {dialogStep === 'first-confirmation' ? (
            <DialogContentText>
              Будуть видалені всі неактивні SIGINT-підрозділи, прив’язані до підрозділів Orbit типу
              «Інше». Записи Orbit залишаться.
            </DialogContentText>
          ) : null}
          {dialogStep === 'final-confirmation' ? (
            <DialogContentText>
              Ви впевнені? Цю операцію неможливо скасувати через інтерфейс.
            </DialogContentText>
          ) : null}
          {dialogStep === 'roadblocks' ? (
            <Stack spacing={1.5}>
              <PowerAlert severity="warning" autoHideDuration={null}>
                Спочатку видаліть ці активні підрозділи вручну або відв’яжіть їх від Orbit і
                виправте дані. Можна також проігнорувати їх і видалити лише неактивні підрозділи.
              </PowerAlert>
              <Stack component="ul" spacing={0.5} sx={{ my: 0, pl: 3 }}>
                {roadblocks.map((unit) => {
                  const href = `/rer-units/${unit.id}`;
                  return (
                    <Box component="li" key={unit.id}>
                      <Link
                        href={href}
                        onClick={(event) => handleNavigateWithinSpaClick(event, href)}
                      >
                        {unit.name}
                      </Link>
                    </Box>
                  );
                })}
              </Stack>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <PowerButton type="button" onClick={closeDialog} disabled={cleanupInProgress}>
            Скасувати
          </PowerButton>
          {dialogStep === 'first-confirmation' ? (
            <PowerButton
              type="button"
              color="error"
              variant="outlined"
              onClick={() => setDialogStep('final-confirmation')}
            >
              Продовжити
            </PowerButton>
          ) : null}
          {dialogStep === 'final-confirmation' ? (
            <PowerButton
              type="button"
              color="error"
              variant="contained"
              disabled={cleanupInProgress}
              startIcon={cleanupInProgress ? <CircularProgress size={18} /> : undefined}
              onClick={() => void runCleanup(false)}
            >
              Так, видалити
            </PowerButton>
          ) : null}
          {dialogStep === 'roadblocks' ? (
            <PowerButton
              type="button"
              color="error"
              variant="contained"
              disabled={cleanupInProgress}
              startIcon={cleanupInProgress ? <CircularProgress size={18} /> : undefined}
              onClick={() => void runCleanup(true)}
            >
              Ігнорувати та продовжити
            </PowerButton>
          ) : null}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function AdminSystemSettingsNeoPage() {
  const [rerSettingSaving, setRerSettingSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SystemSettingsTab>(readSystemSettingsTab);
  const [saved, setSaved] = useState<SystemSettingsForm>(EMPTY_FORM);
  const [form, setForm] = useState<SystemSettingsForm>(EMPTY_FORM);
  const [loadInProgress, setLoadInProgress] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [replayStatus, setReplayStatus] = useState<RerDutyTestReplayStatus | null>(null);
  const [replayStatusError, setReplayStatusError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    if (!window.location.hash) {
      replaceSystemSettingsTabUrl(readSystemSettingsTab());
    }

    const syncTabFromUrl = () => {
      setActiveTab(readSystemSettingsTab());
    };
    window.addEventListener('popstate', syncTabFromUrl);
    window.addEventListener('hashchange', syncTabFromUrl);

    return () => {
      window.removeEventListener('popstate', syncTabFromUrl);
      window.removeEventListener('hashchange', syncTabFromUrl);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'duty') return;
    let cancelled = false;
    let timeout: number | undefined;
    const loadReplayStatus = async () => {
      try {
        const status = await getRerDutyTestReplayStatus();
        if (cancelled) return;
        setReplayStatus(status);
        setReplayStatusError(null);
      } catch (error) {
        if (cancelled) return;
        setReplayStatusError(`Не вдалося завантажити стан: ${formatErrorMessage(error)}`);
      } finally {
        if (!cancelled) {
          timeout = window.setTimeout(() => {
            void loadReplayStatus();
          }, 2_000);
        }
      }
    };
    void loadReplayStatus();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [activeTab]);

  useEffect(() => {
    async function loadSystemSettings() {
      setLoadInProgress(true);
      setLoadError(null);

      try {
        const settings = await listSystemSettings();
        const activeSettings = settings.find((item) => !item.deleted);
        const nextForm = formFromSettings(activeSettings);
        setSaved(nextForm);
        setForm(nextForm);
      } catch (error) {
        setLoadError(`Помилка завантаження системних налаштувань: ${formatErrorMessage(error)}`);
      } finally {
        setLoadInProgress(false);
      }
    }

    loadSystemSettings();
  }, []);

  const isDirty = !formsEqual(form, saved);

  function patchForm(patch: Partial<SystemSettingsForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function saveSystemSettings(nextForm: SystemSettingsForm) {
    const payload = formToPayload(nextForm);
    await createSystemSettings({
      rerAnalysisUnitsExactMatchOnlyDefault: payload.exactMatchOnlyDefault,
      rerDutyTestEnabled: payload.dutyTestEnabled,
      rerDutyInsertHistoricalInterceptions: payload.dutyTestEnabled,
      rerDutyTestSinceMs: payload.dutyTestSinceMs,
      rerDutyTestLimit: payload.dutyTestLimit,
      rerDutyPollIntervalSec: payload.dutyPollIntervalSec,
      rerDutyTestReplayIntervalSec: payload.dutyTestReplayIntervalSec,
      rerDutyShortUrl: payload.shortUrlEnabled,
      rerReportEnabled: payload.rerReportEnabled,
      supportNonRerInterceptions: payload.supportNonRerInterceptions,
      defaultNeoAnalysis: payload.defaultNeoAnalysis,
      showClassicDuty: payload.showClassicDuty,
      showClassicAnalysis: payload.showClassicAnalysis,
      showPelengDistanceToBattleline: payload.showPelengDistanceToBattleline,
      disableBotTags: payload.disableBotTags,
      hideNetworks: payload.hideNetworks,
      dutyExcludeMenuEnabled: payload.dutyExcludeMenuEnabled,
      analysisAorFilterEnabled: payload.analysisAorFilterEnabled,
      aiPositionHighlightsEnabled: payload.aiPositionHighlightsEnabled,
      apiRateLimitReplenishIntervalMs: payload.apiRateLimitReplenishIntervalMs,
      apiRateLimitBurstSize: payload.apiRateLimitBurstSize,
      twoFactorAuthEnabled: payload.twoFactorAuthEnabled,
      excludeOrbitOtherUnits: payload.excludeOrbitOtherUnits,
      messengerMediaCacheMinFreeGib: payload.messengerMediaCacheMinFreeGib,
      messengerMediaCacheMaxSizeGib: payload.messengerMediaCacheMaxSizeGib,
      messengerMediaCacheRetentionHours: payload.messengerMediaCacheRetentionHours,
      messengerMediaCacheEnabled: payload.messengerMediaCacheEnabled,
      autofixEchoimMissingMessages: payload.autofixEchoimMissingMessages,
      devicesSectionEnabled: payload.devicesSectionEnabled,
      sigintCommentParsingEnabled: payload.sigintCommentParsingEnabled,
      doNotStoreDuplicateEchoimFailures: payload.doNotStoreDuplicateEchoimFailures,
      goiAssociationMessageUidWorkerEnabled: payload.goiAssociationMessageUidWorkerEnabled,
      reportChunkingHours: payload.reportChunkingHours,
      reportGlobalConcurrency: payload.reportGlobalConcurrency,
      reportKindConcurrency: payload.reportKindConcurrency,
      reportEtalonkaConcurrency: payload.reportEtalonkaConcurrency,
      limitBigReports: payload.limitBigReports,
      enableAudioTranscription: payload.enableAudioTranscription,
      pelengBoundsEnabled: payload.pelengBoundsEnabled,
      pelengBoundsTopLeftLat: payload.pelengBoundsTopLeftLat,
      pelengBoundsTopLeftLng: payload.pelengBoundsTopLeftLng,
      pelengBoundsBottomRightLat: payload.pelengBoundsBottomRightLat,
      pelengBoundsBottomRightLng: payload.pelengBoundsBottomRightLng,
      echoRestapiErrorDiscordWebhookUrl: payload.echoRestapiErrorDiscordWebhookUrl,
    });
  }

  async function handleDutyTestEnabledChange(enabled: boolean) {
    if (saveInProgress || loadInProgress) return;

    if (enabled) {
      patchForm({ dutyTestEnabled: true });
      return;
    }

    const nextForm = { ...saved, dutyTestEnabled: enabled };
    patchForm({ dutyTestEnabled: enabled });
    setSaveInProgress(true);
    setSaveError(null);

    try {
      await saveSystemSettings(nextForm);
      setSaved(nextForm);
      notify({ severity: 'success', message: 'Налаштування тестових повідомлень збережено.' });
      window.dispatchEvent(new Event('system-settings-saved'));
    } catch (error) {
      patchForm({ dutyTestEnabled: saved.dutyTestEnabled });
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }

  async function handleSaveSystemSettings(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress || rerSettingSaving) return;
    if (!isDirty) return;

    const nextForm = normalizeForm(form);
    const validationError =
      validateReportConcurrencySettings(nextForm) ??
      validateApiRateLimitSettings(nextForm) ??
      validateMediaCacheSettings(nextForm) ??
      validatePelengBounds(nextForm);
    if (validationError) {
      setForm(nextForm);
      setSaveError(validationError);
      return;
    }

    setSaveInProgress(true);
    setSaveError(null);

    try {
      await saveSystemSettings(nextForm);
      setForm(nextForm);
      setSaved(nextForm);
      notify({
        severity: 'success',
        message: 'Нове системне налаштування збережено.',
      });
      window.dispatchEvent(new Event('system-settings-saved'));
    } catch (error) {
      const message = `Помилка збереження: ${formatErrorMessage(error)}`;
      setSaveError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaveInProgress(false);
    }
  }

  return (
    <Box className="w-full">
      <Stack spacing={2} useFlexGap>
        <PageHeader title="Налаштування системи" />

        <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: 'none', overflow: 'hidden' }}>
          <Box component="form" onSubmit={handleSaveSystemSettings} noValidate>
            <Tabs
              value={activeTab}
              onChange={(_, value: SystemSettingsTab) => {
                if (value === activeTab) return;
                setActiveTab(value);
                replaceSystemSettingsTabUrl(value);
              }}
              variant="scrollable"
              allowScrollButtonsMobile
              sx={{
                minHeight: 48,
                borderBottom: 1,
                borderColor: 'divider',
                '& .MuiTab-root': {
                  minHeight: 48,
                  alignItems: 'center',
                  textAlign: 'center',
                },
              }}
            >
              <Tab
                value="main"
                label="Основні"
                id="system-settings-neo-tab-main"
                aria-controls="system-settings-neo-panel-main"
              />
              <Tab
                value="duty"
                label="Оперативний"
                id="system-settings-neo-tab-duty"
                aria-controls="system-settings-neo-panel-duty"
              />
              <Tab
                value="analysis"
                label="Аналіз"
                id="system-settings-neo-tab-analysis"
                aria-controls="system-settings-neo-panel-analysis"
              />
              <Tab
                value="reports"
                label="Звіти"
                id="system-settings-neo-tab-reports"
                aria-controls="system-settings-neo-panel-reports"
              />
              <Tab
                value="control"
                label="Керування"
                id="system-settings-neo-tab-control"
                aria-controls="system-settings-neo-panel-control"
              />
              <Tab
                value="pelengs"
                label="Пеленги"
                id="system-settings-neo-tab-pelengs"
                aria-controls="system-settings-neo-panel-pelengs"
              />
              <Tab
                value="api"
                label="API"
                id="system-settings-neo-tab-api"
                aria-controls="system-settings-neo-panel-api"
              />
              <Tab
                value="notifications"
                label="Нотифікації"
                id="system-settings-neo-tab-notifications"
                aria-controls="system-settings-neo-panel-notifications"
              />
              <Tab
                value="cache"
                label="КЕШ"
                id="system-settings-neo-tab-cache"
                aria-controls="system-settings-neo-panel-cache"
              />
              <Tab
                value="integrations"
                label="Інтеграції"
                id="system-settings-neo-tab-integrations"
                aria-controls="system-settings-neo-panel-integrations"
              />
            </Tabs>

            <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
              <Stack spacing={3} sx={{ width: '100%' }}>
                {loadError || saveError ? (
                  <Stack spacing={1}>
                    {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
                    {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
                  </Stack>
                ) : null}
                <Box>
                  <Box
                    id="system-settings-neo-panel-main"
                    role="tabpanel"
                    hidden={activeTab !== 'main'}
                    aria-labelledby="system-settings-neo-tab-main"
                  >
                    {activeTab === 'main' ? (
                      <Stack spacing={3}>
                        <MainSettingsSection
                          form={form}
                          patchForm={patchForm}
                          audioTranscriptionSaved={saved.enableAudioTranscription}
                        />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-cache"
                    role="tabpanel"
                    hidden={activeTab !== 'cache'}
                    aria-labelledby="system-settings-neo-tab-cache"
                  >
                    {activeTab === 'cache' ? (
                      <Stack spacing={3}>
                        <MediaCacheSettingsSection form={form} patchForm={patchForm} />
                        <CacheBackfillSection />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-duty"
                    role="tabpanel"
                    hidden={activeTab !== 'duty'}
                    aria-labelledby="system-settings-neo-tab-duty"
                  >
                    {activeTab === 'duty' ? (
                      <Stack spacing={3}>
                        <DutySettingsSection
                          form={form}
                          patchForm={patchForm}
                          onDutyTestEnabledChange={handleDutyTestEnabledChange}
                          loading={loadInProgress}
                          saving={saveInProgress}
                          replayStatus={replayStatus}
                          replayStatusError={replayStatusError}
                        />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-analysis"
                    role="tabpanel"
                    hidden={activeTab !== 'analysis'}
                    aria-labelledby="system-settings-neo-tab-analysis"
                  >
                    {activeTab === 'analysis' ? (
                      <Stack spacing={3}>
                        <AnalysisSettingsSection form={form} patchForm={patchForm} />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-reports"
                    role="tabpanel"
                    hidden={activeTab !== 'reports'}
                    aria-labelledby="system-settings-neo-tab-reports"
                  >
                    {activeTab === 'reports' ? (
                      <Stack spacing={3}>
                        <ReportSettingsSection form={form} patchForm={patchForm} />
                        <ReportWorkerRestart />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-control"
                    role="tabpanel"
                    hidden={activeTab !== 'control'}
                    aria-labelledby="system-settings-neo-tab-control"
                  >
                    {activeTab === 'control' ? <AdminControlPanelNeoSection /> : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-pelengs"
                    role="tabpanel"
                    hidden={activeTab !== 'pelengs'}
                    aria-labelledby="system-settings-neo-tab-pelengs"
                  >
                    {activeTab === 'pelengs' ? (
                      <Stack spacing={3}>
                        <PelengSettingsSection form={form} patchForm={patchForm} />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-api"
                    role="tabpanel"
                    hidden={activeTab !== 'api'}
                    aria-labelledby="system-settings-neo-tab-api"
                  >
                    {activeTab === 'api' ? (
                      <ApiSettingsSection form={form} patchForm={patchForm} />
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-notifications"
                    role="tabpanel"
                    hidden={activeTab !== 'notifications'}
                    aria-labelledby="system-settings-neo-tab-notifications"
                  >
                    {activeTab === 'notifications' ? (
                      <Stack spacing={3}>
                        <NotificationsSettingsSection form={form} patchForm={patchForm} />
                      </Stack>
                    ) : null}
                  </Box>

                  <Box
                    id="system-settings-neo-panel-integrations"
                    role="tabpanel"
                    hidden={activeTab !== 'integrations'}
                    aria-labelledby="system-settings-neo-tab-integrations"
                  >
                    {activeTab === 'integrations' ? (
                      <OrbitIntegrationsSection form={form} patchForm={patchForm} />
                    ) : null}
                  </Box>
                </Box>

                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    pt: 1,
                  }}
                >
                  <PowerButton
                    variant="contained"
                    type="submit"
                    disabled={saveInProgress || rerSettingSaving || loadInProgress || !isDirty}
                    startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                  >
                    зберегти
                  </PowerButton>
                </Box>
              </Stack>
            </CardContent>
          </Box>
        </Card>
        {activeTab === 'reports' ? (
          <Card variant="outlined" sx={{ borderRadius: 0, boxShadow: 'none', minWidth: 0 }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 2 }}>
                Звіт РЕР
              </Typography>
              <RerReportSettings
                disabled={saveInProgress}
                onSavingChange={setRerSettingSaving}
                onEnabledChange={(enabled) => {
                  setForm((previous) => ({ ...previous, rerReportEnabled: enabled }));
                  setSaved((previous) => ({ ...previous, rerReportEnabled: enabled }));
                }}
              />
            </CardContent>
          </Card>
        ) : null}
      </Stack>
    </Box>
  );
}

function validateMediaCacheSettings(form: SystemSettingsForm): string | null {
  const limits = [
    [form.messengerMediaCacheRetentionHours, 24, 8760],
    [form.messengerMediaCacheMaxSizeGib, 1, 1_048_576],
    [form.messengerMediaCacheMinFreeGib, 0, 1_048_576],
  ];
  if (
    limits.some(([value, min, max]) => !Number.isSafeInteger(value) || value < min || value > max)
  ) {
    return 'Кеш медіа: зберігання має бути від 24 до 8760 годин, розмір — від 1 до 1048576 ГіБ, резерв — від 0 до 1048576 ГіБ.';
  }
  return null;
}

function MediaCacheSettingsSection({
  form,
  patchForm,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
}) {
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Локальний кеш медіа</Typography>
      <Typography variant="body2" color="text.secondary">
        Зберігає нові вкладення повідомлень і файли пристроїв локально та готує відеовкладення
        повідомлень для відтворення на телефоні. Зміни застосовуються після збереження без
        перезапуску. Відновлення наявних вкладень повідомлень починається протягом 30 секунд.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={form.messengerMediaCacheEnabled}
            onChange={(_, checked) => patchForm({ messengerMediaCacheEnabled: checked })}
          />
        }
        label="Увімкнути локальний кеш медіа"
      />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField
          type="number"
          label="Зберігання медіа (години)"
          value={form.messengerMediaCacheRetentionHours}
          slotProps={{ htmlInput: { min: 24, max: 8760, step: 1 } }}
          onChange={(event) =>
            patchForm({ messengerMediaCacheRetentionHours: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          label="Максимальний розмір кешу (ГіБ)"
          value={form.messengerMediaCacheMaxSizeGib}
          slotProps={{ htmlInput: { min: 1, max: 1_048_576, step: 1 } }}
          onChange={(event) =>
            patchForm({ messengerMediaCacheMaxSizeGib: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          label="Резерв вільного місця (ГіБ)"
          value={form.messengerMediaCacheMinFreeGib}
          slotProps={{ htmlInput: { min: 0, max: 1_048_576, step: 1 } }}
          onChange={(event) =>
            patchForm({ messengerMediaCacheMinFreeGib: Number(event.target.value) })
          }
        />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Оригінали в межах строку зберігання не видаляються для звільнення місця. Якщо ліміту чи
        вільного місця недостатньо, нові вкладення завантажуються з віддаленого сховища. Зменшення
        ліміту не видаляє захищені файли; вимкнення зупиняє нове кешування.
      </Typography>
    </Stack>
  );
}
