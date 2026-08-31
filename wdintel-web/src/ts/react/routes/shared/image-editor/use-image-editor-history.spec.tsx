/**
 * @vitest-environment happy-dom
 */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import { useImageEditorHistory } from './use-image-editor-history';

type History = ReturnType<typeof useImageEditorHistory>;

function renderHistory(canvas: any, onRestoreError = vi.fn(), onRestored = vi.fn()) {
  let history: History | null = null;
  function Harness() {
    const canvasRef = useRef(canvas);
    history = useImageEditorHistory({ canvasRef, onRestored, onRestoreError });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  document.body.appendChild(container);
  act(() => root.render(<Harness />));
  return { history: () => history!, root, onRestoreError };
}

function canvas() {
  let value = 'clean';
  const metadata: Record<string, unknown> = {};
  return {
    width: 100,
    height: 100,
    backgroundImage: {
      width: 100,
      height: 100,
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: 1,
      scaleY: 1,
      get: () => 0,
    },
    toJSON: vi.fn(() => ({ value, ...metadata })),
    set: vi.fn((values: Record<string, unknown>) => Object.assign(metadata, values)),
    loadFromJSON: vi.fn(async (snapshot: string) => {
      value = JSON.parse(snapshot).value;
    }),
    setDimensions: vi.fn(),
    requestRenderAll: vi.fn(),
    set value(next: string) {
      value = next;
    },
    get value() {
      return value;
    },
  };
}

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor history #3099', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('flushes an immediate property change before undoing it', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().scheduleHistory());
    expect(harness.history().hasEdits).toBe(true);
    expect(harness.history().canUndo).toBe(true);
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('clean');
    expect(harness.history().hasEdits).toBe(false);
  });

  it('coalesces slider changes and cancels the timer after undo', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'first';
    act(() => harness.history().scheduleHistory());
    fabricCanvas.value = 'second';
    act(() => harness.history().scheduleHistory());
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(harness.history().historyState.length).toBe(2);
    await act(async () => harness.history().undo());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(fabricCanvas.value).toBe('clean');
    expect(harness.history().historyState.length).toBe(2);
  });

  it('truncates redo after a new edit following undo', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'one';
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'two';
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().undo());
    fabricCanvas.value = 'replacement';
    act(() => harness.history().scheduleHistory());
    expect(harness.history().canRedo).toBe(false);
    await act(async () => harness.history().flushScheduledHistory());
    expect(harness.history().historyState).toEqual({ index: 2, length: 3 });
    await act(async () => harness.history().redo());
    expect(fabricCanvas.value).toBe('replacement');
  });

  it('commits a pending style before a later direct canvas mutation', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'style';
    act(() => harness.history().scheduleHistory());
    fabricCanvas.value = 'deleted';
    act(() => harness.history().saveHistory());
    expect(harness.history().historyState).toEqual({ index: 2, length: 3 });
    expect(harness.history().canUndo).toBe(true);
    expect(harness.history().canRedo).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.history().historyState).toEqual({ index: 2, length: 3 });
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('style');
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('clean');
  });

  it('deduplicates an identical pending and direct snapshot', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().scheduleHistory());
    act(() => harness.history().saveHistory());
    expect(harness.history().historyState).toEqual({ index: 1, length: 2 });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.history().historyState).toEqual({ index: 1, length: 2 });
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('clean');
  });

  it('replaces a redo branch with ordered pending and direct snapshots', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'one';
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'two';
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().undo());
    fabricCanvas.value = 'styled-one';
    act(() => harness.history().scheduleHistory());
    expect(harness.history().canRedo).toBe(false);
    fabricCanvas.value = 'direct-after-style';
    act(() => harness.history().saveHistory());
    expect(harness.history().historyState).toEqual({ index: 3, length: 4 });
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('styled-one');
    await act(async () => harness.history().undo());
    expect(fabricCanvas.value).toBe('one');
    await act(async () => harness.history().redo());
    expect(fabricCanvas.value).toBe('styled-one');
  });

  it('clears pending dirty state without adding a duplicate when the canvas returns to clean', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().scheduleHistory());
    expect(harness.history().hasEdits).toBe(true);
    fabricCanvas.value = 'clean';
    act(() => harness.history().scheduleHistory());
    expect(harness.history().hasEdits).toBe(false);
    expect(harness.history().canUndo).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.history().historyState).toEqual({ index: 0, length: 1 });
  });

  it('clears pending history on reset and clear', async () => {
    vi.useFakeTimers();
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().scheduleHistory());
    await act(async () => harness.history().reset());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.history().historyState).toEqual({ index: 0, length: 1 });
    expect(harness.history().hasEdits).toBe(false);

    fabricCanvas.value = 'changed-again';
    act(() => harness.history().scheduleHistory());
    act(() => harness.history().clear());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.history().historyState).toEqual({ index: -1, length: 0 });
    expect(harness.history().canUndo).toBe(false);
    expect(harness.history().canRedo).toBe(false);
  });

  it('keeps restoration enabled after a failed load', async () => {
    const fabricCanvas = canvas();
    fabricCanvas.loadFromJSON.mockRejectedValueOnce(new Error('restore failed'));
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().undo());
    await act(async () => harness.history().undo());
    expect(harness.onRestoreError).toHaveBeenCalledOnce();
    expect(fabricCanvas.loadFromJSON).toHaveBeenCalledTimes(2);
  });

  it('restores the real crop canvas references and clean history on reset #3099', async () => {
    const source = {
      cropX: 12,
      cropY: 34,
      width: 400,
      height: 300,
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: 1,
      scaleY: 1,
      get(key: keyof typeof source) {
        return this[key];
      },
      set: vi.fn((values: Record<string, unknown>) => Object.assign(source, values)),
    };
    const fabricCanvas = Object.assign(canvas(), {
      width: 400,
      height: 300,
      backgroundImage: source,
      getObjects: () => [],
    });
    fabricCanvas.setDimensions = vi.fn((dimensions: { width: number; height: number }) =>
      Object.assign(fabricCanvas, dimensions),
    );
    const sourceRef = { current: null } as any;
    const cropRef = { current: {} } as any;
    const onRestored = vi.fn((restoredCanvas, snapshot) =>
      restoreImageEditorCanvasReferences({
        canvas: restoredCanvas,
        sourceRef,
        cropRef,
        snapshot,
      }),
    );
    const harness = renderHistory(fabricCanvas, vi.fn(), onRestored);
    act(() => harness.history().saveHistory());
    expect(fabricCanvas.toJSON).toHaveBeenCalledWith(['editorRole']);
    fabricCanvas.value = 'cropped';
    Object.assign(fabricCanvas, { width: 280, height: 190 });
    Object.assign(source, {
      cropX: 48,
      cropY: 57,
      width: 280,
      height: 190,
      left: 9,
      top: 11,
      originX: 'center',
      originY: 'center',
      scaleX: 0.7,
      scaleY: 0.6,
    });
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().reset());
    expect(fabricCanvas.value).toBe('clean');
    expect(fabricCanvas).toMatchObject({ width: 400, height: 300 });
    expect(source).toMatchObject({
      cropX: 12,
      cropY: 34,
      width: 400,
      height: 300,
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: 1,
      scaleY: 1,
    });
    expect(sourceRef.current).toBe(source);
    expect(cropRef.current).toBeNull();
    expect(harness.history().historyState).toEqual({ index: 0, length: 1 });
    expect(harness.history().hasEdits).toBe(false);
  });

  it('evicts oversized undo snapshots while retaining the current state and reset source #3099', async () => {
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = `first-${'x'.repeat(7 * 1024 * 1024)}`;
    act(() => harness.history().saveHistory());
    fabricCanvas.value = `second-${'y'.repeat(7 * 1024 * 1024)}`;
    act(() => harness.history().saveHistory());
    expect(harness.history().historyState.length).toBe(1);
    expect(harness.history().canUndo).toBe(false);
    await act(async () => harness.history().reset());
    expect(fabricCanvas.value).toBe('clean');
    expect(harness.history().historyState).toEqual({ index: 0, length: 1 });
  });
});
