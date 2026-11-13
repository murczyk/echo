import {
  Box,
  CircularProgress,
  FormControlLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  MessageReplayActivityBucket,
  MessageReplayActivityPoint,
  MessageReplayOnEnd,
  MessageReplayPlanReq,
  MessageReplayPreviewRsp,
  MessageReplaySessionRsp,
  MessageReplayShiftMode,
  MessageReplaySpeed,
  MessageReplayStatusRsp,
} from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerDateTimePicker } from '../../components/PowerDateTimePicker';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getMessageReplayActivity,
  getMessageReplayExtent,
  getMessageReplayStatus,
  pauseMessageReplay,
  previewMessageReplay,
  resumeMessageReplay,
  setMessageReplaySpeed,
  startMessageReplay,
  stopMessageReplay,
} from '../../services/api/message-replay';
import { APP_TIME_ZONE } from '../../utils/misc';
import {
  addDays,
  autoBucket,
  bucketMs,
  dayCounts,
  DURATION_OPTIONS,
  formatCount,
  fillBars,
  formatDate,
  formatDuration,
  formatKyiv,
  HOUR_MS,
  kyivDate,
  kyivMidnight,
  OVERVIEW_DAYS,
  SPAN_DAY_OPTIONS,
  SPEED_OPTIONS,
  speedLabel,
  windowFrom,
  type Bar,
  type MsRange,
} from './message-replay-helpers';
import { BarStrip, YearHeatmap, type BarTone } from './ReplayCharts';

const STATUS_POLL_MS = 2_000;
const PREVIEW_REFRESH_MS = 5_000;
const PREVIEW_DEBOUNCE_MS = 300;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography component="h2" variant="subtitle1" sx={{ m: 0, fontWeight: 600 }}>
      {children}
    </Typography>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Typography variant="body2">
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}:
      </Box>{' '}
      {children}
    </Typography>
  );
}

