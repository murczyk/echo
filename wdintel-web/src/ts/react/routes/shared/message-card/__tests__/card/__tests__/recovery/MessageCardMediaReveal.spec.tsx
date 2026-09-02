/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageCardContent } from '../../../../MessageCardContent';
import { minimalInboxMessage } from '../../../../../../rer-duty-neo/inbox-message-mocks';

// @test-scope safeguard: keeps collapsed media inaccessible until the user explicitly reveals it.
describe('MessageCardContent media collapse', () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root?.unmount();
      container?.remove();
    });
  });

  it('hides audio players behind a reveal banner until clicked', async () => {
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
    const banner = container.querySelector(
      '[data-message-media-reveal="audio"]',
    ) as HTMLButtonElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('1 аудіо');

    await act(async () => {
      banner.click();
    });
    expect(container.querySelector('custom-audio-player')).not.toBeNull();
  });
});
