import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiAgentMapPatchOp,
  AiAgentMapSummary,
  AiAgentMapWorkspaceRsp,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  editAiAgentMap,
  openAiAgentMapWorkspace,
  redoAiAgentMap,
  undoAiAgentMap,
} from '../../services/api/ai-agent';
import { HttpRequestError, isAbortError, isNetworkRequestError } from '../../services/api/client';
import { invalidateMapDocument } from './map-documents';
import { newIdempotencyKey } from './map-edit';

export type MapWorkspaceState = ReturnType<typeof useMapWorkspace>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The editable map: head revision, history and the mutations on it. Every
 * successful change is a saved revision; undo/redo move along that history. */
export function useMapWorkspace(summary: AiAgentMapSummary, refreshToken: number) {
  const [workspace, setWorkspace] = useState<AiAgentMapWorkspaceRsp | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const busyRef = useRef(false);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void openAiAgentMapWorkspace(summary, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (workspaceRef.current && workspaceRef.current.revision !== response.revision)
          invalidateMapDocument(summary);
        setWorkspace(response);
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (!workspaceRef.current) setFailed(true);
        notify({ severity: 'error', message: 'Не вдалося завантажити мапу. Спробуйте ще раз.' });
      });
    return () => controller.abort();
  }, [summary.requestId, summary.id, refreshToken, reload, notify]);

  const mutate = useCallback(
    async (
      request: (current: AiAgentMapWorkspaceRsp) => Promise<AiAgentMapWorkspaceRsp>,
      failure: string,
    ): Promise<boolean> => {
      const current = workspaceRef.current;
      if (!current || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const next = await request(current);
        setWorkspace(next);
        invalidateMapDocument(summary);
        return true;
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 409) {
          setReload((value) => value + 1);
        }
        notify({ severity: 'error', message: errorMessage(error, failure) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [summary, notify],
  );

  const edit = useCallback(
    (operations: AiAgentMapPatchOp[], revisionSummary: string | null = null) =>
      mutate(async (current) => {
        const req = {
          requestId: summary.requestId,
          mapId: summary.id,
          expectedRevision: current.revision,
          idempotencyKey: newIdempotencyKey(),
          summary: revisionSummary,
          operations,
        };
        try {
          await editAiAgentMap(req);
        } catch (error) {
          // The same key makes a retried edit safe if the first reply was lost.
          if (!isNetworkRequestError(error)) throw error;
          await editAiAgentMap(req);
        }
        return openAiAgentMapWorkspace(summary);
      }, 'Не вдалося змінити мапу.'),
    [summary, mutate],
  );

  const history = useCallback(
    (direction: 'undo' | 'redo') =>
      mutate(
        (current) =>
          (direction === 'undo' ? undoAiAgentMap : redoAiAgentMap)({
            requestId: summary.requestId,
            mapId: summary.id,
            expectedRevision: current.revision,
          }),
        direction === 'undo' ? 'Не вдалося скасувати зміну.' : 'Не вдалося повторити зміну.',
      ),
    [summary, mutate],
  );

  return {
    workspace,
    failed,
    busy,
    retry: () => setReload((value) => value + 1),
    edit,
    undo: () => history('undo'),
    redo: () => history('redo'),
  };
}
