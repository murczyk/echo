import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Tab,
  Tabs,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type {
  AiCallsignParseResultItem,
  AiCallsignTestMessageItem,
  AiCallsignWorkerSettingsItem,
} from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import {
  deleteAiCallsignTestMessage,
  getAiCallsignPage,
  recalculateAiCallsignParsing,
  resetAiCallsignPrompt,
  saveAiCallsignParsing,
  testAiCallsignParsing,
} from '../../services/api/ai-callsigns';
import type { AiCallsignAction } from './AiCallsignControls';
import { AiCallsignMessageEditor } from './AiCallsignMessageEditor';
import { AiCallsignPromptPanel } from './AiCallsignPromptPanel';
import { AiCallsignsTable } from './AiCallsignsTable';
import { AiCallsignWorkerSettings } from './AiCallsignWorkerSettings';

type AiCallsignScreen =
  { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; message: AiCallsignTestMessageItem };
type AiCallsignTab = 'prompt' | 'worker';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultKey(result: AiCallsignParseResultItem): string {
  return `${result.testMessageId}:${result.aiEngineId}`;
}

function mergeSavedResults(
  messages: AiCallsignTestMessageItem[],
  results: AiCallsignParseResultItem[],
): AiCallsignTestMessageItem[] {
  const replacements = new Map(results.map((result) => [resultKey(result), result]));
  return messages.map((message) => {
    const nextResults = new Map(
      message.results.map((result) => [result.aiEngineId, result] as const),
    );
    for (const result of replacements.values()) {
      if (result.testMessageId === message.id) {
        nextResults.set(result.aiEngineId, result);
      }
    }
    return { ...message, results: Array.from(nextResults.values()) };
  });
}

