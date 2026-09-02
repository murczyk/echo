/**
 * @vitest-environment happy-dom
 */
import { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({ CircularProgress: () => null }));

import { ImageEditorWorkspace } from '../ImageEditorWorkspace';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('ImageEditorWorkspace wheel zoom', () => {
  it('registers one non-passive native listener and zooms once', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onZoom = vi.fn();
    const addListener = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    await act(async () =>
      root.render(
        <ImageEditorWorkspace
          canvasElementRef={createRef()}
          canvasRef={createRef()}
          workspaceRef={createRef()}
          tool="select"
          view={{ pan: { x: 0, y: 0 }, scale: 1 }}
          ready
          loading={false}
          busy={false}
          magnification={2}
          onPan={vi.fn()}
          onZoom={onZoom}
        />,
      ),
    );
    const workspace = container.querySelector('[data-image-editor-workspace]') as HTMLDivElement;
    workspace.getBoundingClientRect = () => ({ left: 10, top: 20 }) as DOMRect;
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: 30 },
      clientY: { value: 50 },
      deltaY: { value: -1 },
    });
    await act(async () => workspace.dispatchEvent(event));
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenCalledWith({ x: 20, y: 30 }, 1.1);
    expect(addListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
    root.unmount();
    container.remove();
    addListener.mockRestore();
  });
});
