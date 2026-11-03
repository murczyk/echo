import { useCallback, useEffect, useRef, useState } from 'react';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError } from '../../services/api/client';
import {
  getAiAgentDocumentWorkspace,
  listAiAgentConversationUploads,
  listAiAgentDocuments,
  setAiAgentDocumentHead,
  type AiAgentDocument,
  type AiAgentDocumentWorkspace,
  type AiAgentUpload,
} from '../../services/api/ai-agent';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The conversation's generated documents and sent uploads. */
export function useConversationFiles(conversationId: string | null, refreshToken: number) {
  const [documents, setDocuments] = useState<AiAgentDocument[]>([]);
  const [uploads, setUploads] = useState<AiAgentUpload[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!conversationId) {
      setDocuments([]);
      setUploads([]);
      return;
    }
    const controller = new AbortController();
    Promise.all([
      listAiAgentDocuments(conversationId, controller.signal),
      listAiAgentConversationUploads(conversationId, controller.signal),
    ])
      .then(([nextDocuments, nextUploads]) => {
        setDocuments(nextDocuments);
        setUploads(nextUploads);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [conversationId, refreshToken, retry]);

  return { documents, uploads, failed, retry: () => setRetry((value) => value + 1) };
}

/** One document's versions; head moves run one at a time, a conflict
 * reloads the current state and a move finishing after the user switched
 * documents is not shown. */
export function useDocumentWorkspace(documentId: string | null, refreshToken: number) {
  const { notify } = usePowerSnackbar();
  const [workspace, setWorkspace] = useState<AiAgentDocumentWorkspace | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const documentRef = useRef(documentId);

  useEffect(() => {
    documentRef.current = documentId;
    if (!documentId) {
      setWorkspace(null);
      return;
    }
    const controller = new AbortController();
    getAiAgentDocumentWorkspace(documentId, controller.signal)
      .then((next) => {
        setWorkspace(next);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [documentId, refreshToken, reload]);

  const setHead = useCallback(
    async (revision: number) => {
      if (!workspace || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const next = await setAiAgentDocumentHead({
          documentId: workspace.document.id,
          expectedRevision: workspace.document.headRevision,
          revision,
        });
        if (next.document.id === documentRef.current) setWorkspace(next);
      } catch (error) {
        if (workspace.document.id !== documentRef.current) return;
        if (error instanceof HttpRequestError && error.status === 409) {
          notify({ severity: 'warning', message: 'Документ змінився. Показуємо поточну версію.' });
          setReload((value) => value + 1);
        } else {
          notify({
            severity: 'error',
            message: `Не вдалося змінити поточну версію: ${errorText(error)}`,
          });
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [notify, workspace],
  );

  return {
    workspace,
    failed,
    busy,
    setHead,
    retry: () => setReload((value) => value + 1),
  };
}
