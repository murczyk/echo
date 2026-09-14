/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { useImageAttachmentEditorSession } from '../use-image-attachment-editor-session';
import { MessageCardAttachmentPreviewStage } from '../../attachment-preview/MessageCardAttachmentPreviewStage';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
it('keeps stale sources and replacements bound to the original attachment #3099', async () => {
  const imageA = { id: 'a', href: '/a.png' } as never;
  const imageB = { id: 'b', href: '/b.png' } as never;
  let resolveSource!: (value: any) => void;
  const loadSource = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSource = resolve;
      }),
  );
  const applyReplacement = vi.fn();
  let controls: ReturnType<typeof useImageAttachmentEditorSession> | null = null;
  function Harness({ image }: { image: typeof imageA }) {
    const value = useImageAttachmentEditorSession({
      image,
      imageEditing: { canEdit: () => true, loadSource, applyReplacement, addAsNew: vi.fn() },
    });
    useEffect(() => {
      controls = value;
    });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Harness image={imageA} />));
  act(() => void controls!.open());
  await vi.waitFor(() => expect(loadSource).toHaveBeenCalledWith(imageA, expect.any(AbortSignal)));
  act(() => root.render(<Harness image={imageB} />));
  await act(async () =>
    resolveSource({ blob: new Blob(), fileName: 'a.png', mimeType: 'image/png' }),
  );
  expect(controls!.session).toBeNull();

  act(() => root.render(<Harness image={imageA} />));
  act(() => void controls!.open());
  await act(async () =>
    resolveSource({ blob: new Blob(), fileName: 'a.png', mimeType: 'image/png' }),
  );
  await vi.waitFor(() => expect(controls!.session).not.toBeNull());
  act(() => root.render(<Harness image={imageB} />));
  await act(async () =>
    controls!.saveReplacement({ file: new File(['x'], 'edited.png', { type: 'image/png' }) }),
  );
  expect(applyReplacement).toHaveBeenCalledWith(imageA, expect.any(Object));
  act(() => root.unmount());
});

// @test-scope regression: https://github.com/echoua/echo/issues/3294
it('clears a failed image source error when carousel navigation changes the target #3294', async () => {
  const imageA = { id: 'a', href: '/a.png' } as never;
  const imageB = { id: 'b', href: '/b.png' } as never;
  const loadSource = vi.fn(async () => {
    throw new Error('image A failed');
  });
  let controls: ReturnType<typeof useImageAttachmentEditorSession> | null = null;
  function Harness({ image }: { image: typeof imageA }) {
    const value = useImageAttachmentEditorSession({
      image,
      imageEditing: {
        canEdit: () => true,
        loadSource,
        applyReplacement: vi.fn(),
        addAsNew: vi.fn(),
      },
    });
    useEffect(() => {
      controls = value;
    });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Harness image={imageA} />));
  await act(async () => controls!.open());
  await vi.waitFor(() => expect(controls!.error).toBe('image A failed'));

  act(() => root.render(<Harness image={imageB} />));

  await vi.waitFor(() => expect(controls!.error).toBeNull());
  expect(loadSource).toHaveBeenCalledOnce();
  expect(controls!.session).toBeNull();
  expect(controls!.loading).toBe(false);
  act(() => root.unmount());
});

// @test-scope regression: https://github.com/echoua/echo/issues/3368
it('ECHO-3368 invalidates stage gestures while editor loading and unlocks after failure or cancel', async () => {
  const image = { id: 'image', href: '/image.png' } as never;
  const sources: Array<{ resolve: (value: any) => void; reject: (reason: Error) => void }> = [];
  const loadSource = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        sources.push({ resolve, reject });
      }),
  );
  const activated = vi.fn();
  function Harness() {
    const editor = useImageAttachmentEditorSession({
      image,
      imageEditing: {
        canEdit: () => true,
        loadSource,
        applyReplacement: vi.fn(),
        addAsNew: vi.fn(),
      },
    });
    return (
      <>
        <button aria-label="open" onClick={() => void editor.open()} />
        <button aria-label="cancel" onClick={editor.close} />
        <MessageCardAttachmentPreviewStage
          kind="image"
          activationEnabled={!editor.isLocked}
          activationKey={`${editor.loading}:${editor.session !== null}`}
          onPrimaryClick={() => activated()}
        >
          <div>image</div>
        </MessageCardAttachmentPreviewStage>
        {editor.error ? <div role="alert">{editor.error}</div> : null}
      </>
    );
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  const stage = container.querySelector('[data-image-preview-stage]')!;
  const pointer = (type: string) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: 'mouse' },
      button: { value: 0 },
      clientX: { value: 20 },
      clientY: { value: 20 },
    });
    stage.dispatchEvent(event);
  };
  const click = () => stage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

  act(() => pointer('pointerdown'));
  act(() => (container.querySelector('[aria-label="open"]') as HTMLButtonElement).click());
  await vi.waitFor(() => expect(loadSource).toHaveBeenCalledOnce());
  act(() => {
    pointer('pointerup');
    click();
  });
  expect(activated).not.toHaveBeenCalled();

  await act(async () => sources[0]!.reject(new Error('source failed')));
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  act(() => {
    pointer('pointerdown');
    pointer('pointerup');
    click();
  });
  expect(activated).toHaveBeenCalledOnce();

  act(() => (container.querySelector('[aria-label="open"]') as HTMLButtonElement).click());
  await vi.waitFor(() => expect(loadSource).toHaveBeenCalledTimes(2));
  await act(async () =>
    sources[1]!.resolve({
      blob: new Blob(['source']),
      fileName: 'image.png',
      mimeType: 'image/png',
    }),
  );
  await vi.waitFor(() => expect(container.querySelector('[aria-label="cancel"]')).not.toBeNull());
  act(() => (container.querySelector('[aria-label="cancel"]') as HTMLButtonElement).click());
  act(() => {
    pointer('pointerdown');
    pointer('pointerup');
    click();
  });
  expect(activated).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});
