/**
 * @vitest-environment happy-dom
 */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { useImageEditorRasterQueue } from '../use-image-editor-raster-queue';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
it('serializes concealment work and recovers after a rejected operation #3099', async () => {
  let queue: ReturnType<typeof useImageEditorRasterQueue> | null = null;
  const container = document.createElement('div');
  const root = createRoot(container);
  function Harness() {
    const value = useImageEditorRasterQueue();
    useEffect(() => {
      queue = value;
    });
    return null;
  }
  act(() => root.render(<Harness />));
  let settleA!: () => void;
  const starts: string[] = [];
  let first!: Promise<void>;
  let second!: Promise<void>;
  let third!: Promise<void>;
  act(() => {
    first = queue!.enqueue(
      () =>
        new Promise<void>((resolve) => {
          starts.push('A');
          settleA = resolve;
        }),
    );
    second = queue!.enqueue(async () => {
      starts.push('B');
      throw new Error('raster failed');
    });
    third = queue!.enqueue(async () => starts.push('C'));
  });
  await act(async () => Promise.resolve());
  expect(starts).toEqual(['A']);
  await act(async () => {
    settleA();
    await first;
    await expect(second).rejects.toThrow('raster failed');
    await third;
    await queue!.flush();
  });
  expect(starts).toEqual(['A', 'B', 'C']);
  expect(queue!.isBusy()).toBe(false);
  expect(queue!.pending).toBe(false);
  root.unmount();
  container.remove();
});
