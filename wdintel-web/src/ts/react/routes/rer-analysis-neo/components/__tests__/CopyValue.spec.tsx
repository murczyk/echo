/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardMock = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
vi.mock('../../../../../copy-to-clipboard', () => clipboardMock);
const snackbarMock = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => snackbarMock,
}));

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
    snackbarMock.notify.mockReset();
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

  describe('the snackbar', () => {
    const phone = (matches: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }));
    afterEach(() => vi.unstubAllGlobals());

    it('is raised on a phone, which has no hover, also when the clipboard refuses', async () => {
      phone(true);
      clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
      await mount();
      await click();
      expect(snackbarMock.notify).toHaveBeenCalledWith({
        severity: 'success',
        message: 'Скопійовано.',
      });
      clipboardMock.copyTextToClipboard.mockRejectedValue(new Error('denied'));
      await click();
      expect(snackbarMock.notify).toHaveBeenLastCalledWith({
        severity: 'error',
        message: 'Не вдалося скопіювати.',
      });
    });

    it('is not raised on a wide screen, where the tooltip says it', async () => {
      phone(false);
      clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
      await mount();
      await click();
      expect(tooltip()).toBe('Скопійовано');
      expect(snackbarMock.notify).not.toHaveBeenCalled();
    });
  });

  it('does not pass the click on to the row it sits in', async () => {
    clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
    await mount();
    await click();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
