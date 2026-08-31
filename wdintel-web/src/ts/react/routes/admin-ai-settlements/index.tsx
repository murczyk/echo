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
  AiSettlementParseResultItem,
  AiSettlementTestMessageItem,
  AiSettlementTestMessageVersionItem,
  AiSettlementWorkerSettingsItem,
} from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import {
  deleteAiSettlementTestMessage,
  getAiSettlementPage,
  recalculateAiSettlementParsing,
  resetAiSettlementPrompt,
  saveAiSettlementParsing,
  testAiSettlementParsing,
} from '../../services/api/ai-settlements';
import type { AiSettlementAction } from './AiSettlementControls';
import { AiSettlementMessageEditor } from './AiSettlementMessageEditor';
import { AiSettlementPromptPanel } from './AiSettlementPromptPanel';
import { AiSettlementsTable } from './AiSettlementsTable';
import { AiSettlementWorkerSettings } from './AiSettlementWorkerSettings';

type AiSettlementScreen =
  { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; message: AiSettlementTestMessageItem };
type AiSettlementTab = 'prompt' | 'worker';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultKey(result: AiSettlementParseResultItem): string {
  return `${result.testMessageId}:${result.aiEngineId}`;
}

function mergeSavedResults(
  messages: AiSettlementTestMessageItem[],
  results: AiSettlementParseResultItem[],
): AiSettlementTestMessageItem[] {
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

function replaceSavedResults(
  messages: AiSettlementTestMessageItem[],
  results: AiSettlementParseResultItem[],
): AiSettlementTestMessageItem[] {
  return messages.map((message) => ({
    ...message,
    results: results.filter((result) => result.testMessageId === message.id),
  }));
}

export function AdminAiSettlementsPage() {
  const [engines, setEngines] = useState<
    Awaited<ReturnType<typeof getAiSettlementPage>>['engines']
  >([]);
  const [messages, setMessages] = useState<AiSettlementTestMessageItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [promptOverridden, setPromptOverridden] = useState(false);
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<AiSettlementParseResultItem[]>([]);
  const [messageVersions, setMessageVersions] = useState<AiSettlementTestMessageVersionItem[]>([]);
  const [workerSettings, setWorkerSettings] = useState<AiSettlementWorkerSettingsItem>({
    enabled: false,
    aiEngineId: null,
  });
  const [tab, setTab] = useState<AiSettlementTab>('prompt');
  const [promptPanelOpen, setPromptPanelOpen] = useState(true);
  const [screen, setScreen] = useState<AiSettlementScreen>({ kind: 'list' });
  const [deleteTarget, setDeleteTarget] = useState<AiSettlementTestMessageItem | null>(null);
  const [action, setAction] = useState<AiSettlementAction | null>(null);
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
      const page = await getAiSettlementPage();
      setEngines(page.engines);
      setMessages(page.messages);
      setPrompt(page.prompt);
      setSavedPrompt(page.prompt);
      setPromptOverridden(page.promptOverridden);
      setSelectedEngineIds(page.engines.map((engine) => engine.id));
      setWorkerSettings(page.worker);
    } catch (loadError) {
      setError(`Помилка завантаження ШІ-парсингу населених пунктів: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  function updatePrompt(value: string) {
    setPrompt(value);
    setTestResults([]);
    setMessageVersions([]);
  }

  function updateSelectedEngines(ids: string[]) {
    setSelectedEngineIds(ids);
    setTestResults([]);
    setMessageVersions([]);
  }

  async function runTest() {
    if (!canRun || action) return;
    setTestResults([]);
    setMessageVersions([]);
    setAction('test');
    setError(null);
    try {
      const response = await testAiSettlementParsing({
        prompt: prompt.trim(),
        aiEngineIds: selectedEngineIds,
      });
      setTestResults(response.results);
      setMessageVersions(response.messageVersions);
    } catch (testError) {
      setError(`Помилка тестування населених пунктів: ${errorMessage(testError)}`);
    } finally {
      setAction(null);
    }
  }

  async function save() {
    if (!prompt.trim() || action) return;
    const promptToSave = prompt.trim();
    setAction('save');
    setError(null);
    try {
      const response = await saveAiSettlementParsing({
        prompt: promptToSave,
        results: testResults,
        messageVersions,
      });
      setMessages((current) =>
        promptToSave === savedPrompt
          ? mergeSavedResults(current, response.results)
          : replaceSavedResults(current, response.results),
      );
      setTestResults([]);
      setMessageVersions([]);
      setPrompt(promptToSave);
      setSavedPrompt(promptToSave);
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
    const promptToSave = prompt.trim();
    setTestResults([]);
    setMessageVersions([]);
    setAction('recalculate');
    setError(null);
    try {
      const response = await recalculateAiSettlementParsing({
        prompt: promptToSave,
        aiEngineIds: selectedEngineIds,
      });
      setMessages((current) =>
        promptToSave === savedPrompt
          ? mergeSavedResults(current, response.results)
          : replaceSavedResults(current, response.results),
      );
      setTestResults([]);
      setMessageVersions([]);
      setPrompt(promptToSave);
      setSavedPrompt(promptToSave);
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
      const state = await resetAiSettlementPrompt();
      if (state.prompt !== savedPrompt) {
        setMessages((current) => replaceSavedResults(current, []));
      }
      setPrompt(state.prompt);
      setSavedPrompt(state.prompt);
      setPromptOverridden(state.promptOverridden);
      setTestResults([]);
      setMessageVersions([]);
      notify({ severity: 'success', message: 'Відновлено стандартний промпт.' });
    } catch (resetError) {
      setError(`Помилка скидання промпту: ${errorMessage(resetError)}`);
    } finally {
      setAction(null);
    }
  }

  function handleMessageSaved(message: AiSettlementTestMessageItem) {
    setMessages((current) => {
      const next = current.some((item) => item.id === message.id)
        ? current.map((item) => (item.id === message.id ? message : item))
        : [...current, message];
      return next.sort((left, right) => left.createdAt - right.createdAt);
    });
    setTestResults((current) => current.filter((result) => result.testMessageId !== message.id));
    setMessageVersions([]);
    setScreen({ kind: 'list' });
    notify({ severity: 'success', message: 'Тестове повідомлення збережено.' });
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAiSettlementTestMessage(deleteTarget.id);
      setMessages((current) => current.filter((message) => message.id !== deleteTarget.id));
      setTestResults((current) =>
        current.filter((result) => result.testMessageId !== deleteTarget.id),
      );
      setMessageVersions([]);
      setDeleteTarget(null);
      notify({ severity: 'success', message: 'Тестове повідомлення видалено.' });
    } catch (deleteError) {
      setError(`Помилка видалення повідомлення: ${errorMessage(deleteError)}`);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <PageLoadingState />;
  }

  if (screen.kind === 'create') {
    return (
      <AiSettlementMessageEditor
        onBack={() => setScreen({ kind: 'list' })}
        onSaved={handleMessageSaved}
      />
    );
  }

  if (screen.kind === 'edit') {
    return (
      <AiSettlementMessageEditor
        message={screen.message}
        onBack={() => setScreen({ kind: 'list' })}
        onSaved={handleMessageSaved}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <PageHeader
        title="ШІ-парсинг населених пунктів"
        titleActions={
          <Tabs
            value={tab}
            onChange={(_, value: AiSettlementTab) => setTab(value)}
            aria-label="Налаштування ШІ-парсингу населених пунктів"
          >
            <Tab
              value="prompt"
              label="Промпт"
              id="ai-settlements-tab-prompt"
              aria-controls="ai-settlements-panel-prompt"
            />
            <Tab
              value="worker"
              label="Воркер"
              id="ai-settlements-tab-worker"
              aria-controls="ai-settlements-panel-worker"
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
            id="ai-settlements-panel-prompt"
            role="tabpanel"
            aria-labelledby="ai-settlements-tab-prompt"
            hidden={tab !== 'prompt'}
          >
            {tab === 'prompt' ? (
              <AiSettlementsTable
                engines={engines.filter((engine) => selectedEngineIds.includes(engine.id))}
                messages={messages}
                testResults={testResults}
                onCreate={() => {
                  setTestResults([]);
                  setMessageVersions([]);
                  setScreen({ kind: 'create' });
                }}
                onDelete={(message) => {
                  setTestResults([]);
                  setMessageVersions([]);
                  setDeleteTarget(message);
                }}
                onEdit={(message) => {
                  setTestResults([]);
                  setMessageVersions([]);
                  setScreen({ kind: 'edit', message });
                }}
              />
            ) : null}
          </Box>

          <Box
            id="ai-settlements-panel-worker"
            role="tabpanel"
            aria-labelledby="ai-settlements-tab-worker"
            hidden={tab !== 'worker'}
          >
            {tab === 'worker' ? (
              <AiSettlementWorkerSettings
                engines={engines}
                settings={workerSettings}
                onSaved={setWorkerSettings}
              />
            ) : null}
          </Box>
        </Box>

        {tab === 'prompt' && promptPanelOpen ? (
          <AiSettlementPromptPanel
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
        <DialogActions>
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
