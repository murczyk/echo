/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCardContent } from '../../MessageCardContent';
import {
  minimalInboxMessage,
  mockImageMediaEntry,
} from '../../../../rer-duty-neo/inbox-message-mocks';

const { getMediaSummary } = vi.hoisted(() => ({ getMediaSummary: vi.fn() }));

vi.mock('../../../../../services/api/media-summary', () => ({
  getMediaSummary,
  retryMediaSummary: vi.fn(),
}));

describe('MessageCardContent media collapse', () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root?.unmount();
      container?.remove();
    });
  });

  beforeEach(() => {
    getMediaSummary.mockResolvedValue({
      state: 'completed',
      summary: 'Наявний опис вкладення',
      coordinates: [],
      lastError: null,
    });
  });

  it('ECHO-3324 renders supplied image summaries and suppresses selection when disabled', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const msg = minimalInboxMessage({
      media: [
        mockImageMediaEntry({
          id: 'summarized-image',
          summary: { state: 'completed', lastError: null, hasCoordinates: false },
        }),
      ],
    });

    await act(async () => {
      root.render(<MessageCardContent messageId={1} msg={msg} tagsMap={{}} mediaSummaryEnabled />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-media-summary-carousel="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Наявний опис вкладення');
    expect(container.querySelector('[data-summary-selected="true"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <MessageCardContent messageId={1} msg={msg} tagsMap={{}} mediaSummaryEnabled={false} />,
      );
    });

    expect(container.querySelector('[data-media-summary-carousel="true"]')).toBeNull();
    expect(container.querySelector('[data-summary-selected="true"]')).toBeNull();
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('ECHO-3324 scopes supplied video, previewable-document, and download summaries', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const completed = { state: 'completed' as const, lastError: null, hasCoordinates: false };
    const msg = minimalInboxMessage({
      media: [
        {
          id: 'summary-video',
          href: 'https://example.test/summary.mp4',
          contentType: 'video/mp4',
          fileName: 'summary.mp4',
          sizeBytes: 10,
          summary: completed,
        },
        {
          id: 'summary-pdf',
          href: 'https://example.test/summary.pdf',
          contentType: 'application/pdf',
          fileName: 'summary.pdf',
          sizeBytes: 10,
          summary: completed,
        },
        {
          id: 'summary-download',
          href: 'https://example.test/summary.bin',
          contentType: 'application/octet-stream',
          fileName: 'summary.bin',
          sizeBytes: 10,
          summary: completed,
        },
      ],
    });

    await act(async () => {
      root.render(
        <MessageCardContent
          messageId={1}
          msg={msg}
          tagsMap={{}}
          collapseMediaPreviews
          mediaSummaryEnabled
        />,
      );
      await Promise.resolve();
    });

    const media = container.querySelector('[data-attachment-kind="media"]') as HTMLButtonElement;
    const documents = container.querySelector(
      '[data-attachment-kind="documents"]',
    ) as HTMLButtonElement;
    await act(async () => media.click());
    expect(container.querySelector('[data-media-summary-carousel="true"]')).not.toBeNull();
    expect(container.querySelector('[data-media-summary-navigation]')).toBeNull();

    await act(async () => documents.click());
    expect(container.querySelector('[data-media-summary-navigation]')?.textContent).toContain(
      '1/2',
    );

    await act(async () => {
      root.render(
        <MessageCardContent
          messageId={1}
          msg={msg}
          tagsMap={{}}
          collapseMediaPreviews={false}
          mediaSummaryEnabled
        />,
      );
    });
    expect(container.querySelector('[data-media-summary-navigation]')?.textContent).toContain(
      '2/3',
    );
  });

  it('ECHO-3324 hides audio players until its independent attachment control is expanded', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const msg = minimalInboxMessage({
      media: [
        {
          id: 'a1',
          href: 'https://example.test/a.wav',
          contentType: 'audio/wav',
          fileName: 'a.wav',
          sizeBytes: 10,
        },
      ],
    });

    await act(async () => {
      root.render(
        <MessageCardContent messageId={1} msg={msg} tagsMap={{}} collapseMediaPreviews />,
      );
    });

    expect(container.querySelector('custom-audio-player')).toBeNull();
    const button = container.querySelector('[data-attachment-kind="audio"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      button.click();
    });
    expect(container.querySelector('custom-audio-player')).not.toBeNull();
  });

  it.each([
    [
      [
        {
          id: 'document',
          href: 'https://example.test/a.txt',
          contentType: 'text/plain',
          fileName: 'a.txt',
        },
      ],
    ],
    [
      [
        {
          id: 'download',
          href: 'https://example.test/a.bin',
          contentType: 'application/octet-stream',
          fileName: 'a.bin',
        },
      ],
    ],
  ])('ECHO-3324 exposes documents and downloads through their shared section', async (media) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardContent
          messageId={1}
          msg={minimalInboxMessage({ media })}
          tagsMap={{}}
          collapseMediaPreviews
        />,
      );
    });

    const button = container.querySelector(
      '[data-attachment-kind="documents"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('1');
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('ECHO-3324 classifies media, documents, and audio into exclusive sections', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardContent
          messageId={1}
          msg={minimalInboxMessage({
            images: ['https://example.test/image.png'],
            media: [
              {
                id: 'image-duplicate',
                href: 'https://example.test/image.png',
                contentType: 'image/png',
                fileName: 'image.png',
              },
              {
                id: 'video',
                href: 'https://example.test/video.mp4',
                contentType: 'video/mp4',
                fileName: 'video.mp4',
              },
              {
                id: 'document',
                href: 'https://example.test/document.txt',
                contentType: 'text/plain',
                fileName: 'document.txt',
              },
              {
                id: 'download',
                href: 'https://example.test/download.bin',
                contentType: 'application/octet-stream',
                fileName: 'download.bin',
              },
              {
                id: 'audio',
                href: 'https://example.test/audio.wav',
                contentType: 'audio/wav',
                fileName: 'audio.wav',
              },
            ],
          })}
          tagsMap={{}}
          collapseMediaPreviews
        />,
      );
    });

    const media = container.querySelector('[data-attachment-kind="media"]') as HTMLButtonElement;
    const documents = container.querySelector(
      '[data-attachment-kind="documents"]',
    ) as HTMLButtonElement;
    const audio = container.querySelector('[data-attachment-kind="audio"]') as HTMLButtonElement;
    expect(media.textContent).toContain('2');
    expect(documents.textContent).toContain('2');
    expect(media.getAttribute('aria-expanded')).toBe('false');
    expect(audio.getAttribute('aria-expanded')).toBe('false');

    await act(async () => audio.click());
    expect(audio.getAttribute('aria-expanded')).toBe('true');
    await act(async () => media.click());
    expect(media.getAttribute('aria-expanded')).toBe('true');
    expect(audio.getAttribute('aria-expanded')).toBe('false');
    await act(async () => media.click());
    expect(media.getAttribute('aria-expanded')).toBe('false');
    expect(audio.getAttribute('aria-expanded')).toBe('false');
  });

  it('ECHO-3324 renders all attachment categories without controls when collapsing is disabled', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardContent
          messageId={1}
          msg={minimalInboxMessage({
            media: [
              {
                id: 'download',
                href: 'https://example.test/a.bin',
                contentType: 'application/octet-stream',
                fileName: 'a.bin',
              },
            ],
          })}
          tagsMap={{}}
          collapseMediaPreviews={false}
        />,
      );
    });

    expect(container.querySelector('.message-card-attachment-counters')).toBeNull();
    expect(container.querySelector('a[download="a.bin"]')).not.toBeNull();
  });
});
