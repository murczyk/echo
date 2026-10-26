import { useEffect, useRef, useState } from 'react';
import type {
  AiTranscriptPage,
  AiTranscriptRunRsp,
  AiTranscriptTestMessage,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import * as api from '../../services/api/ai-transcript-analysis';

export enum Action {
  Load = 'load',
  Test = 'test',
  Save = 'save',
  Recalculate = 'recalculate',
  Reset = 'reset',
  Worker = 'worker',
  Message = 'message',
}

export function useTranscriptAnalysis() {
  const [page, setPage] = useState<AiTranscriptPage | null>(null);
  const [prompt, setPromptValue] = useState('');
  const [selected, setSelectedValue] = useState<string[]>([]);
  const [results, setResults] = useState<AiTranscriptRunRsp | null>(null);
  const [action, setAction] = useState<Action | null>(Action.Load);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  const mounted = useRef(true);
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const currentGeneration = ++generation.current;
    void api
      .getTranscriptAnalysisPage()
      .then((loaded) => {
        if (!mounted.current || generation.current !== currentGeneration) return;
        setPage(loaded);
        setPromptValue(loaded.prompt);
        setSelectedValue(loaded.engines.map((engine) => engine.id));
      })
      .catch((cause: unknown) => {
        if (!mounted.current || generation.current !== currentGeneration) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (mounted.current && generation.current === currentGeneration) setAction(null);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  async function perform(action: Action, operation: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setAction(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (!mounted.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      busy.current = false;
      if (mounted.current) setAction(null);
    }
  }

  function setPrompt(value: string) {
    setPromptValue(value);
    setResults(null);
  }
  function setSelected(value: string[]) {
    setSelectedValue(value);
    setResults(null);
  }

  async function reloadMessages() {
    const loaded = await api.getTranscriptAnalysisPage();
    if (!mounted.current) return;
    setPage((current) => current && { ...current, messages: loaded.messages });
    setResults(null);
  }

  const run = (recalculate: boolean) =>
    perform(recalculate ? Action.Recalculate : Action.Test, async () => {
      const response = await (
        recalculate ? api.recalculateTranscriptAnalysis : api.testTranscriptAnalysis
      )({ prompt, aiEngineIds: selected });
      if (!mounted.current) return;
      if (recalculate) {
        await reloadMessages();
        if (!mounted.current) return;
        setPage(
          (current) => current && { ...current, prompt: prompt.trim(), promptOverridden: true },
        );
        notify({ severity: 'success', message: 'Результати перераховано й збережено.' });
      } else setResults(response);
    });

  const save = () =>
    perform(Action.Save, async () => {
      await api.saveTranscriptAnalysis({
        prompt,
        results: results?.results ?? [],
        messageVersions: results?.messageVersions ?? [],
        engineVersions: results?.engineVersions ?? [],
      });
      if (!mounted.current) return;
      await reloadMessages();
      if (!mounted.current) return;
      setPage(
        (current) => current && { ...current, prompt: prompt.trim(), promptOverridden: true },
      );
      notify({ severity: 'success', message: 'Промпт і результати збережено.' });
    });

  const reset = () =>
    perform(Action.Reset, async () => {
      const response = await api.resetTranscriptAnalysisPrompt();
      if (!mounted.current) return;
      setPrompt(response.prompt);
      await reloadMessages();
      if (!mounted.current) return;
      setPage((current) => current && { ...current, ...response });
      notify({ severity: 'success', message: 'Стандартний промпт відновлено.' });
    });

  const saveWorker = () =>
    perform(Action.Worker, async () => {
      if (!page) return;
      const worker = await api.saveTranscriptWorker(page.worker);
      if (!mounted.current) return;
      setPage((current) => current && { ...current, worker });
      notify({ severity: 'success', message: 'Налаштування воркера збережено.' });
    });

  const saveMessage = (id: string | null, message: string, onSaved: () => void) =>
    perform(Action.Message, async () => {
      await api.saveTranscriptTestMessage({ id, message });
      if (!mounted.current) return;
      await reloadMessages();
      onSaved();
    });

  const deleteMessage = (message: AiTranscriptTestMessage, onDeleted: () => void) =>
    perform(Action.Message, async () => {
      await api.deleteTranscriptTestMessage(message.id);
      if (!mounted.current) return;
      await reloadMessages();
      onDeleted();
    });

  return {
    page,
    setPage,
    prompt,
    setPrompt,
    selected,
    setSelected,
    results,
    action,
    error,
    loading: action === Action.Load,
    disabled: action !== null,
    canRun: Boolean(prompt.trim() && selected.length && page?.messages.length),
    run,
    save,
    reset,
    saveWorker,
    saveMessage,
    deleteMessage,
  };
}
