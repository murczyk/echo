import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const HISTORY_LIMIT = 30;
const HISTORY_DELAY_MS = 150;

type Canvas = import('fabric').Canvas;

export function useImageEditorHistory({
  canvasRef,
  onRestored,
  onRestoreError,
}: {
  canvasRef: RefObject<Canvas | null>;
  onRestored: (canvas: Canvas) => void | Promise<void>;
  onRestoreError: (cause: unknown) => void;
}) {
  const snapshotsRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const cleanSnapshotRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const pendingSnapshotRef = useRef<string | null>(null);
  const [state, setState] = useState({ index: -1, length: 0 });
  const [pendingSnapshot, setPendingSnapshot] = useState<string | null>(null);
  const [hasEdits, setHasEdits] = useState(false);

  const snapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || restoringRef.current) return null;
    const serializableCanvas = canvas as unknown as {
      set?: (properties: Record<string, unknown>) => void;
      toJSON: (properties: string[]) => unknown;
    };
    serializableCanvas.set?.({
      editorDocumentWidth: canvas.width,
      editorDocumentHeight: canvas.height,
    });
    return JSON.stringify(
      serializableCanvas.toJSON(['editorRole', 'editorDocumentWidth', 'editorDocumentHeight']),
    );
  }, [canvasRef]);

  const commitSnapshot = useCallback((nextSnapshot: string) => {
    if (cleanSnapshotRef.current == null) cleanSnapshotRef.current = nextSnapshot;
    if (snapshotsRef.current[indexRef.current] === nextSnapshot) {
      setHasEdits(nextSnapshot !== cleanSnapshotRef.current);
      return;
    }
    const snapshots = snapshotsRef.current.slice(0, indexRef.current + 1);
    snapshots.push(nextSnapshot);
    snapshotsRef.current = snapshots.slice(-HISTORY_LIMIT);
    indexRef.current = snapshotsRef.current.length - 1;
    setState({ index: indexRef.current, length: snapshotsRef.current.length });
    setHasEdits(nextSnapshot !== cleanSnapshotRef.current);
  }, []);

  const cancelScheduledHistory = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const discardPendingHistory = useCallback(() => {
    cancelScheduledHistory();
    pendingSnapshotRef.current = null;
    setPendingSnapshot(null);
  }, [cancelScheduledHistory]);

  const flushScheduledHistory = useCallback(() => {
    const scheduledSnapshot = pendingSnapshotRef.current;
    if (scheduledSnapshot == null) return;
    discardPendingHistory();
    commitSnapshot(scheduledSnapshot);
  }, [commitSnapshot, discardPendingHistory]);

  const saveHistory = useCallback(() => {
    const liveSnapshot = snapshot();
    if (liveSnapshot == null) return;
    const scheduledSnapshot = pendingSnapshotRef.current;
    if (scheduledSnapshot != null) {
      discardPendingHistory();
      commitSnapshot(scheduledSnapshot);
    }
    commitSnapshot(liveSnapshot);
  }, [commitSnapshot, discardPendingHistory, snapshot]);

  const scheduleHistory = useCallback(() => {
    cancelScheduledHistory();
    const nextSnapshot = snapshot();
    if (nextSnapshot == null) return;
    const committedSnapshot = snapshotsRef.current[indexRef.current];
    if (nextSnapshot === committedSnapshot) {
      pendingSnapshotRef.current = null;
      setPendingSnapshot(null);
      setHasEdits(nextSnapshot !== cleanSnapshotRef.current);
      return;
    }
    pendingSnapshotRef.current = nextSnapshot;
    setPendingSnapshot(nextSnapshot);
    setHasEdits(nextSnapshot !== cleanSnapshotRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const scheduledSnapshot = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      setPendingSnapshot(null);
      if (scheduledSnapshot != null) commitSnapshot(scheduledSnapshot);
    }, HISTORY_DELAY_MS);
  }, [cancelScheduledHistory, commitSnapshot, snapshot]);

  const restore = useCallback(
    async (nextIndex: number) => {
      const canvas = canvasRef.current;
      if (!canvas || nextIndex < 0 || nextIndex >= snapshotsRef.current.length) return;
      restoringRef.current = true;
      try {
        const serializedSnapshot = snapshotsRef.current[nextIndex] ?? '{}';
        const snapshot = JSON.parse(serializedSnapshot) as {
          editorDocumentWidth?: number;
          editorDocumentHeight?: number;
        };
        await canvas.loadFromJSON(serializedSnapshot);
        if (snapshot.editorDocumentWidth && snapshot.editorDocumentHeight)
          canvas.setDimensions({
            width: snapshot.editorDocumentWidth,
            height: snapshot.editorDocumentHeight,
          });
        indexRef.current = nextIndex;
        setState({ index: nextIndex, length: snapshotsRef.current.length });
        setHasEdits(snapshotsRef.current[nextIndex] !== cleanSnapshotRef.current);
        await onRestored(canvas);
        canvas.requestRenderAll();
      } catch (cause) {
        onRestoreError(cause);
      } finally {
        restoringRef.current = false;
      }
    },
    [canvasRef, onRestoreError, onRestored],
  );

  const undo = useCallback(async () => {
    flushScheduledHistory();
    await restore(indexRef.current - 1);
  }, [flushScheduledHistory, restore]);

  const redo = useCallback(async () => {
    flushScheduledHistory();
    await restore(indexRef.current + 1);
  }, [flushScheduledHistory, restore]);

  const reset = useCallback(async () => {
    discardPendingHistory();
    const canvas = canvasRef.current;
    const cleanSnapshot = cleanSnapshotRef.current;
    if (!canvas || cleanSnapshot == null) return;
    restoringRef.current = true;
    try {
      const snapshot = JSON.parse(cleanSnapshot) as {
        editorDocumentWidth?: number;
        editorDocumentHeight?: number;
      };
      await canvas.loadFromJSON(cleanSnapshot);
      if (snapshot.editorDocumentWidth && snapshot.editorDocumentHeight)
        canvas.setDimensions({
          width: snapshot.editorDocumentWidth,
          height: snapshot.editorDocumentHeight,
        });
      snapshotsRef.current = [cleanSnapshot];
      indexRef.current = 0;
      setState({ index: 0, length: 1 });
      setHasEdits(false);
      await onRestored(canvas);
      canvas.requestRenderAll();
    } catch (cause) {
      onRestoreError(cause);
    } finally {
      restoringRef.current = false;
    }
  }, [canvasRef, discardPendingHistory, onRestoreError, onRestored]);

  const clear = useCallback(() => {
    discardPendingHistory();
    snapshotsRef.current = [];
    indexRef.current = -1;
    cleanSnapshotRef.current = null;
    setState({ index: -1, length: 0 });
    setHasEdits(false);
  }, [discardPendingHistory]);

  useEffect(() => discardPendingHistory, [discardPendingHistory]);

  const canUndo = pendingSnapshot != null ? state.index >= 0 : state.index > 0;
  const canRedo = pendingSnapshot == null && state.index >= 0 && state.index < state.length - 1;

  return {
    cancelScheduledHistory,
    canRedo,
    canUndo,
    clear,
    commitSnapshot,
    discardPendingHistory,
    flushScheduledHistory,
    hasEdits,
    historyState: state,
    historyIndexRef: indexRef,
    reset,
    redo,
    saveHistory,
    scheduleHistory,
    undo,
  };
}