/** Activity points for `range` (`null` clears them). */
function useActivity(range: MsRange | null, bucket: MessageReplayActivityBucket) {
  const [points, setPoints] = useState<MessageReplayActivityPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = range?.[0];
  const to = range?.[1];

  useEffect(() => {
    if (from === undefined || to === undefined) {
      setPoints([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getMessageReplayActivity(from, to, bucket, { signal: controller.signal })
      .then((rsp) => setPoints(rsp.points))
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(`Не вдалося завантажити активність: ${errorMessage(loadError)}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, bucket]);

  return { points, loading, error };
}

export function MessageReplaySection() {
  const [status, setStatus] = useState<MessageReplayStatusRsp | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;
    const load = async () => {
      try {
        const next = await getMessageReplayStatus();
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
      } catch (error) {
        if (!cancelled) setStatusError(`Не вдалося завантажити стан: ${errorMessage(error)}`);
      } finally {
        if (!cancelled) timeout = window.setTimeout(() => void load(), STATUS_POLL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, []);

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Відтворення історичних повідомлень</SectionTitle>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Повідомлення з обраного періоду надходять як нові, з тим самим темпом (або пришвидшено) і
          з датами, зсунутими до поточного часу. Зупинка видаляє всі відтворені повідомлення. Час —
          київський.
        </Typography>
      </Box>
      {statusError ? <PowerAlert severity="error">{statusError}</PowerAlert> : null}
      {status === null ? (
        statusError ? null : (
          <CircularProgress size={24} />
        )
      ) : status.session ? (
        <ActiveReplay
          session={status.session}
          storedReplayCount={status.storedReplayCount}
          onStatus={setStatus}
        />
      ) : (
        <ReplayPlanner storedReplayCount={status.storedReplayCount} onStatus={setStatus} />
      )}
    </Stack>
  );
}

function ReplayPlanner({
  storedReplayCount,
  onStatus,
}: {
  storedReplayCount: number | null;
  onStatus: (status: MessageReplayStatusRsp) => void;
}) {
  const { notify } = usePowerSnackbar();
  const [extent, setExtent] = useState<{ firstDate: string; lastDate: string } | null>();
  const [extentError, setExtentError] = useState<string | null>(null);
  const [overviewEnd, setOverviewEnd] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayBucket, setDayBucket] = useState<MessageReplayActivityBucket>('Hour1');
  const [spanDays, setSpanDays] = useState(1);
  const [replayWindow, setReplayWindow] = useState<MsRange | null>(null);
  const [shiftMode, setShiftMode] = useState<MessageReplayShiftMode>('WindowStart');
  const [manualShiftHours, setManualShiftHours] = useState('24');
  const [speed, setSpeed] = useState<MessageReplaySpeed>('Speed100');
  const [onEnd, setOnEnd] = useState<MessageReplayOnEnd>('Loop');
  const [preview, setPreview] = useState<MessageReplayPreviewRsp | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getMessageReplayExtent({ signal: controller.signal })
      .then((rsp) => {
        if (rsp.firstMs === null || rsp.lastMs === null) {
          setExtent(null);
          return;
        }
        const lastDate = kyivDate(Math.min(rsp.lastMs, Date.now()));
        setExtent({ firstDate: kyivDate(rsp.firstMs), lastDate });
        setOverviewEnd(lastDate);
        setSelectedDate(lastDate);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setExtentError(`Не вдалося завантажити межі даних: ${errorMessage(error)}`);
        }
      });
    return () => controller.abort();
  }, []);

  const overviewFrom =
    extent && overviewEnd
      ? [extent.firstDate, addDays(overviewEnd, 1 - OVERVIEW_DAYS)].sort().at(-1)!
      : null;
  const overviewRange = useMemo<MsRange | null>(
    () =>
      overviewFrom && overviewEnd
        ? [kyivMidnight(overviewFrom), kyivMidnight(addDays(overviewEnd, 1))]
        : null,
    [overviewFrom, overviewEnd],
  );
  const overview = useActivity(overviewRange, 'Day1');
  const counts = useMemo(() => dayCounts(overview.points), [overview.points]);

  const stripRange = useMemo<MsRange | null>(
    () =>
      selectedDate
        ? [kyivMidnight(selectedDate), kyivMidnight(addDays(selectedDate, spanDays))]
        : null,
    [selectedDate, spanDays],
  );
  const strip = useActivity(stripRange, dayBucket);
  const stripBucketMs = bucketMs(dayBucket);
  const stripBars = useMemo(
    () => (stripRange ? fillBars(strip.points, stripRange, dayBucket) : []),
    [strip.points, stripRange, dayBucket],
  );
  const stripTones = useMemo<BarTone[]>(
    () =>
      stripBars.map((bar) =>
        replayWindow &&
        bar.startMs < replayWindow[1] &&
        bar.startMs + stripBucketMs > replayWindow[0]
          ? 'selected'
          : 'normal',
      ),
    [stripBars, stripBucketMs, replayWindow],
  );
  const stripSelection = useMemo<[number, number] | null>(() => {
    const first = stripTones.indexOf('selected');
    return first < 0 ? null : [first, stripTones.lastIndexOf('selected')];
  }, [stripTones]);

  // A newly selected day starts with 2 hours from its first message.
  useEffect(() => {
    if (!stripRange || strip.loading) return;
    if (replayWindow && replayWindow[0] < stripRange[1] && replayWindow[1] > stripRange[0]) return;
    const first = stripBars.find((bar) => bar.count > 0);
    if (first) setReplayWindow(windowFrom(first.startMs, 2 * HOUR_MS, Date.now()));
  }, [stripBars, stripRange, strip.loading, replayWindow]);
  const manualShiftMs = Math.round(Number(manualShiftHours.replace(',', '.')) * HOUR_MS);
  const plan = useMemo<MessageReplayPlanReq | null>(
    () =>
      replayWindow
        ? {
            fromMs: replayWindow[0],
            toMs: replayWindow[1],
            shiftMode,
            manualShiftMs: shiftMode === 'Manual' ? manualShiftMs : null,
            speed,
            onEnd,
          }
        : null,
    [replayWindow, shiftMode, manualShiftMs, speed, onEnd],
  );

  useEffect(() => {
    if (!plan) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      previewMessageReplay(plan, { signal })
        .then((rsp) => {
          setPreview(rsp);
          setPreviewError(null);
        })
        .catch((error) => {
          if (signal.aborted) return;
          setPreview(null);
          setPreviewError(errorMessage(error));
        });
    };
    const debounce = window.setTimeout(load, PREVIEW_DEBOUNCE_MS);
    const refresh = window.setInterval(load, PREVIEW_REFRESH_MS);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(refresh);
      controller.abort();
    };
  }, [plan]);

  function moveOverview(days: number) {
    if (!extent || !overviewEnd) return;
    const next = addDays(overviewEnd, days);
    const earliestEnd = addDays(extent.firstDate, OVERVIEW_DAYS - 1);
    setOverviewEnd(
      next > extent.lastDate ? extent.lastDate : next < earliestEnd ? earliestEnd : next,
    );
  }

  function selectBars(fromBar: Bar, toBar: Bar) {
    setReplayWindow(
      windowFrom(fromBar.startMs, toBar.startMs + stripBucketMs - fromBar.startMs, Date.now()),
    );
  }

  /** Moves the window start, keeping its length. */
  function setWindowStart(ms: number) {
    const length = replayWindow ? replayWindow[1] - replayWindow[0] : 2 * HOUR_MS;
    setReplayWindow(windowFrom(ms, length, Date.now()));
    if (!stripRange || ms < stripRange[0] || ms >= stripRange[1]) setSelectedDate(kyivDate(ms));
  }

  function setWindowLength(ms: number) {
    if (replayWindow) setReplayWindow(windowFrom(replayWindow[0], ms, Date.now()));
  }

  async function start() {
    if (!plan) return;
    setStarting(true);
    try {
      onStatus(await startMessageReplay(plan));
      notify({ severity: 'success', message: 'Відтворення запущено.' });
    } catch (error) {
      notify({ severity: 'error', message: `Не вдалося запустити: ${errorMessage(error)}` });
    } finally {
      setStarting(false);
    }
  }

  if (extentError) return <PowerAlert severity="error">{extentError}</PowerAlert>;
  if (extent === undefined) return <CircularProgress size={24} />;
  if (extent === null) {
    return <Typography variant="body2">Немає повідомлень, які можна відтворити.</Typography>;
  }

  return (
    <Stack spacing={3}>
      {storedReplayCount !== null && storedReplayCount > 0 ? (
        <PowerAlert severity="warning" dismissible={false} autoHideDuration={null}>
          У базі залишилось {formatCount(storedReplayCount)} відтворених повідомлень попередньої
          сесії. Їх буде видалено під час наступної зупинки.
        </PowerAlert>
      ) : null}

      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <SectionTitle>1. Оберіть день</SectionTitle>
          <Box sx={{ flexGrow: 1 }} />
          {overviewFrom && overviewEnd ? (
            <Typography variant="body2" color="text.secondary">
              {formatDate(overviewFrom)} – {formatDate(overviewEnd)}
            </Typography>
          ) : null}
          <PowerButton
            size="small"
            onClick={() => moveOverview(-OVERVIEW_DAYS)}
            disabled={!overviewFrom || overviewFrom <= extent.firstDate}
          >
            ← рік раніше
          </PowerButton>
          <PowerButton
            size="small"
            onClick={() => moveOverview(OVERVIEW_DAYS)}
            disabled={!overviewEnd || overviewEnd >= extent.lastDate}
          >
            рік пізніше →
          </PowerButton>
        </Stack>
        {overview.error ? <PowerAlert severity="error">{overview.error}</PowerAlert> : null}
        {overviewFrom && overviewEnd ? (
          <Box sx={{ position: 'relative' }}>
            <YearHeatmap
              fromDate={overviewFrom}
              toDate={overviewEnd}
              counts={counts}
              selectedDate={selectedDate}
              onSelect={setSelectedDate}
            />
            {overview.loading ? (
              <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0 }} />
            ) : null}
          </Box>
        ) : null}
      </Stack>

      {selectedDate ? (
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <SectionTitle>
              2. Виділіть вікно: {formatDate(selectedDate)} (
              {formatCount(counts.get(selectedDate) ?? 0)} повідомлень)
            </SectionTitle>
            <Box sx={{ flexGrow: 1 }} />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={spanDays}
              onChange={(_, value: number | null) => value && setSpanDays(value)}
              aria-label="Скільки днів показати"
            >
              {SPAN_DAY_OPTIONS.map((days) => (
                <ToggleButton key={days} value={days}>
                  {days === 1 ? '1 день' : `${days} дн.`}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={dayBucket}
              onChange={(_, value: MessageReplayActivityBucket | null) =>
                value && setDayBucket(value)
              }
              aria-label="Розмір стовпчика"
            >
              <ToggleButton value="Hour1">1 год</ToggleButton>
              <ToggleButton value="Minutes15">15 хв</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {strip.error ? <PowerAlert severity="error">{strip.error}</PowerAlert> : null}
          <Box sx={{ position: 'relative' }}>
            <BarStrip
              ariaLabel="Кількість повідомлень в обраних днях"
              bars={stripBars}
              bucketMs={stripBucketMs}
              tones={stripTones}
              selected={stripSelection}
              onSelect={selectBars}
            />
            {strip.loading ? (
              <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0 }} />
            ) : null}
          </Box>
          <Typography variant="body2" color="text.secondary">
            Протягніть мишею по стовпчиках, щоб виділити вікно, або вкажіть початок і тривалість.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <PowerDateTimePicker
              label="Початок"
              value={replayWindow ? dayjs(replayWindow[0]).tz(APP_TIME_ZONE) : null}
              onChange={(value) => {
                if (value?.isValid()) setWindowStart(value.tz(APP_TIME_ZONE, true).valueOf());
              }}
              ampm={false}
            />
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Тривалість
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={replayWindow ? replayWindow[1] - replayWindow[0] : null}
                onChange={(_, value: number | null) => value && setWindowLength(value)}
                aria-label="Тривалість"
                sx={{ flexWrap: 'wrap' }}
              >
                {DURATION_OPTIONS.map((option) => (
                  <ToggleButton key={option.ms} value={option.ms}>
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
          </Stack>
        </Stack>
      ) : null}

      {replayWindow ? (
        <Stack spacing={2}>
          <SectionTitle>3. Параметри</SectionTitle>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Звідки почати
            </Typography>
            <RadioGroup
              value={shiftMode}
              onChange={(_, value) => setShiftMode(value as MessageReplayShiftMode)}
            >
              <FormControlLabel
                value="WindowStart"
                control={<Radio size="small" />}
                label="З початку вікна — перше повідомлення надійде одразу"
              />
              <FormControlLabel
                value="SameTimeOfDay"
                control={<Radio size="small" />}
                label="Той самий час доби — з моменту вікна, що відповідає поточному київському часу"
              />
              <FormControlLabel
                value="Manual"
                control={<Radio size="small" />}
                label="Вручну — момент, що відстає від поточного часу на заданий зсув"
              />
            </RadioGroup>
            {shiftMode === 'Manual' ? (
              <TextField
                size="small"
                label="Зсув, годин"
                value={manualShiftHours}
                onChange={(event) => setManualShiftHours(event.target.value)}
                inputProps={{ inputMode: 'decimal' }}
                sx={{ mt: 1, maxWidth: 200 }}
              />
            ) : null}
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Швидкість
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={speed}
                onChange={(_, value: MessageReplaySpeed | null) => value && setSpeed(value)}
                aria-label="Швидкість"
              >
                {SPEED_OPTIONS.map((option) => (
                  <ToggleButton key={option.value} value={option.value}>
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Після кінця вікна
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={onEnd}
                onChange={(_, value: MessageReplayOnEnd | null) => value && setOnEnd(value)}
                aria-label="Після кінця вікна"
              >
                <ToggleButton value="Loop">почати знову</ToggleButton>
                <ToggleButton value="Pause">пауза</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </Stack>

          <SectionTitle>4. Перевірка</SectionTitle>
          <InfoRow label="Вікно">
            {formatKyiv(replayWindow[0])} – {formatKyiv(replayWindow[1])} (
            {formatDuration(replayWindow[1] - replayWindow[0])})
          </InfoRow>
          {previewError ? <PowerAlert severity="error">{previewError}</PowerAlert> : null}
          {preview ? (
            <Stack spacing={0.5}>
              <InfoRow label="Повідомлень у вікні">
                {formatCount(preview.windowCount)}; буде відтворено{' '}
                {formatCount(preview.replayCount)}
                {preview.skippedCount > 0
                  ? `, пропущено до точки старту ${formatCount(preview.skippedCount)}`
                  : ''}
              </InfoRow>
              <InfoRow label="Точка старту">
                {formatKyiv(preview.startPositionMs, true)} (зсув {formatDuration(preview.offsetMs)}
                )
              </InfoRow>
              {preview.firstMessageMs !== null ? (
                <InfoRow label="Перше повідомлення">
                  оригінал {formatKyiv(preview.firstMessageMs, true)}, надійде{' '}
                  {preview.firstMessageEtaMs
                    ? `через ${formatDuration(preview.firstMessageEtaMs)}`
                    : 'одразу'}
                  {preview.firstMessageShownMs !== null
                    ? ` з часом ${formatKyiv(preview.firstMessageShownMs, true)}`
                    : ''}
                </InfoRow>
              ) : (
                <InfoRow label="Перше повідомлення">
                  після точки старту у вікні немає повідомлень
                </InfoRow>
              )}
              <InfoRow label="Тривалість відтворення">
                {formatDuration(preview.cycleEndEtaMs)} при {speedLabel(speed)}
              </InfoRow>
            </Stack>
          ) : null}
          <Box>
            <PowerButton
              variant="contained"
              onClick={() => void start()}
              disabled={starting || !preview || preview.replayCount === 0}
              startIcon={starting ? <CircularProgress size={18} /> : undefined}
            >
              запустити відтворення
            </PowerButton>
          </Box>
        </Stack>
      ) : null}
    </Stack>
  );
}

const STATE_LABELS: Record<string, string> = {
  running: 'відтворюється',
  paused: 'на паузі',
  stopping: 'зупиняється, видалення відтворених повідомлень',
};

function ActiveReplay({
  session,
  storedReplayCount,
  onStatus,
}: {
  session: MessageReplaySessionRsp;
  storedReplayCount: number | null;
  onStatus: (status: MessageReplayStatusRsp) => void;
}) {
  const { notify } = usePowerSnackbar();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const windowRange = useMemo<MsRange>(
    () => [session.windowFromMs, session.windowToMs],
    [session.windowFromMs, session.windowToMs],
  );
  const bucket = autoBucket(windowRange);
  const activity = useActivity(windowRange, bucket);
  const bars = useMemo(
    () => fillBars(activity.points, windowRange, bucket),
    [activity.points, windowRange, bucket],
  );
  const tones = useMemo<BarTone[]>(
    () =>
      bars.map((bar) =>
        bar.startMs + bucketMs(bucket) <= session.replayPositionMs ? 'played' : 'normal',
      ),
    [bars, bucket, session.replayPositionMs],
  );
  const stopping = session.state === 'stopping';
  const paused = session.state === 'paused';
  const progress =
    ((session.replayPositionMs - session.windowFromMs) /
      (session.windowToMs - session.windowFromMs)) *
    100;

  async function run(action: () => Promise<MessageReplayStatusRsp>, failure: string) {
    setBusy(true);
    try {
      onStatus(await action());
    } catch (error) {
      notify({ severity: 'error', message: `${failure}: ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <SectionTitle>Стан: {STATE_LABELS[session.state] ?? session.state}</SectionTitle>
        {stopping ? <CircularProgress size={18} /> : null}
      </Stack>

      {stopping ? (
        <InfoRow label="Залишилось видалити">
          {storedReplayCount === null ? '…' : formatCount(storedReplayCount)} повідомлень
        </InfoRow>
      ) : (
        <>
          <LinearProgress
            variant="determinate"
            value={Math.max(0, Math.min(100, progress))}
            sx={{ height: 8 }}
          />
          <BarStrip
            ariaLabel="Вікно відтворення"
            bars={bars}
            bucketMs={bucketMs(bucket)}
            tones={tones}
          />
          <Stack spacing={0.5}>
            <InfoRow label="Вікно">
              {formatKyiv(session.windowFromMs)} – {formatKyiv(session.windowToMs)}
            </InfoRow>
            <InfoRow label="Поточна позиція">
              {formatKyiv(session.replayPositionMs, true)} (зсув {formatDuration(session.offsetMs)},{' '}
              {speedLabel(session.speed)})
            </InfoRow>
            <InfoRow label="Цикл">
              {session.completedCycles + 1}; після кінця вікна —{' '}
              {session.onEnd === 'Loop' ? 'почати знову' : 'пауза'}
            </InfoRow>
            <InfoRow label="Відтворено">
              {formatCount(session.replayedCount)}; залишилось у циклі{' '}
              {formatCount(session.remainingCount)}
            </InfoRow>
            {session.nextMessageMs !== null ? (
              <InfoRow label="Наступне повідомлення">
                оригінал {formatKyiv(session.nextMessageMs, true)}
                {session.nextMessageEtaMs !== null
                  ? `, через ${formatDuration(session.nextMessageEtaMs)}`
                  : ''}
                {paused ? ' після продовження' : ''}
              </InfoRow>
            ) : null}
            <InfoRow label="До кінця вікна">
              {formatDuration(session.cycleEndEtaMs)}
              {paused ? ' після продовження' : ''}
            </InfoRow>
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
            {paused ? (
              <PowerButton
                variant="contained"
                disabled={busy}
                onClick={() => void run(resumeMessageReplay, 'Не вдалося продовжити')}
              >
                продовжити
              </PowerButton>
            ) : (
              <PowerButton
                variant="outlined"
                disabled={busy}
                onClick={() => void run(pauseMessageReplay, 'Не вдалося поставити на паузу')}
              >
                пауза
              </PowerButton>
            )}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={session.speed}
              disabled={busy}
              onChange={(_, value: MessageReplaySpeed | null) => {
                if (value && value !== session.speed) {
                  void run(() => setMessageReplaySpeed(value), 'Не вдалося змінити швидкість');
                }
              }}
              aria-label="Швидкість"
            >
              {SPEED_OPTIONS.map((option) => (
                <ToggleButton key={option.value} value={option.value}>
                  {option.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Box sx={{ flexGrow: 1 }} />
            <PowerButton
              color="error"
              variant="outlined"
              disabled={busy}
              onClick={() => setConfirmStop(true)}
            >
              зупинити
            </PowerButton>
          </Stack>
        </>
      )}

      <ConfirmDangerDialog
        open={confirmStop}
        title="Зупинити відтворення?"
        description={`Буде видалено всі відтворені повідомлення (${formatCount(session.replayedCount)}) разом з їхніми коментарями, пеленгами та позначками.`}
        confirmLabel="Зупинити й видалити"
        submitting={busy}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void run(stopMessageReplay, 'Не вдалося зупинити');
        }}
      />
    </Stack>
  );
}
