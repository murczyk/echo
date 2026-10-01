import { createContext, useEffect, useState } from 'react';
import type { AiAgentMapDocument, AiAgentMapSummary } from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { getAiAgentMap } from '../../services/api/ai-agent';

export const ConversationMapsContext = createContext<AiAgentMapSummary[]>([]);

export const MapSelectionContext = createContext<
  ((summary: AiAgentMapSummary, opener: HTMLElement) => void) | null
>(null);

const artifactLoads = new Map<string, Promise<AiAgentMapDocument>>();
const documentUpdates = new EventTarget();

function documentKey(summary: Pick<AiAgentMapSummary, 'requestId' | 'id'>): string {
  return `${summary.requestId}:${summary.id}`;
}

export function resetSharedMapDocuments() {
  artifactLoads.clear();
}

/** Tells every preview of this map that a new revision is current. */
export function invalidateMapDocument(summary: Pick<AiAgentMapSummary, 'requestId' | 'id'>) {
  artifactLoads.delete(documentKey(summary));
  documentUpdates.dispatchEvent(new Event(documentKey(summary)));
}

export function loadSharedMapDocument(summary: AiAgentMapSummary): Promise<AiAgentMapDocument> {
  const key = documentKey(summary);
  const existing = artifactLoads.get(key);
  if (existing) return existing;
  const pending = getAiAgentMap(summary).finally(() => {
    if (artifactLoads.get(key) === pending) artifactLoads.delete(key);
  });
  artifactLoads.set(key, pending);
  return pending;
}

export function useMapDocument(summary: AiAgentMapSummary, enabled = true) {
  const [document, setDocument] = useState<AiAgentMapDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    setDocument(null);
    setFailed(false);
    if (!enabled) return;
    let cancelled = false;
    void loadSharedMapDocument(summary)
      .then((response) => {
        if (!cancelled) setDocument(response);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        notify({ severity: 'error', message: 'Не вдалося завантажити мапу. Спробуйте ще раз.' });
      });
    return () => {
      cancelled = true;
    };
  }, [summary.requestId, summary.id, enabled, retry, notify]);
  useEffect(() => {
    const key = documentKey(summary);
    const refresh = () => setRetry((value) => value + 1);
    documentUpdates.addEventListener(key, refresh);
    return () => documentUpdates.removeEventListener(key, refresh);
  }, [summary.requestId, summary.id]);
  return { document, failed, retry: () => setRetry((value) => value + 1) };
}
