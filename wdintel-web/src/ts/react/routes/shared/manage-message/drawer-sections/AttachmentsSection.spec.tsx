/**
 * @vitest-environment happy-dom
 */
import { FormProvider, useForm } from 'react-hook-form';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsSection } from './AttachmentsSection';
import { EMPTY_FORM_VALUES, type MessageFormData } from '../manage-message-drawer.schema';

function Form({ children }: { children: ReactNode }) {
  const methods = useForm<MessageFormData>({ defaultValues: EMPTY_FORM_VALUES });
  return createElement(FormProvider, methods, children);
}

async function renderSection(files: unknown[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Form>
        <AttachmentsSection
          uppy={{} as never}
          uppyFiles={files as never[]}
          fileInputRef={{ current: null }}
          handleFileSelect={vi.fn()}
          handleDrop={vi.fn()}
          handleDropzoneKeyDown={vi.fn()}
          busy={false}
        />
      </Form>,
    );
  });
  return { container, root };
}

function pendingFile(id: string, name: string, type: string) {
  return {
    id,
    name,
    type,
    size: 4,
    data: new Blob(['media'], { type }),
    progress: { percentage: 0, uploadStarted: null, uploadComplete: false },
  };
}

describe('AttachmentsSection local media previews', () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

  afterEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
  });

  it('renders image thumbnails for pending image files', async () => {
    const { container, root } = await renderSection([
      pendingFile('image', 'photo.JPG', 'image/jpeg'),
    ]);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(container.querySelector('img[src="blob:local"]')).not.toBeNull();
    expect(createObjectURL).toHaveBeenCalledOnce();
    act(() => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });

  it('renders paused video previews with a play affordance', async () => {
    const { container, root } = await renderSection([
      pendingFile('video', 'clip.MP4', 'video/mp4'),
    ]);
    const video = container.querySelector('video');

    expect(video?.getAttribute('src')).toBe('blob:local');
    expect(video?.getAttribute('autoplay')).toBeNull();
    expect(video?.muted).toBe(true);
    expect(container.querySelector('svg')).not.toBeNull();
    act(() => root.unmount());
  });

  it('keeps the icon fallback for unknown MIME types and broken previews', async () => {
    const unknown = await renderSection([pendingFile('unknown', 'photo.jpg', '')]);
    expect(unknown.container.querySelector('img')).toBeNull();
    expect(unknown.container.querySelector('svg')).not.toBeNull();
    act(() => unknown.root.unmount());

    const broken = await renderSection([pendingFile('broken', 'photo.jpg', 'image/jpeg')]);
    act(() => broken.container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(broken.container.querySelector('img')).toBeNull();
    expect(broken.container.querySelector('svg')).not.toBeNull();
    act(() => broken.root.unmount());
  });

  it('revokes a preview URL when its pending file is removed', async () => {
    const file = pendingFile('image', 'photo.png', 'image/png');
    const { container, root } = await renderSection([file]);
    act(() => {
      root.render(
        <Form>
          <AttachmentsSection
            uppy={{} as never}
            uppyFiles={[]}
            fileInputRef={{ current: null }}
            handleFileSelect={vi.fn()}
            handleDrop={vi.fn()}
            handleDropzoneKeyDown={vi.fn()}
            busy={false}
          />
        </Form>,
      );
    });
    expect(container.querySelector('img')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
    act(() => root.unmount());
  });
});
