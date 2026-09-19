/**
 * @vitest-environment happy-dom
 */
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentClickAway } from '../use-document-click-away';

function TestComponent({ enabled, onClickAway }: { enabled: boolean; onClickAway: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useDocumentClickAway({
    enabled,
    refs: [panelRef],
    ignoreSelectors: ['.MuiModal-root'],
    onClickAway,
  });

  return (
    <div>
      <div ref={panelRef} data-testid="panel">
        Panel
      </div>
      <div className="MuiModal-root">
        <button type="button" data-testid="modal-button">
          Modal action
        </button>
      </div>
      <div className="MuiPopover-root">
        <button type="button">Popover action</button>
      </div>
      <button type="button" data-testid="outside-button">
        Outside
      </button>
    </div>
  );
}

describe('useDocumentClickAway', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });
  it('ignores clicks inside portal roots matched by selectors', async () => {
    const onClickAway = vi.fn();

    await act(async () => {
      root.render(<TestComponent enabled onClickAway={onClickAway} />);
    });

    const modalButton = container.querySelector('[data-testid="modal-button"]');
    expect(modalButton).not.toBeNull();

    await act(async () => {
      modalButton?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(onClickAway).not.toHaveBeenCalled();
  });
  it('fires when clicking outside both the panel and ignored portal roots', async () => {
    const onClickAway = vi.fn();

    await act(async () => {
      root.render(<TestComponent enabled onClickAway={onClickAway} />);
    });

    const outsideButton = container.querySelector('[data-testid="outside-button"]');
    expect(outsideButton).not.toBeNull();

    await act(async () => {
      outsideButton?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(onClickAway).toHaveBeenCalledTimes(1);
  });
});
