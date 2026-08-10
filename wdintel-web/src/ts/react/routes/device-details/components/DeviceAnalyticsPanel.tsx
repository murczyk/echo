import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalyticsTag,
  DeviceAnalyticsFile,
  DeviceAnalyticsSummaryRsp,
} from '../../../../../Bindings';
import { redirectToLogin } from '../../../auth-redirect';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { isAbortError, isUnauthorizedError } from '../../../services/api/client';
import {
  getDeviceAnalyticsSummary,
  listDeviceAnalyticsFiles,
  reanalyzeDevice,
} from '../../../services/api/devices';
import { DeviceAnalyticsTagFilterControls } from '../../device-files/components/DeviceAnalyticsTagFilterControls';
import { toDeviceFileLoadError } from '../../device-files/helpers';
import type { DeviceAnalyticsTagFilter, DeviceFileLoadError } from '../../device-files/types';
import type { DeviceAnalyticsTagsState } from '../../device-files/use-device-analytics-tags';
import { formatDeviceDateTime } from '../../devices/helpers';

const ANALYTICS_FILES_PAGE_SIZE = 10;
const fileCountFormatter = new Intl.NumberFormat('uk-UA');

type AnalyticsWidgetSummary = {
  tag: AnalyticsTag;
  fileCount: number;
  latestFileEntryCreatedAt: string | null;
};

function AnalyticsFilesList({ files }: { files: DeviceAnalyticsFile[] }) {
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {files.map((file, index) => (
        <Box key={file.fileId} component="li">
          {index > 0 ? <Divider /> : null}
          <Stack spacing={0.25} sx={{ px: 1.5, py: 1 }}>
            <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {file.name}
            </Typography>
            <Typography
              component="code"
              variant="caption"
              color="text.secondary"
              sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            >
              {file.absolutePath}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Додано: {formatDeviceDateTime(file.fileEntryCreatedAt)}
            </Typography>
          </Stack>
        </Box>
      ))}
    </Box>
  );
}

