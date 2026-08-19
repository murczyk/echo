/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatMessageAudioRevealLabel,
  formatMessageVisualRevealLabel,
  MessageCardMediaRevealBanner,
  MESSAGE_CARD_AUDIO_REVEAL_ICON,
} from '../../MessageCardMediaRevealBanner';
import { MessageCardContent } from '../../MessageCardContent';
import { minimalInboxMessage } from '../../../../rer-duty-neo/inbox-message-mocks';

describe('message media reveal labels', () => {
  it('formats audio and mixed visuals', () => {
    expect(formatMessageAudioRevealLabel(1)).toBe('1 аудіо');
    expect(formatMessageAudioRevealLabel(3)).toBe('3 аудіо');
    expect(formatMessageVisualRevealLabel(2, 1)).toBe('2 фото · 1 відео');
    expect(formatMessageVisualRevealLabel(0, 2)).toBe('2 відео');
  });
});

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

  it('renders the banner control with the expected attributes', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    let clicked = false;
    await act(async () => {
      root.render(
        <MessageCardMediaRevealBanner
          kind="audio"
          label="1 аудіо"
          icon={MESSAGE_CARD_AUDIO_REVEAL_ICON}
          onReveal={() => {
            clicked = true;
          }}
        />,
      );
    });
    const button = container.querySelector(
      '[data-message-media-reveal="audio"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Показати 1 аудіо');
    await act(async () => {
      button.click();
    });
    expect(clicked).toBe(true);
  });
});
