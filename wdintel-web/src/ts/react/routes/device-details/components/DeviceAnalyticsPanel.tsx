import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDeviceFileErrorNotification } from '../../device-files/use-device-file-error-notification';

import type {
  DeviceAnalyticsSummaryItem,
  DeviceAnalyticsSummaryRsp,
} from '../../../../../Bindings';
import { redirectToLogin } from '../../../auth-redirect';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { isAbortError, isUnauthorizedError } from '../../../services/api/client';
import { getDeviceAnalyticsSummary, reanalyzeDevice } from '../../../services/api/devices';
import { DeviceStatsViews } from '../../devices/components/DeviceStatsViews';
import {
  countDeviceFileTypes,
  formatDeviceBytes,
  formatDeviceCount,
  isDeviceStatsIncomplete,
} from '../../devices/device-activity';
import { toDeviceFileLoadError } from '../../device-files/helpers';
import type { DeviceFileLoadError } from '../../device-files/types';
import type { DeviceAnalyticsTagsState } from '../../device-files/use-device-analytics-tags';
import { useDeviceMobileLayout } from '../../devices/use-device-mobile-layout';

import { useDeviceAudioActivity } from '../use-device-audio-activity';
import { DeviceAudioActivityView } from './DeviceAudioActivityView';
import { DeviceAnalyticsTagWidget } from './DeviceAnalyticsTagWidget';

const fileCountFormatter = new Intl.NumberFormat('uk-UA');

