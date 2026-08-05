import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  ButtonBase,
  Card,
  CardContent,
  CircularProgress,
  FormControlLabel,
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
import type { FormEvent } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerDateTimePicker } from '../../components/PowerDateTimePicker';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  createSystemSettings,
  getRerDutyTestReplayStatus,
  listSystemSettings,
  type RerDutyTestReplayStatus,
  type SystemSettingsItem,
} from '../../services/api/system-settings';
import { APP_TIME_ZONE } from '../../utils/misc';
import { AdminControlPanelNeoSection } from '../admin-control-panel-neo';
import { CacheBackfillSection } from './CacheBackfillSection';
import {
  readSystemSettingsTab,
  replaceSystemSettingsTabUrl,
  type SystemSettingsTab,
} from './url-state';

type SystemSettingsForm = {
  exactMatchOnlyDefault: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
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
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
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
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: number | null;
  pelengBoundsTopLeftLng: number | null;
  pelengBoundsBottomRightLat: number | null;
  pelengBoundsBottomRightLng: number | null;
  echoRestapiErrorDiscordWebhookUrl: string | null;
};

const EMPTY_FORM: SystemSettingsForm = {
  exactMatchOnlyDefault: true,
  supportNonRerInterceptions: false,
  defaultNeoAnalysis: false,
  showClassicDuty: true,
  showClassicAnalysis: true,
  dutyTestEnabled: false,
  dutyTestSinceMs: 0,
  dutyTestLimit: 1,
  dutyPollIntervalSec: 1,
  dutyTestReplayIntervalSec: 1,
  shortUrlEnabled: false,
  autofixEchoimMissingMessages: false,
  devicesSectionEnabled: false,
  sigintCommentParsingEnabled: true,
  doNotStoreDuplicateEchoimFailures: false,
  goiAssociationMessageUidWorkerEnabled: false,
  reportChunkingHours: 24,
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
  'Пауза між перевірками справжніх нових повідомлень в Оперативному.';
const DUTY_TEST_REPLAY_INTERVAL_TOOLTIP =
  'Пауза між тестовими повідомленнями. Перше повідомлення надходить одразу, після останнього цикл починається знову.';

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
    supportNonRerInterceptions: item?.supportNonRerInterceptions ?? false,
    defaultNeoAnalysis: item?.defaultNeoAnalysis ?? false,
    showClassicDuty: item?.showClassicDuty ?? true,
    showClassicAnalysis: item?.showClassicAnalysis ?? true,
    dutyTestEnabled: item?.rerDutyTestEnabled ?? false,
    dutyTestSinceMs: item?.rerDutyTestSinceMs ?? 0,
    dutyTestLimit: item?.rerDutyTestLimit ?? 1,
    dutyPollIntervalSec: item?.rerDutyPollIntervalSec ?? 1,
    dutyTestReplayIntervalSec: item?.rerDutyTestReplayIntervalSec ?? 1,
    shortUrlEnabled: item?.rerShortUrlEnabled ?? false,
    autofixEchoimMissingMessages: item?.autofixEchoimMissingMessages ?? false,
    devicesSectionEnabled: item?.devicesSectionEnabled ?? false,
    sigintCommentParsingEnabled: item?.sigintCommentParsingEnabled ?? true,
    doNotStoreDuplicateEchoimFailures: item?.doNotStoreDuplicateEchoimFailures ?? false,
    goiAssociationMessageUidWorkerEnabled: item?.goiAssociationMessageUidWorkerEnabled ?? false,
    reportChunkingHours: item?.reportChunkingHours ?? 24,
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
    a.supportNonRerInterceptions === b.supportNonRerInterceptions &&
    a.defaultNeoAnalysis === b.defaultNeoAnalysis &&
    a.showClassicDuty === b.showClassicDuty &&
    a.showClassicAnalysis === b.showClassicAnalysis &&
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
    dutyPollIntervalSec: Math.max(1, Math.floor(form.dutyPollIntervalSec) || 1),
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
    supportNonRerInterceptions: form.supportNonRerInterceptions,
    defaultNeoAnalysis: form.defaultNeoAnalysis,
    showClassicDuty: form.showClassicDuty,
    showClassicAnalysis: form.showClassicAnalysis,
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
    <>
      <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
        Активні значення за замовчуванням
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Switch
          sx={{ m: 0 }}
          checked={form.exactMatchOnlyDefault}
          onChange={(_, checked) => {
            patchForm({ exactMatchOnlyDefault: checked });
          }}
        />
        <ButtonBase
          component="button"
          type="button"
          onClick={() => {
            patchForm({ exactMatchOnlyDefault: !form.exactMatchOnlyDefault });
          }}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            textAlign: 'left',
            borderRadius: 0.5,
            typography: 'body1',
            fontWeight: 400,
            color: 'text.primary',
          }}
        >
          Прапорець «точний збіг за еталонкою» на аналізі увімкнений
        </ButtonBase>
      </Box>

      <FormControlLabel
        control={
          <Switch
            checked={form.enableAudioTranscription}
            onChange={(_, checked) => {
              patchForm({ enableAudioTranscription: checked });
            }}
          />
        }
        label="Увімкнути транскрибування аудіо"
      />
      {form.enableAudioTranscription && !audioTranscriptionSaved ? (
        <PowerAlert severity="info">
          Збережіть налаштування, щоб відкрити «Echo GPU Сервери» в меню «Адмін».
        </PowerAlert>
      ) : null}

      <FormControlLabel
        control={
          <Switch
            checked={form.supportNonRerInterceptions}
            onChange={(_, checked) => {
              patchForm({ supportNonRerInterceptions: checked });
            }}
          />
        }
        label={
          <InfoLabel
            label="Підтримка альтернативних перехоплень"
            tooltip={SUPPORT_NON_RER_TOOLTIP}
          />
        }
      />

      <FormControlLabel
        control={
          <Switch
            checked={form.defaultNeoAnalysis}
            onChange={(_, checked) => {
              patchForm({ defaultNeoAnalysis: checked });
            }}
          />
        }
        label="Використовувати новий аналіз за замовчуванням"
      />

      <FormControlLabel
        control={
          <Switch
            checked={form.devicesSectionEnabled}
            onChange={(_, checked) => {
              patchForm({ devicesSectionEnabled: checked });
            }}
          />
        }
        label="Увімкнути розділ Пристрої"
      />

      <FormControlLabel
        control={
          <Switch
            checked={form.sigintCommentParsingEnabled}
            onChange={(_, checked) => {
              patchForm({ sigintCommentParsingEnabled: checked });
            }}
          />
        }
        label="Парсити коментарі"
      />

      <FormControlLabel
        control={
          <Switch
            checked={form.doNotStoreDuplicateEchoimFailures}
            onChange={(_, checked) => {
              patchForm({ doNotStoreDuplicateEchoimFailures: checked });
            }}
          />
        }
        label="Не зберігати дублікати помилок Echo IM"
      />

      <FormControlLabel
        control={
          <Switch
            checked={form.goiAssociationMessageUidWorkerEnabled}
            onChange={(_, checked) => {
              patchForm({ goiAssociationMessageUidWorkerEnabled: checked });
            }}
          />
        }
        label="Заповнювати UID повідомлень висновків GOI"
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

      <FormControlLabel
        control={
          <Switch
            checked={form.limitBigReports}
            onChange={(_, checked) => {
              patchForm({ limitBigReports: checked });
            }}
          />
        }
        label="Обмежити неоптимізовані звіти лімітом в 10тис рядків"
      />
    </>
  );
}

