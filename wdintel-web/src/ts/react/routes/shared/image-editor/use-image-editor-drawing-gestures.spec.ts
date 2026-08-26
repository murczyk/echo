import { describe, expect, it } from 'vitest';

import { cancelGestureSession, finalizeGestureSession } from './use-image-editor-drawing-gestures';

describe('image editor gesture completion #3099', () => {
  it('makes cancellation and a second pointer-up idempotent', () => {
    const transient = {} as never;
    const cancelled = cancelGestureSession({
      kind: 'shape',
      tool: 'rectangle',
      start: { x: 4, y: 8 },
      object: transient,
      config: {} as never,
    });
    expect(cancelled.transient).toBe(transient);
    expect(cancelGestureSession(cancelled.next).transient).toBeNull();
    const first = finalizeGestureSession({
      kind: 'text',
      point: { x: 4, y: 8 },
      config: {} as never,
    });
    expect(first.completed.kind).toBe('text');
    expect(finalizeGestureSession(first.next).completed).toEqual({ kind: 'idle' });
  });
});
