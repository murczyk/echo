/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { MessageCardAttachmentPreviewStage } from '../MessageCardAttachmentPreviewStage';

// @test-scope regression: https://github.com/echoua/echo/issues/3520
it('keeps the preview open when selecting a playback rate from a portal #3520', () => {
  const onClose = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function PlaybackRateMenu({ onRateChange }: { onRateChange: (rate: number) => void }) {
    return createPortal(
      <div role="option" onClick={() => onRateChange(1.5)}>
        1.5x
      </div>,
      document.body,
    );
  }

  function Harness() {
    const [playbackRate, setPlaybackRate] = useState(1);

    return (
      <MessageCardAttachmentPreviewStage
        kind="video"
        onPrimaryClick={(_, region) => {
          if (region === 'background') onClose();
        }}
      >
        <div data-playback-rate={playbackRate} />
        <PlaybackRateMenu onRateChange={setPlaybackRate} />
      </MessageCardAttachmentPreviewStage>
    );
  }

  act(() => root.render(<Harness />));
  const option = document.body.querySelector('[role="option"]')!;
  act(() => {
    option.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    option.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    option.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20, detail: 1 }),
    );
  });

  expect(container.querySelector('[data-playback-rate="1.5"]')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  act(() => root.unmount());
  container.remove();
});