function DutySettingsSection({
  form,
  patchForm,
  replayStatus,
  replayStatusError,
}: {
  form: SystemSettingsForm;
  patchForm: PatchSystemSettingsForm;
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
            onChange={(_, checked) => {
              patchForm({ dutyTestEnabled: checked });
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
          patchForm({ dutyPollIntervalSec: Number.isFinite(next) ? next : 1 });
        }}
        inputProps={{ min: 1, step: 1 }}
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
        label="Увімкнути которкий URL для оперативного"
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

export function AdminSystemSettingsNeoPage() {
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

  async function handleSaveSystemSettings(event?: FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;
    if (!isDirty) return;

    const nextForm = normalizeForm(form);
    const validationError = validatePelengBounds(nextForm);
    if (validationError) {
      setForm(nextForm);
      setSaveError(validationError);
      return;
    }

    setSaveInProgress(true);
    setSaveError(null);

    try {
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
        supportNonRerInterceptions: payload.supportNonRerInterceptions,
        defaultNeoAnalysis: payload.defaultNeoAnalysis,
        showClassicDuty: payload.showClassicDuty,
        showClassicAnalysis: payload.showClassicAnalysis,
        autofixEchoimMissingMessages: payload.autofixEchoimMissingMessages,
        devicesSectionEnabled: payload.devicesSectionEnabled,
        sigintCommentParsingEnabled: payload.sigintCommentParsingEnabled,
        doNotStoreDuplicateEchoimFailures: payload.doNotStoreDuplicateEchoimFailures,
        goiAssociationMessageUidWorkerEnabled: payload.goiAssociationMessageUidWorkerEnabled,
        reportChunkingHours: payload.reportChunkingHours,
        limitBigReports: payload.limitBigReports,
        enableAudioTranscription: payload.enableAudioTranscription,
        pelengBoundsEnabled: payload.pelengBoundsEnabled,
        pelengBoundsTopLeftLat: payload.pelengBoundsTopLeftLat,
        pelengBoundsTopLeftLng: payload.pelengBoundsTopLeftLng,
        pelengBoundsBottomRightLat: payload.pelengBoundsBottomRightLat,
        pelengBoundsBottomRightLng: payload.pelengBoundsBottomRightLng,
        echoRestapiErrorDiscordWebhookUrl: payload.echoRestapiErrorDiscordWebhookUrl,
      });
      setForm(nextForm);
      setSaved(nextForm);
      notify({
        severity: 'success',
        message: 'Нове системне налаштування збережено.',
      });
      window.dispatchEvent(new Event('system-settings-saved'));
    } catch (error) {
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
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
                    {activeTab === 'cache' ? <CacheBackfillSection /> : null}
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
                </Box>

                {activeTab !== 'cache' ? (
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
                      disabled={saveInProgress || loadInProgress || !isDirty}
                      startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                    >
                      зберегти
                    </PowerButton>
                  </Box>
                ) : null}
              </Stack>
            </CardContent>
          </Box>
        </Card>
      </Stack>
    </Box>
  );
}