function DeviceAnalyticsTagWidget({
  deviceId,
  summary,
  onUseAsFilter,
}: {
  deviceId: string;
  summary: AnalyticsWidgetSummary;
  onUseAsFilter: (tagId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<DeviceAnalyticsFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  const loadedRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (append: boolean) => {
      const cursor = append ? nextCursorRef.current : null;
      if (append && cursor === null) return;
      const seq = ++requestSeqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const rsp = await listDeviceAnalyticsFiles(
          {
            deviceId,
            tagId: summary.tag.id,
            limit: ANALYTICS_FILES_PAGE_SIZE,
            cursor,
          },
          { signal: controller.signal },
        );
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;
        setFiles((current) => (append ? [...current, ...rsp.files] : rsp.files));
        nextCursorRef.current = rsp.nextCursor;
        setNextCursor(rsp.nextCursor);
        loadedRef.current = true;
      } catch (loadError) {
        if (requestSeqRef.current !== seq || controller.signal.aborted || isAbortError(loadError)) {
          return;
        }
        if (isUnauthorizedError(loadError)) {
          redirectToLogin();
          return;
        }
        setError(
          toDeviceFileLoadError(
            loadError,
            `Помилка завантаження файлів тегу «${summary.tag.name}»`,
          ),
        );
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [deviceId, summary.tag.id, summary.tag.name],
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    loadedRef.current = false;
    nextCursorRef.current = null;
    setExpanded(false);
    setFiles([]);
    setNextCursor(null);
    setLoading(false);
    setLoadingMore(false);
    setError(null);
    return () => abortRef.current?.abort();
  }, [deviceId, summary.tag.id]);

  return (
    <Accordion
      expanded={expanded}
      onChange={(_, nextExpanded) => {
        setExpanded(nextExpanded);
        if (nextExpanded && !loadedRef.current && !loading) void load(false);
      }}
      disableGutters
      variant="outlined"
      sx={{ '&:before': { display: 'none' } }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        aria-controls={`device-analytics-${summary.tag.id}-content`}
        id={`device-analytics-${summary.tag.id}-header`}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ sm: 'center' }}
          sx={{ minWidth: 0, width: '100%', pr: 1 }}
        >
          <Typography fontWeight={600} sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {summary.tag.name}
          </Typography>
          <PowerChip
            label={`${fileCountFormatter.format(summary.fileCount)} файлів`}
            color="default"
            interactive={false}
          />
          <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: 'auto' } }}>
            Останній файл: {formatDeviceDateTime(summary.latestFileEntryCreatedAt)}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails id={`device-analytics-${summary.tag.id}-content`} sx={{ pt: 0 }}>
        <Stack spacing={1.5}>
          <PowerButton
            size="small"
            variant="outlined"
            onClick={() => onUseAsFilter(summary.tag.id)}
            sx={{ alignSelf: 'flex-start' }}
          >
            Використати як фільтр
          </PowerButton>
          {loading ? (
            <Box sx={{ minHeight: 96, display: 'grid', placeItems: 'center' }}>
              <CircularProgress
                size={24}
                aria-label={`Завантаження файлів тегу ${summary.tag.name}`}
              />
            </Box>
          ) : error !== null ? (
            <PowerAlert
              severity="error"
              autoHideDuration={null}
              action={
                <PowerButton size="small" color="inherit" onClick={() => void load(false)}>
                  Повторити
                </PowerButton>
              }
            >
              {error.message}
            </PowerAlert>
          ) : files.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Файлів із цим тегом немає.
            </Typography>
          ) : (
            <Paper variant="outlined" sx={{ maxHeight: 360, overflow: 'auto' }}>
              <AnalyticsFilesList files={files} />
            </Paper>
          )}
          {nextCursor !== null ? (
            <PowerButton
              size="small"
              variant="outlined"
              disabled={loadingMore}
              onClick={() => void load(true)}
              sx={{ alignSelf: 'center' }}
            >
              {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
            </PowerButton>
          ) : null}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function DeviceAnalyticsPanel({
  deviceId,
  enabled,
  isAdmin,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  deviceId: string;
  enabled: boolean;
  isAdmin: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const [summary, setSummary] = useState<DeviceAnalyticsSummaryRsp | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalysisMessage, setReanalysisMessage] = useState<string | null>(null);
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
      const rsp = await getDeviceAnalyticsSummary({ deviceId }, { signal: controller.signal });
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
  }, [deviceId, enabled]);

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
  }, [deviceId, enabled, loadSummary]);

  const summaries = useMemo(() => {
    const summaryByTagId = new Map((summary?.items ?? []).map((item) => [item.tag.id, item]));
    return tagsState.tags.map<AnalyticsWidgetSummary>((tag) => {
      const item = summaryByTagId.get(tag.id);
      return {
        tag,
        fileCount: item?.fileCount ?? 0,
        latestFileEntryCreatedAt: item?.latestFileEntryCreatedAt ?? null,
      };
    });
  }, [summary, tagsState.tags]);

  const scheduleReanalysis = async () => {
    setReanalysisDialogOpen(false);
    setReanalyzing(true);
    setReanalysisMessage(null);
    try {
      const rsp = await reanalyzeDevice({ deviceId });
      setReanalysisMessage(
        rsp.scheduledFileCount > 0
          ? `Повторний аналіз запущено у фоновому режимі для ${fileCountFormatter.format(rsp.scheduledFileCount)} файлів.`
          : 'Немає завершених файлів, які можна поставити на повторний аналіз.',
      );
    } catch (scheduleError) {
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
        <DialogActions>
          <PowerButton onClick={() => setReanalysisDialogOpen(false)}>Скасувати</PowerButton>
          <PowerButton variant="contained" onClick={() => void scheduleReanalysis()}>
            Запустити аналіз
          </PowerButton>
        </DialogActions>
      </Dialog>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
          <Box>
            <Typography id="device-analytics-title" variant="h6">
              Аналітика файлів
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Динамічні теги синхронізованих файлів
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5} alignItems="center">
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
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
          >
            <Paper variant="outlined" sx={{ flex: 1, px: 2, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                Усього файлів
              </Typography>
              <Typography variant="h6">
                {fileCountFormatter.format(summary.totalFileCount)}
              </Typography>
            </Paper>
            <Paper variant="outlined" sx={{ flex: 1, px: 2, py: 1.5 }}>
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
            Активних аналітичних тегів ще немає.
          </PowerAlert>
        ) : (
          <Stack spacing={1}>
            {summaries.map((summary) => (
              <DeviceAnalyticsTagWidget
                key={summary.tag.id}
                deviceId={deviceId}
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
