/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { useImageAttachmentEditorSession } from './use-image-attachment-editor-session';

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
