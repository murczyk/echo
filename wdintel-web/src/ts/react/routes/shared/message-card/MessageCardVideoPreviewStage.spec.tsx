/**
 * @vitest-environment happy-dom
 */
import { createRef, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  CircularProgress: () => <span data-progress />,
  Typography: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/PlayArrow', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Pause', () => ({ default: () => <span /> }));

import { MessageCardVideoPreviewStage } from './MessageCardVideoPreviewStage';

describe('MessageCardVideoPreviewStage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('explains that pending media is being downloaded and decrypted', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardVideoPreviewStage
          src="/api/messenger/media/video-1"
          isPlaying={false}
          onPlay={vi.fn()}
          onPause={vi.fn()}
          onEnded={vi.fn()}
          videoRef={createRef<HTMLVideoElement>()}
        />,
      );
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Скачування та розшифровка медіа',
    );
    expect(container.querySelector('[data-progress]')).not.toBeNull();

    await act(async () => {
      container.querySelector('video')?.dispatchEvent(new Event('canplay', { bubbles: true }));
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    root.unmount();
  });
});
