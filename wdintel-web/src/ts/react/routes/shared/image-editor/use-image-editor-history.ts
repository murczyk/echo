import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  captureImageEditorDocumentSnapshot,
  type ImageEditorDocumentSnapshot,
} from './image-editor-document-snapshot';

const HISTORY_LIMIT = 30;
const HISTORY_DELAY_MS = 150;
// Fabric serializes raster patches as data URLs, so count alone cannot bound history memory.
const HISTORY_SERIALIZED_BYTES_LIMIT = 12 * 1024 * 1024;

type Canvas = import('fabric').Canvas;

export function useImageEditorHistory({
  canvasRef,
  onRestored,
  onRestoreError,
}: {
  canvasRef: RefObject<Canvas | null>;
  onRestored: (canvas: Canvas, snapshot: ImageEditorDocumentSnapshot) => void | Promise<void>;
  onRestoreError: (cause: unknown) => void;
}) {
  const snapshotsRef = useRef<ImageEditorDocumentSnapshot[]>([]);
  const indexRef = useRef(-1);
  const cleanSnapshotRef = useRef<ImageEditorDocumentSnapshot | null>(null);
  const restoringRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const pendingSnapshotRef = useRef<ImageEditorDocumentSnapshot | null>(null);
  const [state, setState] = useState({ index: -1, length: 0 });
  const [pendingSnapshot, setPendingSnapshot] = useState<ImageEditorDocumentSnapshot | null>(null);
  const [hasEdits, setHasEdits] = useState(false);

  const snapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || restoringRef.current) return null;
    return captureImageEditorDocumentSnapshot(canvas);
  }, [canvasRef]);

  const matches = (
    first: ImageEditorDocumentSnapshot | null,
    second: ImageEditorDocumentSnapshot,
  ) => first != null && JSON.stringify(first) === JSON.stringify(second);

  const trimHistory = (snapshots: ImageEditorDocumentSnapshot[], index: number) => {
    let retained = snapshots;
    let retainedIndex = index;
    const bytes = () => retained.reduce((total, item) => total + item.serializedCanvas.length, 0);
    while (
      retained.length > 1 &&
      (retained.length > HISTORY_LIMIT || bytes() > HISTORY_SERIALIZED_BYTES_LIMIT)
    ) {
      retained = retained.slice(1);
      retainedIndex -= 1;
    }
    return { snapshots: retained, index: retainedIndex };
  };

  const commitSnapshot = useCallback((nextSnapshot: ImageEditorDocumentSnapshot) => {
    if (cleanSnapshotRef.current == null) cleanSnapshotRef.current = nextSnapshot;
    if (matches(snapshotsRef.current[indexRef.current] ?? null, nextSnapshot)) {
      setHasEdits(!matches(cleanSnapshotRef.current, nextSnapshot));
      return;
    }
    const snapshots = snapshotsRef.current.slice(0, indexRef.current + 1);
    snapshots.push(nextSnapshot);
    const trimmed = trimHistory(snapshots, snapshots.length - 1);
    snapshotsRef.current = trimmed.snapshots;
    indexRef.current = trimmed.index;
    setState({ index: indexRef.current, length: snapshotsRef.current.length });
    setHasEdits(!matches(cleanSnapshotRef.current, nextSnapshot));
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
    if (matches(committedSnapshot ?? null, nextSnapshot)) {
      pendingSnapshotRef.current = null;
      setPendingSnapshot(null);
      setHasEdits(!matches(cleanSnapshotRef.current, nextSnapshot));
      return;
    }
    pendingSnapshotRef.current = nextSnapshot;
    setPendingSnapshot(nextSnapshot);
    setHasEdits(!matches(cleanSnapshotRef.current, nextSnapshot));
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
        const snapshot = snapshotsRef.current[nextIndex];
        if (!snapshot) return;
        await canvas.loadFromJSON(snapshot.serializedCanvas);
        indexRef.current = nextIndex;
        setState({ index: nextIndex, length: snapshotsRef.current.length });
        setHasEdits(!matches(cleanSnapshotRef.current, snapshot));
        await onRestored(canvas, snapshot);
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
      await canvas.loadFromJSON(cleanSnapshot.serializedCanvas);
      snapshotsRef.current = [cleanSnapshot];
      indexRef.current = 0;
      setState({ index: 0, length: 1 });
      setHasEdits(false);
      await onRestored(canvas, cleanSnapshot);
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
