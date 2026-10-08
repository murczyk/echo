import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDeviceFileErrorNotification } from '../../device-files/use-device-file-error-notification';

import type { DeviceAnalyticsSummaryRsp } from '../../../../../Bindings';
import { redirectToLogin } from '../../../auth-redirect';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { isAbortError, isUnauthorizedError } from '../../../services/api/client';
import { getDeviceAnalyticsSummary, reanalyzeDevice } from '../../../services/api/devices';
import { DeviceAnalyticsTagFilterControls } from '../../device-files/components/DeviceAnalyticsTagFilterControls';
import { toDeviceFileLoadError } from '../../device-files/helpers';
import type { DeviceAnalyticsTagFilter, DeviceFileLoadError } from '../../device-files/types';
import type { DeviceAnalyticsTagsState } from '../../device-files/use-device-analytics-tags';
import { useDeviceMobileLayout } from '../../devices/use-device-mobile-layout';

import { DeviceAnalyticsTagWidget, type AnalyticsWidgetSummary } from './DeviceAnalyticsTagWidget';

const fileCountFormatter = new Intl.NumberFormat('uk-UA');

export function DeviceAnalyticsPanel({
  deviceId,
  syncId = null,
  enabled,
  refreshVersion = 0,
  isAdmin,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  refreshVersion?: number;
  isAdmin: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const mobile = useDeviceMobileLayout();
  const [summaryVersion, setSummaryVersion] = useState(0);
  const [summary, setSummary] = useState<DeviceAnalyticsSummaryRsp | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  useDeviceFileErrorNotification(error?.message);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalysisMessage, setReanalysisMessage] = useState<string | null>(null);
  const [reanalysisError, setReanalysisError] = useState<string | null>(null);
  useDeviceFileErrorNotification(reanalysisError);
  const [reanalysisDialogOpen, setReanalysisDialogOpen] = useState(false);
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
      setSummaryVersion((value) => value + 1);
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
    const visibleSummaries: AnalyticsWidgetSummary[] = [];

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

  return (
    <Box
      component="section"
      aria-labelledby="device-analytics-title"
      sx={{ p: 2, height: '100%', minHeight: 0, overflow: 'auto' }}
    >
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
      <Stack spacing={2}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          justifyContent="space-between"
        >
          <Box>
            <Typography id="device-analytics-title" variant="h6">
              Аналітика файлів
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Динамічні теги синхронізованих файлів
            </Typography>
          </Box>
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ minWidth: 0, maxWidth: '100%' }}
          >
            <PowerIconButton
              aria-label="Оновити аналітичні відомості"
              disabled={loading}
              onClick={() => void loadSummary()}
            >
              <RefreshIcon fontSize="small" />
            </PowerIconButton>
            {isAdmin ? (
              <PowerButton
                size="small"
                variant="outlined"
                style={{ whiteSpace: 'normal' }}
                disabled={reanalyzing}
                onClick={() => setReanalysisDialogOpen(true)}
              >
                {reanalyzing ? 'Запуск…' : 'Запустити повторний аналіз пристрою'}
              </PowerButton>
            ) : null}
          </Stack>
        </Stack>

        {reanalysisMessage !== null ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            {reanalysisMessage}
          </PowerAlert>
        ) : null}

        {summary !== null ? (
          <Stack
            data-testid="device-analytics-progress"
            direction="row"
            spacing={1}
            useFlexGap
            flexWrap="wrap"
          >
            <Paper variant="outlined" sx={{ flex: '1 1 140px', minWidth: 0, px: 2, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                Файлів з контентом / усього
              </Typography>
              <Typography variant="h6">
                {fileCountFormatter.format(summary.filesWithContentCount)}/
                {fileCountFormatter.format(summary.totalFileCount)}
              </Typography>
            </Paper>
            <Paper variant="outlined" sx={{ flex: '1 1 140px', minWidth: 0, px: 2, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                Проаналізовано файлів
              </Typography>
              <Typography variant="h6">
                {fileCountFormatter.format(summary.analyzedFileCount)}
              </Typography>
            </Paper>
          </Stack>
        ) : null}

        <DeviceAnalyticsTagFilterControls
          tagsState={tagsState}
          filter={tagFilter}
          onChange={onTagFilterChange}
        />

        {error !== null ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton size="small" color="inherit" onClick={() => void loadSummary()}>
                Повторити
              </PowerButton>
            }
          >
            {error.message}
          </PowerAlert>
        ) : loading || tagsState.loading ? (
          <Box sx={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={28} aria-label="Завантаження аналітичних відомостей" />
          </Box>
        ) : summaries.length === 0 ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            {tagsState.tags.length === 0
              ? 'Активних аналітичних тегів ще немає.'
              : 'Файлів з активними аналітичними тегами ще немає.'}
          </PowerAlert>
        ) : (
          <Stack spacing={1}>
            {summaries.map((summary) => (
              <DeviceAnalyticsTagWidget
                key={`${summary.tag.id}:${summaryVersion}`}
                deviceId={deviceId}
                syncId={syncId}
                summary={summary}
                onUseAsFilter={(tagId) =>
                  onTagFilterChange({ tagIds: [tagId], tagMatch: 'any', untagged: false })
                }
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
