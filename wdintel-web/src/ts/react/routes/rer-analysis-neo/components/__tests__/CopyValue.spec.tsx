/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardMock = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
vi.mock('../../../../../copy-to-clipboard', () => clipboardMock);

import { CopyValue } from '../CopyValue';

describe('CopyValue', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onParentClick = vi.fn();

  const mount = () =>
    act(async () =>
      root.render(
        <div onClick={onParentClick}>
          <CopyValue text="@masu">@masu</CopyValue>
        </div>,
      ),
    );
  const click = () => act(async () => container.querySelector('button')?.click());
  // The tooltip text is also the label of the button.
  const tooltip = () => container.querySelector('button')?.getAttribute('aria-label') ?? null;

  beforeEach(() => {
    vi.useFakeTimers();
    clipboardMock.copyTextToClipboard.mockReset();
    onParentClick.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('copies the text and says so for a moment', async () => {
    clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
    await mount();
    await click();
    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith('@masu');
    expect(tooltip()).toBe('Скопійовано');

    await act(async () => vi.advanceTimersByTime(1600));
    expect(tooltip()).toBe('копіювати');
  });

  it('says so when the clipboard refuses', async () => {
    clipboardMock.copyTextToClipboard.mockRejectedValue(new Error('denied'));
    await mount();
    await click();
    expect(tooltip()).toBe('Не вдалося скопіювати');
  });

  it('does not pass the click on to the row it sits in', async () => {
    clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
    await mount();
    await click();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
