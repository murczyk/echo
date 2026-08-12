import { Box, CircularProgress, LinearProgress, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { fetchBgtaskStatusAndLogs, getBgtaskProgressFromPercent } from '../../services/api/bgtask';
import { startGroupStatsCacheBackfill } from '../../services/api/cache-backfill';

type CacheBackfillTask = {
  id: number;
  running: boolean;
  progress: number;
  logs: string[];
  error: string | null;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CacheBackfillSection() {
  const [task, setTask] = useState<CacheBackfillTask | null>(null);
  const [startInProgress, setStartInProgress] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (task === null || !task.running) return;

    const taskId = task.id;
    let logs = [...task.logs];
    let active = true;
    let timeoutId: number | undefined;

    async function poll(skip: number) {
      if (!active) return;
      try {
        const response = await fetchBgtaskStatusAndLogs(taskId, skip);
        if (!active) return;
        logs = [...logs, ...response.loglines];
        const progress = getBgtaskProgressFromPercent(logs, response.progress);
        setTask({
          id: taskId,
          running: response.running,
          progress: Math.round((progress.curr / progress.overall) * 100),
          logs,
          error: response.finishedWithError,
        });
        if (response.running) {
          timeoutId = window.setTimeout(() => void poll(logs.length), 1000);
        }
      } catch (error) {
        if (!active) return;
        const message = formatError(error);
        setTask((current) =>
          current === null ? null : { ...current, running: false, error: message },
        );
        setStatusError(`Не вдалося отримати стан перерахунку кешу: ${message}`);
      }
    }

    void poll(logs.length);
    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [task?.id]);

  async function handleStart() {
    if (startInProgress || task?.running) return;
    setStartInProgress(true);
    setStatusError(null);
    try {
      const taskId = await startGroupStatsCacheBackfill();
      setTask({
        id: taskId,
        running: true,
        progress: 0,
        logs: [],
        error: null,
      });
    } catch (error) {
      setStatusError(`Не вдалося запустити перерахунок кешу: ${formatError(error)}`);
    } finally {
      setStartInProgress(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">Кеш статистики</Typography>
        <Typography variant="body2" color="text.secondary">
          Перераховує агреговані дані за весь період зберігання. Спочатку оновлюються найновіші
          дані.
        </Typography>
      </Box>

      {statusError ? <PowerAlert severity="error">{statusError}</PowerAlert> : null}
      {task?.error ? (
        <PowerAlert severity="error">Перерахунок завершився з помилкою: {task.error}</PowerAlert>
      ) : null}
      {task !== null && !task.running && task.error === null ? (
        <PowerAlert severity="success">Кеш статистики успішно перераховано.</PowerAlert>
      ) : null}

      <Box>
        <PowerButton
          type="button"
          variant="contained"
          disabled={startInProgress || task?.running === true}
          startIcon={startInProgress ? <CircularProgress size={18} /> : undefined}
          onClick={() => void handleStart()}
        >
          запустити перерахунок
        </PowerButton>
      </Box>

      {task !== null ? (
        <Stack spacing={1}>
          <Typography variant="body2">
            {task.running ? 'Перерахунок виконується' : 'Перерахунок завершено'} — {task.progress}%
          </Typography>
          <LinearProgress variant="determinate" value={task.progress} />
        </Stack>
      ) : null}

      <Box
        component="pre"
        aria-label="Вивід перерахунку кешу"
        aria-live="polite"
        sx={{
          minHeight: 180,
          maxHeight: 420,
          m: 0,
          p: 2,
          overflow: 'auto',
          bgcolor: '#111827',
          color: '#d1fae5',
          borderRadius: 1,
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {task?.logs.length ? task.logs.join('\n') : '$ Очікування запуску…'}
      </Box>
    </Stack>
  );
}
