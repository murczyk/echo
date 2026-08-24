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
  onRestored: (canvas: Canvas) => void;
  onRestoreError: (cause: unknown) => void;
}) {
  const snapshotsRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const cleanSnapshotRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const [state, setState] = useState({ index: -1, length: 0 });
  const [hasEdits, setHasEdits] = useState(false);

  const snapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || restoringRef.current) return null;
    return JSON.stringify(
      (canvas as unknown as { toJSON: (properties: string[]) => unknown }).toJSON([
        'editorRole',
        'magnifierSourceX',
        'magnifierSourceY',
        'magnifierId',
      ]),
    );
  }, [canvasRef]);

  const saveHistory = useCallback(() => {
    const nextSnapshot = snapshot();
    if (nextSnapshot == null) return;
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
  }, [snapshot]);

  const cancelScheduledHistory = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flushScheduledHistory = useCallback(() => {
    if (timerRef.current == null) return;
    cancelScheduledHistory();
    saveHistory();
  }, [cancelScheduledHistory, saveHistory]);

  const scheduleHistory = useCallback(() => {
    cancelScheduledHistory();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      saveHistory();
    }, HISTORY_DELAY_MS);
  }, [cancelScheduledHistory, saveHistory]);

  const restore = useCallback(
    async (nextIndex: number) => {
      flushScheduledHistory();
      const canvas = canvasRef.current;
      if (!canvas || nextIndex < 0 || nextIndex >= snapshotsRef.current.length) return;
      restoringRef.current = true;
      try {
        await canvas.loadFromJSON(snapshotsRef.current[nextIndex] ?? '{}');
        indexRef.current = nextIndex;
        setState({ index: nextIndex, length: snapshotsRef.current.length });
        setHasEdits(snapshotsRef.current[nextIndex] !== cleanSnapshotRef.current);
        onRestored(canvas);
        canvas.requestRenderAll();
      } catch (cause) {
        onRestoreError(cause);
      } finally {
        restoringRef.current = false;
      }
    },
    [canvasRef, flushScheduledHistory, onRestoreError, onRestored],
  );

  const reset = useCallback(async () => {
    cancelScheduledHistory();
    const canvas = canvasRef.current;
    const cleanSnapshot = cleanSnapshotRef.current;
    if (!canvas || cleanSnapshot == null) return;
    restoringRef.current = true;
    try {
      await canvas.loadFromJSON(cleanSnapshot);
      snapshotsRef.current = [cleanSnapshot];
      indexRef.current = 0;
      setState({ index: 0, length: 1 });
      setHasEdits(false);
      onRestored(canvas);
      canvas.requestRenderAll();
    } catch (cause) {
      onRestoreError(cause);
    } finally {
      restoringRef.current = false;
    }
  }, [cancelScheduledHistory, canvasRef, onRestoreError, onRestored]);

  const clear = useCallback(() => {
    cancelScheduledHistory();
    snapshotsRef.current = [];
    indexRef.current = -1;
    cleanSnapshotRef.current = null;
    setState({ index: -1, length: 0 });
    setHasEdits(false);
  }, [cancelScheduledHistory]);

  useEffect(() => cancelScheduledHistory, [cancelScheduledHistory]);

  return {
    cancelScheduledHistory,
    clear,
    flushScheduledHistory,
    hasEdits,
    historyState: state,
    historyIndexRef: indexRef,
    reset,
    restore,
    saveHistory,
    scheduleHistory,
  };
}