export function AdminAiCallsignsPage() {
  const [engines, setEngines] = useState<Awaited<ReturnType<typeof getAiCallsignPage>>['engines']>(
    [],
  );
  const [messages, setMessages] = useState<AiCallsignTestMessageItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [promptOverridden, setPromptOverridden] = useState(false);
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<AiCallsignParseResultItem[]>([]);
  const [workerSettings, setWorkerSettings] = useState<AiCallsignWorkerSettingsItem>({
    enabled: false,
    aiEngineId: null,
  });
  const [tab, setTab] = useState<AiCallsignTab>('prompt');
  const [promptPanelOpen, setPromptPanelOpen] = useState(true);
  const [screen, setScreen] = useState<AiCallsignScreen>({ kind: 'list' });
  const [deleteTarget, setDeleteTarget] = useState<AiCallsignTestMessageItem | null>(null);
  const [action, setAction] = useState<AiCallsignAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void loadPage();
  }, []);

  const canRun = Boolean(prompt.trim() && selectedEngineIds.length > 0 && messages.length > 0);

  async function loadPage() {
    setLoading(true);
    setError(null);
    try {
      const page = await getAiCallsignPage();
      setEngines(page.engines);
      setMessages(page.messages);
      setPrompt(page.prompt);
      setPromptOverridden(page.promptOverridden);
      setSelectedEngineIds(page.engines.map((engine) => engine.id));
      setWorkerSettings(page.worker);
    } catch (loadError) {
      setError(`Помилка завантаження ШІ-парсингу позивних: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  function updatePrompt(value: string) {
    setPrompt(value);
    setTestResults([]);
  }

  function updateSelectedEngines(ids: string[]) {
    setSelectedEngineIds(ids);
    setTestResults([]);
  }

  async function runTest() {
    if (!canRun || action) return;
    setTestResults([]);
    setAction('test');
    setError(null);
    try {
      const response = await testAiCallsignParsing({
        prompt: prompt.trim(),
        aiEngineIds: selectedEngineIds,
      });
      setTestResults(response.results);
    } catch (testError) {
      setError(`Помилка тестування позивних: ${errorMessage(testError)}`);
    } finally {
      setAction(null);
    }
  }

  async function save() {
    if (!prompt.trim() || action) return;
    setTestResults([]);
    setAction('save');
    setError(null);
    try {
      const response = await saveAiCallsignParsing({
        prompt: prompt.trim(),
        results: testResults,
      });
      setMessages((current) => mergeSavedResults(current, response.results));
      setTestResults([]);
      setPrompt(prompt.trim());
      setPromptOverridden(true);
      notify({ severity: 'success', message: 'Промпт і результати збережено.' });
    } catch (saveError) {
      setError(`Помилка збереження: ${errorMessage(saveError)}`);
    } finally {
      setAction(null);
    }
  }

  async function recalculate() {
    if (!canRun || action) return;
    setTestResults([]);
    setAction('recalculate');
    setError(null);
    try {
      const response = await recalculateAiCallsignParsing({
        prompt: prompt.trim(),
        aiEngineIds: selectedEngineIds,
      });
      setMessages((current) => mergeSavedResults(current, response.results));
      setTestResults([]);
      setPrompt(prompt.trim());
      setPromptOverridden(true);
      notify({ severity: 'success', message: 'Усі результати перераховано і збережено.' });
    } catch (recalculateError) {
      setError(`Помилка перерахунку: ${errorMessage(recalculateError)}`);
    } finally {
      setAction(null);
    }
  }

  async function resetPrompt() {
    if (action) return;
    setAction('reset');
    setError(null);
    try {
      const state = await resetAiCallsignPrompt();
      setPrompt(state.prompt);
      setPromptOverridden(state.promptOverridden);
      setTestResults([]);
      notify({ severity: 'success', message: 'Відновлено стандартний промпт.' });
    } catch (resetError) {
      setError(`Помилка скидання промпту: ${errorMessage(resetError)}`);
    } finally {
      setAction(null);
    }
  }

  function handleMessageSaved(message: AiCallsignTestMessageItem) {
    setMessages((current) => {
      const next = current.some((item) => item.id === message.id)
        ? current.map((item) => (item.id === message.id ? message : item))
        : [...current, message];
      return next.sort((left, right) => left.createdAt - right.createdAt);
    });
    setTestResults((current) => current.filter((result) => result.testMessageId !== message.id));
    setScreen({ kind: 'list' });
    notify({ severity: 'success', message: 'Тестове повідомлення збережено.' });
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAiCallsignTestMessage(deleteTarget.id);
      setMessages((current) => current.filter((message) => message.id !== deleteTarget.id));
      setTestResults((current) =>
        current.filter((result) => result.testMessageId !== deleteTarget.id),
      );
      setDeleteTarget(null);
      notify({ severity: 'success', message: 'Тестове повідомлення видалено.' });
    } catch (deleteError) {
      setError(`Помилка видалення повідомлення: ${errorMessage(deleteError)}`);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <CircularProgress />;
  }

  if (screen.kind === 'create') {
    return (
      <AiCallsignMessageEditor
        onBack={() => setScreen({ kind: 'list' })}
        onSaved={handleMessageSaved}
      />
    );
  }

  if (screen.kind === 'edit') {
    return (
      <AiCallsignMessageEditor
        message={screen.message}
        onBack={() => setScreen({ kind: 'list' })}
        onSaved={handleMessageSaved}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <PageHeader
        title="ШІ-парсинг позивних"
        titleActions={
          <Tabs
            value={tab}
            onChange={(_, value: AiCallsignTab) => setTab(value)}
            aria-label="Налаштування ШІ-парсингу позивних"
          >
            <Tab
              value="prompt"
              label="Промпт"
              id="ai-callsigns-tab-prompt"
              aria-controls="ai-callsigns-panel-prompt"
            />
            <Tab
              value="worker"
              label="Воркер"
              id="ai-callsigns-tab-worker"
              aria-controls="ai-callsigns-panel-worker"
            />
          </Tabs>
        }
        titleActionsGap={2}
        actions={
          tab === 'prompt' ? (
            <SidePanelToggleButton
              side="right"
              active={promptPanelOpen}
              label={promptPanelOpen ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
              onClick={() => setPromptPanelOpen((open) => !open)}
            />
          ) : null
        }
      />

      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      <Stack direction="row" spacing={2} alignItems="stretch">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            id="ai-callsigns-panel-prompt"
            role="tabpanel"
            aria-labelledby="ai-callsigns-tab-prompt"
            hidden={tab !== 'prompt'}
          >
            {tab === 'prompt' ? (
              <AiCallsignsTable
                engines={engines.filter((engine) => selectedEngineIds.includes(engine.id))}
                messages={messages}
                testResults={testResults}
                onCreate={() => {
                  setTestResults([]);
                  setScreen({ kind: 'create' });
                }}
                onDelete={(message) => {
                  setTestResults([]);
                  setDeleteTarget(message);
                }}
                onEdit={(message) => {
                  setTestResults([]);
                  setScreen({ kind: 'edit', message });
                }}
              />
            ) : null}
          </Box>

          <Box
            id="ai-callsigns-panel-worker"
            role="tabpanel"
            aria-labelledby="ai-callsigns-tab-worker"
            hidden={tab !== 'worker'}
          >
            {tab === 'worker' ? (
              <AiCallsignWorkerSettings
                engines={engines}
                settings={workerSettings}
                onSaved={setWorkerSettings}
              />
            ) : null}
          </Box>
        </Box>

        {tab === 'prompt' && promptPanelOpen ? (
          <AiCallsignPromptPanel
            action={action}
            canRun={canRun}
            engines={engines}
            prompt={prompt}
            promptOverridden={promptOverridden}
            selectedEngineIds={selectedEngineIds}
            onPromptChange={updatePrompt}
            onRecalculate={() => void recalculate()}
            onReset={() => void resetPrompt()}
            onSave={() => void save()}
            onSelectionChange={updateSelectedEngines}
            onTest={() => void runTest()}
          />
        ) : null}
      </Stack>

      <Dialog open={deleteTarget !== null} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>Видалити тестове повідомлення?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Повідомлення і всі збережені результати його парсингу будуть видалені.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <PowerButton type="button" variant="outlined" onClick={() => setDeleteTarget(null)}>
            Скасувати
          </PowerButton>
          <PowerButton
            type="button"
            variant="contained"
            color="error"
            disabled={deleting}
            onClick={() => void handleDelete()}
            startIcon={deleting ? <CircularProgress size={18} /> : undefined}
          >
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
