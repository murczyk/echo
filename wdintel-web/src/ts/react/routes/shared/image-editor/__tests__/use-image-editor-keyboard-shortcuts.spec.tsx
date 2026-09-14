/** @vitest-environment happy-dom */
import { useRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageEditorTool } from '../image-editor.types';
import { useImageEditorKeyboardShortcuts } from '../use-image-editor-keyboard-shortcuts';

function Harness({
  onTool,
  menuOpen = false,
  registerEscapeHandler,
  setMenuOpen = vi.fn(),
  dismissMenu = vi.fn(),
  requestCancel = vi.fn(),
}: {
  onTool: (tool: ImageEditorTool) => void;
  menuOpen?: boolean;
  registerEscapeHandler?: (handler: ((event: KeyboardEvent) => boolean) | null) => void;
  setMenuOpen?: (value: boolean) => void;
  dismissMenu?: () => void;
  requestCancel?: () => void;
}) {
  const editorIdRef = useRef(Symbol('editor'));
  const editorRootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<import('fabric').Canvas | null>(null);
  const cropRef = useRef<import('fabric').Rect | null>(null);
  const { activate } = useImageEditorKeyboardShortcuts({
    editorIdRef,
    editorRootRef,
    canvasRef,
    cropRef,
    cancelInteractions: () => false,
    loading: false,
    applying: false,
    rasterPending: false,
    saveDialogs: { activeDialog: null, closeDialog: vi.fn() } as never,
    confirmCancel: false,
    menuOpen,
    setConfirmCancel: vi.fn(),
    setMenuOpen,
    dismissMenu,
    finalizeActiveText: () => false,
    activeTextIsEditing: () => false,
    cancelCrop: vi.fn(),
    requestCancel,
    isInteractionLocked: () => false,
    changeTool: onTool,
    tool: ImageEditorTool.Select,
    applyCrop: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    deleteSelected: vi.fn(),
    registerEscapeHandler,
  });
  return (
    <section ref={editorRootRef} data-image-editor-root onPointerDownCapture={activate}>
      <div>child</div>
    </section>
  );
}

describe('useImageEditorKeyboardShortcuts #3448', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('keeps global ownership and scopes local events to their root', () => {
    const onToolA = vi.fn();
    const onToolB = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    act(() =>
      root.render(
        <>
          <Harness onTool={onToolA} />
          <Harness onTool={onToolB} />
        </>,
      ),
    );
    const [editorA, editorB] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-image-editor-root]'),
    );
    act(() => editorA.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() =>
      root.render(
        <>
          <Harness onTool={onToolA} />
          <Harness onTool={onToolB} />
        </>,
      ),
    );
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true })));
    expect(onToolA).toHaveBeenCalledWith(ImageEditorTool.Rectangle);
    expect(onToolB).not.toHaveBeenCalled();
    act(() =>
      editorA
        .querySelector('div')
        ?.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true })),
    );
    expect(onToolA).toHaveBeenCalledTimes(2);
    act(() =>
      editorB
        .querySelector('div')
        ?.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true })),
    );
    expect(onToolB).toHaveBeenCalledWith(ImageEditorTool.Rectangle);
    act(() => root.unmount());
  });

  it('keeps its listener stable while dispatching to the latest callback', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const initialOnTool = vi.fn();
    const latestOnTool = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    act(() => root.render(<Harness onTool={initialOnTool} />));
    const editor = container.querySelector<HTMLElement>('[data-image-editor-root]');
    act(() => editor?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    const keydownAdds = addEventListener.mock.calls.filter(([type]) => type === 'keydown').length;
    const keydownRemoves = removeEventListener.mock.calls.filter(
      ([type]) => type === 'keydown',
    ).length;
    act(() => root.render(<Harness onTool={latestOnTool} />));
    expect(addEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(
      keydownAdds,
    );
    expect(removeEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(
      keydownRemoves,
    );
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true })));
    expect(initialOnTool).not.toHaveBeenCalled();
    expect(latestOnTool).toHaveBeenCalledWith(ImageEditorTool.Rectangle);
    act(() => root.unmount());
    expect(removeEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });

  it('keeps the registered Escape handler stable while reading latest state', () => {
    const registerEscapeHandler = vi.fn();
    const initialSetMenuOpen = vi.fn();
    const initialDismissMenu = vi.fn();
    const initialRequestCancel = vi.fn();
    const latestSetMenuOpen = vi.fn();
    const latestDismissMenu = vi.fn();
    const latestRequestCancel = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    act(() =>
      root.render(
        <Harness
          onTool={vi.fn()}
          registerEscapeHandler={registerEscapeHandler}
          setMenuOpen={initialSetMenuOpen}
          dismissMenu={initialDismissMenu}
          requestCancel={initialRequestCancel}
        />,
      ),
    );
    const handler = registerEscapeHandler.mock.calls[0]?.[0];
    act(() =>
      root.render(
        <Harness
          onTool={vi.fn()}
          menuOpen
          registerEscapeHandler={registerEscapeHandler}
          setMenuOpen={latestSetMenuOpen}
          dismissMenu={latestDismissMenu}
          requestCancel={latestRequestCancel}
        />,
      ),
    );
    expect(registerEscapeHandler).toHaveBeenCalledTimes(1);
    expect(registerEscapeHandler.mock.calls[0]?.[0]).toBe(handler);
    act(() => handler?.(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(latestSetMenuOpen).toHaveBeenCalledWith(false);
    expect(latestDismissMenu).toHaveBeenCalledOnce();
    expect(latestRequestCancel).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(registerEscapeHandler.mock.calls.at(-1)?.[0]).toBeNull();
  });
});
