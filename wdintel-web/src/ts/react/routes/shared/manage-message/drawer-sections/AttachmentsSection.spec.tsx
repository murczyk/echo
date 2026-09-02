/**
 * @vitest-environment happy-dom
 */
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsSection } from './AttachmentsSection';
import { EMPTY_FORM_VALUES, type MessageFormData } from '../manage-message-drawer.schema';

const previewMocks = vi.hoisted(() => ({ imageEditing: null as any, reportDraft: null as any }));
const authRedirectMocks = vi.hoisted(() => ({ emitUnauthorizedEvent: vi.fn() }));
vi.mock('../../message-card/attachment-preview/MessageCardAttachmentPreviewProvider', () => ({
  MessageCardAttachmentPreviewProvider: ({
    imageEditing,
    reportDraft,
  }: {
    imageEditing: unknown;
    reportDraft?: unknown;
  }) => {
    previewMocks.imageEditing = imageEditing;
    previewMocks.reportDraft = reportDraft ?? null;
    return <div role="dialog" />;
  },
}));
vi.mock('../../../../auth-redirect', () => authRedirectMocks);

function Form({
  children,
  defaultValues = EMPTY_FORM_VALUES,
}: {
  children: ReactNode;
  defaultValues?: MessageFormData;
}) {
  const methods = useForm<MessageFormData>({ defaultValues });
  const fullBody = useWatch({ control: methods.control, name: 'full_body' }) ?? '';
  return createElement(
    FormProvider,
    methods,
    children,
    <output data-testid="full-body">{fullBody}</output>,
  );
}

async function renderSection(
  files: unknown[] = [],
  existingMedia: any[] = [],
  uppy: any = {},
  options: {
    reportTextPreviewEnabled?: boolean;
    initialReportText?: string;
  } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Form
        defaultValues={{
          ...EMPTY_FORM_VALUES,
          full_body: options.initialReportText ?? EMPTY_FORM_VALUES.full_body,
        }}
      >
        <AttachmentsSection
          uppy={uppy}
          uppyFiles={files as never[]}
          fileInputRef={{ current: null }}
          handleFileSelect={vi.fn()}
          handleDrop={vi.fn()}
          handleDropzoneKeyDown={vi.fn()}
          busy={false}
          existingMedia={existingMedia}
          reportTextPreviewEnabled={options.reportTextPreviewEnabled}
        />
      </Form>,
    );
  });
  return { container, root };
}

function pendingFile(id: string, name: string, type: string, meta: Record<string, string> = {}) {
  return {
    id,
    name,
    type,
    size: 4,
    data: new Blob(['media'], { type }),
    progress: { percentage: 0, uploadStarted: null, uploadComplete: false },
    meta,
  };
}

