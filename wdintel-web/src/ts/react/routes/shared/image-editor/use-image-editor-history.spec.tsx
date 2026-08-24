/**
 * @vitest-environment happy-dom
 */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useImageEditorHistory } from './use-image-editor-history';

type History = ReturnType<typeof useImageEditorHistory>;

function renderHistory(canvas: any, onRestoreError = vi.fn()) {
  let history: History | null = null;
  function Harness() {
    const canvasRef = useRef(canvas);
    history = useImageEditorHistory({ canvasRef, onRestored: vi.fn(), onRestoreError });
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
  return {
    toJSON: vi.fn(() => ({ value })),
    loadFromJSON: vi.fn(async (snapshot: string) => {
      value = JSON.parse(snapshot).value;
    }),
    requestRenderAll: vi.fn(),
    set value(next: string) {
      value = next;
    },
    get value() {
      return value;
    },
  };
}

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
    await act(async () => harness.history().restore(0));
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
    await act(async () => harness.history().restore(0));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(fabricCanvas.value).toBe('clean');
    expect(harness.history().historyState.length).toBe(2);
  });

  it('truncates redo after a new edit following undo', async () => {
    const fabricCanvas = canvas();
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'one';
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'two';
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().restore(1));
    fabricCanvas.value = 'replacement';
    act(() => harness.history().saveHistory());
    expect(harness.history().historyState).toEqual({ index: 2, length: 3 });
    await act(async () => harness.history().restore(3));
    expect(fabricCanvas.value).toBe('replacement');
  });

  it('keeps restoration enabled after a failed load', async () => {
    const fabricCanvas = canvas();
    fabricCanvas.loadFromJSON.mockRejectedValueOnce(new Error('restore failed'));
    const harness = renderHistory(fabricCanvas);
    act(() => harness.history().saveHistory());
    fabricCanvas.value = 'changed';
    act(() => harness.history().saveHistory());
    await act(async () => harness.history().restore(0));
    await act(async () => harness.history().restore(0));
    expect(harness.onRestoreError).toHaveBeenCalledOnce();
    expect(fabricCanvas.loadFromJSON).toHaveBeenCalledTimes(2);
  });
});