export function DeviceAnalyticsPanel({
  deviceId,
  syncId = null,
  enabled,
  refreshVersion = 0,
  isAdmin,
  tagsState,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  refreshVersion?: number;
  isAdmin: boolean;
  tagsState: DeviceAnalyticsTagsState;
}) {
  const mobile = useDeviceMobileLayout();
  const audio = useDeviceAudioActivity(deviceId, enabled, refreshVersion);
  const [summary, setSummary] = useState<DeviceAnalyticsSummaryRsp | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  useDeviceFileErrorNotification(error?.message);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalysisMessage, setReanalysisMessage] = useState<string | null>(null);
  const [reanalysisError, setReanalysisError] = useState<string | null>(null);
  useDeviceFileErrorNotification(reanalysisError);
  const [reanalysisDialogOpen, setReanalysisDialogOpen] = useState(false);
  const [statsExpanded, setStatsExpanded] = useState(true);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadSummary = useCallback(async () => {
    if (!enabled) return;
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const rsp = await getDeviceAnalyticsSummary(
        { deviceId, syncId },
        { signal: controller.signal },
      );
      if (requestSeqRef.current !== seq || controller.signal.aborted) return;
      setSummary(rsp);
    } catch (loadError) {
      if (requestSeqRef.current !== seq || controller.signal.aborted || isAbortError(loadError)) {
        return;
      }
      if (isUnauthorizedError(loadError)) {
        redirectToLogin();
        return;
      }
      setError(toDeviceFileLoadError(loadError, 'Помилка завантаження аналітичних відомостей'));
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [deviceId, syncId, enabled]);

  useEffect(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    setSummary(null);
    setError(null);
    setLoading(enabled);
    setReanalysisMessage(null);
    setReanalysisDialogOpen(false);
    if (enabled) void loadSummary();
    return () => abortRef.current?.abort();
  }, [deviceId, syncId, enabled, loadSummary, refreshVersion]);

  const summaries = useMemo(() => {
    const summaryByTagId = new Map((summary?.items ?? []).map((item) => [item.tag.id, item]));
    const visibleSummaries: DeviceAnalyticsSummaryItem[] = [];

    for (const tag of tagsState.tags) {
      const item = summaryByTagId.get(tag.id);
      if (item === undefined || item.fileCount <= 0) continue;
      visibleSummaries.push({
        tag,
        fileCount: item.fileCount,
        latestFileEntryCreatedAt: item.latestFileEntryCreatedAt,
      });
    }

    return visibleSummaries;
  }, [summary, tagsState.tags]);

  const scheduleReanalysis = async () => {
    setReanalysisDialogOpen(false);
    setReanalyzing(true);
    setReanalysisError(null);
    setReanalysisMessage(null);
    try {
      await reanalyzeDevice({ deviceId });
      setReanalysisMessage('Повторний аналіз запущено у фоновому режимі.');
    } catch (scheduleError) {
      setReanalysisError(
        toDeviceFileLoadError(scheduleError, 'Не вдалося запустити повторний аналіз').message,
      );
      setReanalysisMessage(
        toDeviceFileLoadError(scheduleError, 'Не вдалося запустити повторний аналіз').message,
      );
    } finally {
      setReanalyzing(false);
    }
  };

  const loadError = error ?? tagsState.error;

  return (
    <section aria-label="Відомості пристрою" className="min-w-0 px-echo-xs pb-echo-lg">
      <Dialog open={reanalysisDialogOpen} onClose={() => setReanalysisDialogOpen(false)}>
        <DialogTitle>Запустити повторний аналіз пристрою?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Усі вже проаналізовані файли пристрою буде поставлено в чергу. Обробка виконується у
            фоновому режимі.
          </DialogContentText>
        </DialogContent>
        <DialogActions
          className={mobile ? '!flex-col-reverse !items-stretch gap-echo-sm !p-echo-lg' : undefined}
        >
          <PowerButton
            className={mobile ? '!m-0 !min-h-echo-control-lg' : undefined}
            onClick={() => setReanalysisDialogOpen(false)}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            className={mobile ? '!m-0 !min-h-echo-control-lg' : undefined}
            variant="contained"
            onClick={() => void scheduleReanalysis()}
          >
            Запустити аналіз
          </PowerButton>
        </DialogActions>
      </Dialog>
      <div className="flex flex-col gap-echo-lg">
        {isAdmin ? (
          <div className="flex justify-end">
            <PowerButton
              size="small"
              variant="outlined"
              style={{ whiteSpace: 'normal' }}
              disabled={reanalyzing}
              onClick={() => setReanalysisDialogOpen(true)}
            >
              {reanalyzing ? 'Запуск…' : 'Запустити повторний аналіз пристрою'}
            </PowerButton>
          </div>
        ) : null}

        {reanalysisMessage !== null ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            {reanalysisMessage}
          </PowerAlert>
        ) : null}

        {summary !== null ? (
          <dl
            data-testid="device-analytics-progress"
            className="m-0 grid grid-cols-1 gap-echo-md echo-sm:grid-cols-2"
          >
            <div className="min-w-0 rounded-echo-lg border border-echo-divider-subtle p-echo-lg">
              <dt>
                <Typography variant="caption" color="text.secondary">
                  Файлів з контентом / усього
                </Typography>
              </dt>
              <Typography component="dd" variant="h5" className="!m-0 tabular-nums">
                {fileCountFormatter.format(summary.filesWithContentCount)}/
                {fileCountFormatter.format(summary.totalFileCount)}
              </Typography>
            </div>
            <div className="min-w-0 rounded-echo-lg border border-echo-divider-subtle p-echo-lg">
              <dt>
                <Typography variant="caption" color="text.secondary">
                  Завантажено аудіо
                </Typography>
              </dt>
              <Typography component="dd" variant="h5" className="!m-0 tabular-nums">
                {audio.loading ? (
                  <CircularProgress size={18} aria-label="Завантаження кількості аудіо" />
                ) : audio.value ? (
                  fileCountFormatter.format(audio.value.uploadedCount)
                ) : (
                  '—'
                )}
                {audio.error ? (
                  <PowerButton size="small" onClick={audio.reload}>
                    Повторити
                  </PowerButton>
                ) : null}
              </Typography>
            </div>
          </dl>
        ) : null}

        {summary !== null ? (
          <Accordion
            expanded={statsExpanded}
            onChange={(_, nextExpanded) => setStatsExpanded(nextExpanded)}
            disableGutters
            variant="outlined"
            data-testid="device-analytics-activity"
            className="!m-0 min-w-0 !rounded-echo-lg !border-echo-divider-subtle !bg-transparent before:!hidden"
          >
            <AccordionSummary
              expandIcon={<ChevronRightIcon />}
              className="!min-h-echo-control-lg"
              sx={{
                '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': {
                  transform: 'rotate(90deg)',
                },
              }}
              aria-controls="device-analytics-stats-content"
              id="device-analytics-stats-header"
            >
              <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-echo-sm py-echo-md pr-echo-sm">
                <Typography component="span" variant="body1">
                  Статистика завантажень
                </Typography>
                {summary.stats ? (
                  <span className="text-echo-base">
                    Тек: {formatDeviceCount(BigInt(summary.stats.directoryCount))} · Файлів:{' '}
                    {formatDeviceCount(BigInt(summary.filesWithContentCount))} · Типів:{' '}
                    {countDeviceFileTypes(summary.stats)} · Розмір:{' '}
                    {formatDeviceBytes(BigInt(summary.stats.contentBytes))}
                    {isDeviceStatsIncomplete(summary.stats, summary.totalFileCount)
                      ? ' · статистика неповна'
                      : ''}
                  </span>
                ) : (
                  <span className="text-echo-base">Аудіо за весь час</span>
                )}
              </div>
            </AccordionSummary>
            <AccordionDetails id="device-analytics-stats-content" className="!pt-0">
              <DeviceStatsViews
                stats={summary.stats ?? null}
                highlightSelection
                audio={<DeviceAudioActivityView activity={audio} />}
              />
            </AccordionDetails>
          </Accordion>
        ) : null}

        {loadError !== null ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton
                size="small"
                color="inherit"
                onClick={() => {
                  if (error !== null) void loadSummary();
                  if (tagsState.error !== null) void tagsState.reload();
                }}
              >
                Повторити
              </PowerButton>
            }
          >
            {loadError.message}
          </PowerAlert>
        ) : loading || tagsState.loading ? (
          <div className="grid min-h-echo-control-lg place-items-center p-echo-xl">
            <CircularProgress size={28} aria-label="Завантаження аналітичних відомостей" />
          </div>
        ) : summaries.length === 0 ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            {tagsState.tags.length === 0
              ? 'Активних аналітичних тегів ще немає.'
              : 'Файлів з активними аналітичними тегами ще немає.'}
          </PowerAlert>
        ) : (
          <ul
            aria-label="Аналітичні теги"
            className="m-0 grid list-none grid-cols-1 items-start gap-echo-md p-0 echo-md:grid-cols-2 echo-xl:grid-cols-3 echo-2xl:grid-cols-4"
          >
            {summaries.map((summary) => (
              <DeviceAnalyticsTagWidget key={summary.tag.id} summary={summary} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