describe('AttachmentsSection media previews', () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    previewMocks.reportDraft = null;
    document.body.replaceChildren();
  });

  it('renders image thumbnails at the start of the row for pending image files', async () => {
    const { container, root } = await renderSection([
      pendingFile('image', 'photo.JPG', 'image/jpeg'),
    ]);

    expect(createObjectURL).toHaveBeenCalledOnce();
    const preview = container.querySelector('img[src="blob:local"]');
    const filename = container.querySelector('p[title="photo.JPG"]');
    const moreBtn = container.querySelector('button[aria-label="Більше дій для photo.JPG"]');
    const deleteBtn = container.querySelector('button[aria-label="Видалити photo.JPG"]');

    expect(preview).not.toBeNull();
    expect(moreBtn).not.toBeNull();
    expect(deleteBtn).not.toBeNull();
    // Preview thumbnail is at the start (before filename)
    expect(preview?.compareDocumentPosition(filename!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // More button is after metadata, before delete button
    expect(moreBtn?.compareDocumentPosition(deleteBtn!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    act(() => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });

  it('renders paused video previews with a play affordance at the start of the row', async () => {
    const { container, root } = await renderSection([
      pendingFile('video', 'clip.MP4', 'video/mp4'),
    ]);
    const video = container.querySelector('video');
    const filename = container.querySelector('p[title="clip.MP4"]');

    expect(video?.getAttribute('src')).toBe('blob:local');
    expect(video?.getAttribute('autoplay')).toBeNull();
    expect(video?.muted).toBe(true);
    expect(video?.compareDocumentPosition(filename!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    act(() => root.unmount());
  });

  it('offers image editing before download but omits it for non-image rows', async () => {
    const image = await renderSection([pendingFile('image', 'photo.png', 'image/png')]);
    await act(async () => {
      image.container
        .querySelector('button[aria-label="Більше дій для photo.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      Array.from(document.body.querySelectorAll('li[role="menuitem"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual(['Редагувати', 'Завантажити']);
    act(() => image.root.unmount());

    const documentRow = await renderSection([
      pendingFile('document', 'report.pdf', 'application/pdf'),
    ]);
    await act(async () => {
      documentRow.container
        .querySelector('button[aria-label="Більше дій для report.pdf"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.document.body.textContent).not.toContain('Редагувати');
    act(() => documentRow.root.unmount());
  });

  it('offers editing for a PNG filename when its MIME type is empty #3099', async () => {
    const image = await renderSection([pendingFile('image', 'photo.png', '')]);
    await act(async () => {
      image.container
        .querySelector('button[aria-label="Більше дій для photo.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.document.body.textContent).toContain('Редагувати');
    act(() => image.root.unmount());
  });

  it('keeps the icon in the start slot for non-media files and broken previews', async () => {
    const unknown = await renderSection([pendingFile('unknown', 'data.bin', '')]);
    expect(unknown.container.querySelector('img')).toBeNull();
    const icon = unknown.container.querySelector('svg');
    const filename = unknown.container.querySelector('p[title="data.bin"]');
    expect(icon).not.toBeNull();
    expect(icon?.compareDocumentPosition(filename!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

  it('refreshes a local preview when a same-ID file receives replacement data', async () => {
    const file = pendingFile('image', 'photo.png', 'image/png');
    const { root } = await renderSection([file]);
    const replacement = { ...file, data: new Blob(['replacement'], { type: 'image/png' }) };

    act(() => {
      root.render(
        <Form>
          <AttachmentsSection
            uppy={{} as never}
            uppyFiles={[replacement] as never[]}
            fileInputRef={{ current: null }}
            handleFileSelect={vi.fn()}
            handleDrop={vi.fn()}
            handleDropzoneKeyDown={vi.fn()}
            busy={false}
          />
        </Form>,
      );
    });

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
    act(() => root.unmount());
  });

  it('retries a failed local preview when replacement data keeps the same ID', async () => {
    const file = pendingFile('image', 'photo.png', 'image/png');
    const { container, root } = await renderSection([file]);
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();

    const replacement = { ...file, data: new Blob(['replacement'], { type: 'image/png' }) };
    await act(async () => {
      root.render(
        <Form>
          <AttachmentsSection
            uppy={{} as never}
            uppyFiles={[replacement] as never[]}
            fileInputRef={{ current: null }}
            handleFileSelect={vi.fn()}
            handleDrop={vi.fn()}
            handleDropzoneKeyDown={vi.fn()}
            busy={false}
          />
        </Form>,
      );
    });

    expect(container.querySelector('img')).not.toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('renders previews for existing image and video media in edit mode', async () => {
    const existingMedia = [
      {
        id: 'media-1',
        fileName: 'existing-image.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        href: 'https://example.com/existing-image.png',
        transcription: null,
      },
      {
        id: 'media-2',
        fileName: 'existing-video.mp4',
        contentType: 'video/mp4',
        sizeBytes: 2048,
        href: 'https://example.com/existing-video.mp4',
        transcription: null,
      },
      {
        id: 'media-3',
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
        href: 'https://example.com/report.pdf',
        transcription: null,
      },
    ];

    const { container, root } = await renderSection([], existingMedia);

    const img = container.querySelector('img[src="https://example.com/existing-image.png"]');
    expect(img).not.toBeNull();

    const video = container.querySelector('video[src="https://example.com/existing-video.mp4"]');
    expect(video).not.toBeNull();

    // PDF should render icon in the start slot
    const pdfRow = container.querySelector(
      'button[aria-label="Видалити report.pdf"]',
    )?.parentElement;
    expect(pdfRow?.querySelector('img')).toBeNull();
    expect(pdfRow?.querySelector('video')).toBeNull();
    expect(pdfRow?.querySelector('svg')).not.toBeNull();

    // More buttons exist
    expect(
      container.querySelector('button[aria-label="Більше дій для existing-image.png"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Більше дій для report.pdf"]'),
    ).not.toBeNull();

    act(() => root.unmount());
  });

  it('anchors an existing-media replacement once at its original logical position', async () => {
    const existingMedia = [
      {
        id: 'first',
        fileName: 'first.png',
        contentType: 'image/png',
        sizeBytes: 1,
        href: 'https://example.com/first.png',
      },
      {
        id: 'middle',
        fileName: 'middle.png',
        contentType: 'image/png',
        sizeBytes: 1,
        href: 'https://example.com/middle.png',
      },
      {
        id: 'last',
        fileName: 'last.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        href: 'https://example.com/last.pdf',
      },
    ];
    const replacement = pendingFile('replacement', 'middle-edited.png', 'image/png', {
      replaces_media_id: 'middle',
    });
    const { container, root } = await renderSection([replacement], existingMedia);

    const names = Array.from(container.querySelectorAll('p[title]')).map((node) =>
      node.getAttribute('title'),
    );
    expect(names).toEqual(['first.png', 'middle-edited.png', 'last.pdf']);
    expect(container.querySelectorAll('p[title="middle-edited.png"]')).toHaveLength(1);
    expect(container.textContent).toContain('Вкладення (3)');
    act(() => root.unmount());
  });

  it('allows another persisted replacement at the attachment cap #3099', async () => {
    const existingMedia = Array.from({ length: 20 }, (_, index) => ({
      id: `media-${index}`,
      fileName: `image-${index}.png`,
      contentType: 'image/png',
      href: `https://example.test/${index}.png`,
    }));
    const firstReplacement = pendingFile('replacement-1', 'edited-1.png', 'image/png', {
      replaces_media_id: 'media-0',
    });
    const uppy = {
      getFile: vi.fn(() => undefined),
      getFiles: vi.fn(() => [firstReplacement]),
      addFile: vi.fn(),
    };
    const { container, root } = await renderSection([firstReplacement], existingMedia, uppy);
    await act(async () => {
      container
        .querySelector('button[aria-label="Переглянути image-1.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(
      previewMocks.imageEditing.applyReplacement(existingMedia[1], {
        file: new File(['edited'], 'edited-2.png', { type: 'image/png' }),
      }),
    ).resolves.toBeUndefined();
    expect(uppy.addFile).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { replaces_media_id: 'media-1' } }),
    );
    act(() => root.unmount());
  });

  it('handles a same-origin unauthorized editor source response before rejecting', async () => {
    const image = {
      id: 'media-1',
      fileName: 'existing-image.png',
      contentType: 'image/png',
      href: new URL('/existing-image.png', window.location.href).href,
    };
    const uppy = { getFile: vi.fn(() => undefined) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const { root } = await renderSection([], [image], uppy);

    await expect(
      previewMocks.imageEditing.loadSource(image, new AbortController().signal),
    ).rejects.toThrow('Не вдалося завантажити зображення для редагування');
    expect(authRedirectMocks.emitUnauthorizedEvent).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it('adds an edited image as a distinct attachment and rejects it at the cap', async () => {
    const existingMedia = [
      {
        id: 'media-1',
        fileName: 'original.png',
        contentType: 'image/png',
        href: 'https://example.test/original.png',
      },
    ];
    const uppy = { addFile: vi.fn(), getFile: vi.fn(), getFiles: vi.fn(() => []) };
    const { container, root } = await renderSection([], existingMedia, uppy);
    await act(async () => {
      container
        .querySelector('button[aria-label="Переглянути original.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(
      previewMocks.imageEditing.addAsNew(existingMedia[0], {
        file: new File(['edited'], 'original.png', { type: 'image/png' }),
      }),
    ).resolves.toBeUndefined();
    expect(uppy.addFile).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.any(File), id: expect.any(String) }),
    );
    expect(uppy.addFile.mock.calls[0][0].meta).toBeUndefined();
    act(() => root.unmount());

    const cappedMedia = Array.from({ length: 20 }, (_, index) => ({
      id: `media-${index}`,
      fileName: `image-${index}.png`,
      contentType: 'image/png',
      href: `https://example.test/${index}.png`,
    }));
    const capped = await renderSection([], cappedMedia, uppy);
    await act(async () => {
      capped.container
        .querySelector('button[aria-label="Переглянути image-0.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(
      previewMocks.imageEditing.addAsNew(cappedMedia[0], {
        file: new File(['edited'], 'new.png', { type: 'image/png' }),
      }),
    ).rejects.toThrow('Перевищено максимальну кількість вкладень (20)');
    expect(uppy.addFile).toHaveBeenCalledTimes(1);
    act(() => capped.root.unmount());
  });

  it('opens attachment preview dialog when clicking on a preview thumbnail', async () => {
    const existingMedia = [
      {
        id: 'media-1',
        fileName: 'screenshot.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        href: 'https://example.com/screenshot.png',
        transcription: null,
      },
    ];

    const { container, root } = await renderSection(
      [pendingFile('img-2', 'new-photo.jpg', 'image/jpeg')],
      existingMedia,
    );

    const previewButtons = container.querySelectorAll('button[aria-label^="Переглянути "]');
    expect(previewButtons.length).toBe(2);

    // Click on the first preview (existing media because existing comes first)
    await act(async () => {
      (previewButtons[0] as HTMLElement).click();
    });

    const dialog = document.body.querySelector('div[role="dialog"]');
    expect(dialog).not.toBeNull();

    act(() => root.unmount());
  });

  it('triggers download when download menu item is clicked', async () => {
    const linkClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const existingMedia = [
      {
        id: 'media-1',
        fileName: 'document.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        href: 'https://example.com/document.pdf',
        transcription: null,
      },
    ];

    const { container, root } = await renderSection([], existingMedia);
    const moreBtn = container.querySelector('button[aria-label="Більше дій для document.pdf"]');
    expect(moreBtn).not.toBeNull();

    await act(async () => {
      (moreBtn as HTMLElement).click();
    });

    const downloadMenuItem = document.body.querySelector('li[role="menuitem"]');
    expect(downloadMenuItem).not.toBeNull();

    await act(async () => {
      (downloadMenuItem as HTMLElement).click();
    });

    expect(linkClickSpy).toHaveBeenCalled();
    linkClickSpy.mockRestore();
    act(() => root.unmount());
  });

  it('opens attachment preview dialog when clicking on document icon', async () => {
    const existingMedia = [
      {
        id: 'media-doc',
        fileName: 'table.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 2048,
        href: 'https://example.com/table.xlsx',
        transcription: null,
      },
    ];

    const { container, root } = await renderSection([], existingMedia);
    const previewBtn = container.querySelector('button[aria-label="Переглянути table.xlsx"]');
    expect(previewBtn).not.toBeNull();

    await act(async () => {
      (previewBtn as HTMLElement).click();
    });

    const dialog = document.body.querySelector('div[role="dialog"]');
    expect(dialog).not.toBeNull();

    act(() => root.unmount());
  });

  it('shares report text with the attachment preview draft in report mode', async () => {
    const existingMedia = [
      {
        id: 'media-doc',
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        href: 'https://example.com/report.pdf',
        transcription: null,
      },
    ];

    const { container, root } = await renderSection(
      [],
      existingMedia,
      {},
      {
        reportTextPreviewEnabled: true,
        initialReportText: 'Початковий текст',
      },
    );

    await act(async () => {
      container
        .querySelector('button[aria-label="Переглянути report.pdf"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(previewMocks.reportDraft?.value).toBe('Початковий текст');

    await act(async () => {
      previewMocks.reportDraft?.onChange('Оновлений текст');
    });

    expect(container.querySelector('[data-testid="full-body"]')?.textContent).toBe(
      'Оновлений текст',
    );
    act(() => root.unmount());
  });
});
