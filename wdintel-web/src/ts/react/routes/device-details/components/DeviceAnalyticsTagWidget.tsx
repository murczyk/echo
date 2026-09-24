import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyticsTag, DeviceAnalyticsFile } from '../../../../../Bindings';
import { redirectToLogin } from '../../../auth-redirect';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { isAbortError, isUnauthorizedError } from '../../../services/api/client';
import { listDeviceAnalyticsFiles } from '../../../services/api/devices';
import { toDeviceFileLoadError } from '../../device-files/helpers';
import type { DeviceFileLoadError } from '../../device-files/types';
import { useDeviceFileErrorNotification } from '../../device-files/use-device-file-error-notification';
import { formatDeviceDateTime } from '../../devices/helpers';
import { useDeviceMobileLayout } from '../../devices/use-device-mobile-layout';

const ANALYTICS_FILES_PAGE_SIZE = 10;
const fileCountFormatter = new Intl.NumberFormat('uk-UA');

export type AnalyticsWidgetSummary = {
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

export function DeviceAnalyticsTagWidget({
  deviceId,
  syncId = null,
  summary,
  onUseAsFilter,
}: {
  deviceId: string;
  syncId?: string | null;
  summary: AnalyticsWidgetSummary;
  onUseAsFilter: (tagId: string) => void;
}) {
  const mobile = useDeviceMobileLayout();
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<DeviceAnalyticsFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  useDeviceFileErrorNotification(error?.message);
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
            syncId,
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
    [deviceId, syncId, summary.tag.id, summary.tag.name],
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
  }, [deviceId, syncId, summary.tag.id]);

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
        {mobile ? (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-echo-sm pr-echo-sm">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">
              {summary.tag.name}
            </span>
            <span className="shrink-0 text-echo-xs">
              {fileCountFormatter.format(summary.fileCount)}
            </span>
          </div>
        ) : (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            useFlexGap
            flexWrap="wrap"
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
        )}
      </AccordionSummary>
      <AccordionDetails id={`device-analytics-${summary.tag.id}-content`} sx={{ pt: 0 }}>
        <Stack spacing={1.5}>
          {mobile ? (
            <p className="m-0 text-echo-xs">
              Останній файл: {formatDeviceDateTime(summary.latestFileEntryCreatedAt)}
            </p>
          ) : null}
          <PowerButton
            size="small"
            variant="outlined"
            onClick={() => onUseAsFilter(summary.tag.id)}
            sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
            style={{ whiteSpace: 'normal' }}
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
              sx={{ alignSelf: 'center', maxWidth: '100%' }}
              style={{ whiteSpace: 'normal' }}
            >
              {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
            </PowerButton>
          ) : null}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
