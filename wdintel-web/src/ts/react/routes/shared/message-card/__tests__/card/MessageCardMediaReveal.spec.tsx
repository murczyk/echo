/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageCardContent } from '../../MessageCardContent';
import { minimalInboxMessage } from '../../../../rer-duty-neo/inbox-message-mocks';

describe('MessageCardContent media collapse', () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root?.unmount();
      container?.remove();
    });
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
  ])('ECHO-3324 exposes document and download-only media while collapsed', async (media) => {
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

    const button = container.querySelector('[data-attachment-kind="media"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('1');
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('ECHO-3324 counts each media attachment once and keeps audio state independent', async () => {
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
    const audio = container.querySelector('[data-attachment-kind="audio"]') as HTMLButtonElement;
    expect(media.textContent).toContain('4');
    expect(media.getAttribute('aria-expanded')).toBe('false');
    expect(audio.getAttribute('aria-expanded')).toBe('false');

    await act(async () => audio.click());
    expect(audio.getAttribute('aria-expanded')).toBe('true');
    await act(async () => media.click());
    expect(media.getAttribute('aria-expanded')).toBe('true');
    expect(audio.getAttribute('aria-expanded')).toBe('true');
    await act(async () => media.click());
    expect(media.getAttribute('aria-expanded')).toBe('false');
    expect(audio.getAttribute('aria-expanded')).toBe('true');
  });

  it('ECHO-3324 initializes available media sections expanded when collapsing is disabled', async () => {
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

    expect(
      container.querySelector('[data-attachment-kind="media"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });
});
