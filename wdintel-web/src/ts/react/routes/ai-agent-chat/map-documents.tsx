import { createContext, useEffect, useState } from 'react';
import type { AiAgentMapDocument, AiAgentMapSummary } from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { getAiAgentMap } from '../../services/api/ai-agent';

export const ConversationMapsContext = createContext<AiAgentMapSummary[]>([]);

export const MapSelectionContext = createContext<
  ((summary: AiAgentMapSummary, opener: HTMLElement) => void) | null
>(null);

export function useMapDocument(summary: AiAgentMapSummary, enabled = true) {
  const [document, setDocument] = useState<AiAgentMapDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    setDocument(null);
    setFailed(false);
    if (!enabled) return;
    const controller = new AbortController();
    void getAiAgentMap(summary, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setDocument(response);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFailed(true);
        notify({ severity: 'error', message: 'Не вдалося завантажити мапу. Спробуйте ще раз.' });
      });
    return () => controller.abort();
  }, [summary.requestId, summary.id, enabled, retry, notify]);
  return { document, failed, retry: () => setRetry((value) => value + 1) };
}
