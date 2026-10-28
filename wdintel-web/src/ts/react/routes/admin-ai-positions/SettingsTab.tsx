import {
  Box,
  Card,
  CardContent,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiPositionPageRsp, TestAiPositionRsp } from '../../../../Bindings';
import { AiWorkerEngineSelect } from '../../components/AiWorkerEngineSelect';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  enqueueAiPositionBackfill,
  getAiPositionPage,
  saveAiPositionPrompt,
  saveAiPositionWorkerSettings,
  testAiPositions,
} from '../../services/api/ai-positions';

const DEFAULT_TEST_TEXT = 'Переміщення всл "Гудок" до "Циркон 9" (36T XT 75734 68963)';

const PENDING_REFRESH_MS = 5000;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function EngineSelect({
  page,
  value,
  onChange,
  label,
}: {
  page: AiPositionPageRsp;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <FormControl size="small" sx={{ minWidth: 260 }}>
      <InputLabel>{label}</InputLabel>
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {page.engines.map((engine) => (
          <MenuItem key={engine.id} value={engine.id}>
            {engine.name} ({engine.modelName})
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function TestResult({ result }: { result: TestAiPositionRsp }) {
  if (result.positions.length === 0) {
    return <Typography color="text.secondary">Позицій не знайдено.</Typography>;
  }
  return (
    <Stack spacing={1}>
      {result.positions.map((position) => (
        <Box key={position.nameKey}>
          <Typography fontWeight={600}>
            {position.name}{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              {position.nameKey} · згадок: {position.spans.length}
            </Typography>
          </Typography>
          {position.coordinates.map((coordinate) => (
            <Stack key={coordinate.mgrs} direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={coordinate.certainty} />
              <Typography variant="body2">
                {coordinate.text} → {coordinate.lat.toFixed(5)}, {coordinate.lng.toFixed(5)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {coordinate.evidence}
              </Typography>
            </Stack>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

export function SettingsTab() {
  const { notify } = usePowerSnackbar();
  const [page, setPage] = useState<AiPositionPageRsp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [workerEngineId, setWorkerEngineId] = useState('');
  const [fallbackEngineId, setFallbackEngineId] = useState('');
  const [testEngineId, setTestEngineId] = useState('');
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [testResult, setTestResult] = useState<TestAiPositionRsp | null>(null);
  const [backfillDays, setBackfillDays] = useState('7');

  async function load() {
    setError(null);
    try {
      const next = await getAiPositionPage();
      setPage(next);
      setPrompt(next.prompt);
      setWorkerEnabled(next.worker.enabled);
      setWorkerEngineId(next.worker.aiEngineId ?? '');
      setFallbackEngineId(next.worker.fallbackAiEngineId ?? '');
      setTestEngineId((current) => current || next.worker.aiEngineId || next.engines[0]?.id || '');
    } catch (loadError) {
      const message = `Не вдалося завантажити налаштування: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // The queue fills in the background after «Обробити наявні» and drains as
  // the worker runs; refresh only the count so unsaved edits stay.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void getAiPositionPage()
        .then((next) =>
          setPage((current) => (current ? { ...current, pendingJobs: next.pendingJobs } : current)),
        )
        // A failed refresh is retried on the next tick; load() reports errors.
        .catch(() => undefined);
    }, PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function run(action: () => Promise<string | null>, failure: string) {
    setBusy(true);
    try {
      const message = await action();
      if (message) notify({ severity: 'success', message });
    } catch (actionError) {
      notify({ severity: 'error', message: `${failure}: ${errorMessage(actionError)}` });
    } finally {
      setBusy(false);
    }
  }

  if (!page) {
    return error ? <PowerAlert severity="error">{error}</PowerAlert> : <PageLoadingState />;
  }

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Воркер</Typography>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <FormControlLabel
                control={
                  <Switch
                    checked={workerEnabled}
                    onChange={(event) => setWorkerEnabled(event.target.checked)}
                  />
                }
                label="Розпізнавати позиції в нових повідомленнях і документах"
              />
              <AiWorkerEngineSelect
                engines={page.engines}
                primaryId={workerEngineId}
                fallbackId={fallbackEngineId}
                required={workerEnabled}
                disabled={busy}
                onChange={(primaryId, fallbackId) => {
                  setWorkerEngineId(primaryId);
                  setFallbackEngineId(fallbackId);
                }}
              />
              <PowerButton
                variant="contained"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await saveAiPositionWorkerSettings({
                      enabled: workerEnabled,
                      aiEngineId: workerEngineId || null,
                      fallbackAiEngineId: fallbackEngineId || null,
                    });
                    await load();
                    return 'Налаштування воркера збережено';
                  }, 'Не вдалося зберегти воркер')
                }
              >
                Зберегти
              </PowerButton>
              <Typography variant="body2" color="text.secondary">
                У черзі: {page.pendingJobs}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={2} alignItems="center">
              <TextField
                size="small"
                type="number"
                label="Днів"
                value={backfillDays}
                onChange={(event) => setBackfillDays(event.target.value)}
                sx={{ width: 100 }}
              />
              <PowerButton
                variant="outlined"
                disabled={busy || !page.worker.enabled}
                onClick={() =>
                  void run(async () => {
                    await enqueueAiPositionBackfill({
                      days: Number(backfillDays),
                    });
                    await load();
                    return 'Постановку в чергу запущено, лічильник «У черзі» оновлюється';
                  }, 'Не вдалося поставити в чергу')
                }
              >
                Обробити наявні
              </PowerButton>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6">Промпт</Typography>
              {page.promptOverridden ? <Chip size="small" label="змінено" /> : null}
            </Stack>
            <TextField
              multiline
              minRows={8}
              maxRows={24}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <Stack direction="row" spacing={1}>
              <PowerButton
                variant="contained"
                disabled={busy || prompt === page.prompt}
                onClick={() =>
                  void run(async () => {
                    await saveAiPositionPrompt({ prompt });
                    await load();
                    return 'Промпт збережено';
                  }, 'Не вдалося зберегти промпт')
                }
              >
                Зберегти промпт
              </PowerButton>
              <PowerButton
                variant="outlined"
                disabled={busy || !page.promptOverridden}
                onClick={() =>
                  void run(async () => {
                    await saveAiPositionPrompt({ prompt: '' });
                    await load();
                    return 'Відновлено стандартний промпт';
                  }, 'Не вдалося відновити промпт')
                }
              >
                Стандартний промпт
              </PowerButton>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Перевірка</Typography>
            <TextField
              multiline
              minRows={3}
              label="Текст повідомлення"
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
            />
            <Stack direction="row" spacing={2} alignItems="center">
              <EngineSelect
                page={page}
                label="ШІ движок"
                value={testEngineId}
                onChange={setTestEngineId}
              />
              <PowerButton
                variant="contained"
                disabled={busy || !testEngineId || testText.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    setTestResult(
                      await testAiPositions({ prompt, aiEngineId: testEngineId, text: testText }),
                    );
                    return null;
                  }, 'Не вдалося перевірити')
                }
              >
                Перевірити з поточним промптом
              </PowerButton>
            </Stack>
            {testResult ? <TestResult result={testResult} /> : null}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
