/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard, copyTextToClipboardInPlace } from './copy-to-clipboard';

function mockClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function mockExecCommand(result: boolean) {
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  document.querySelectorAll('textarea').forEach((textarea) => textarea.remove());
});

describe('copyTextToClipboard', () => {
  it('uses the Clipboard API when it succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = mockExecCommand(false);
    mockClipboard(writeText);

    await expect(copyTextToClipboard('login-id')).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('login-id');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('resolves when the Clipboard API rejects but the fallback succeeds', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    const execCommand = mockExecCommand(true);
    mockClipboard(writeText);

    await expect(copyTextToClipboard('login-id')).resolves.toBeUndefined();

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when the Clipboard API rejects and the fallback returns false', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    mockExecCommand(false);
    mockClipboard(writeText);

    await expect(copyTextToClipboard('login-id')).rejects.toThrow('Copy command was rejected');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when the Clipboard API is unavailable and the fallback returns false', async () => {
    mockExecCommand(false);
    mockClipboard();

    await expect(copyTextToClipboard('login-id')).rejects.toThrow('Copy command was rejected');
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('copyTextToClipboardInPlace', () => {
  function mockCopyEvent(data: Map<string, string>) {
    return mockExecCommand(true).mockImplementation(() => {
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => data.set(type, value) },
      });
      document.dispatchEvent(event);
      return true;
    });
  }

  it('#4182 writes HTML with a plain-text alternative through the Clipboard API', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    );
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });

    await expect(copyTextToClipboardInPlace('Звіт', '<b>Звіт</b>')).resolves.toBeUndefined();

    const [[[item]]] = write.mock.calls;
    expect(await item.items['text/html'].text()).toBe('<b>Звіт</b>');
    expect(await item.items['text/plain'].text()).toBe('Звіт');
  });

  it('#4182 writes plain text alone through the Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = mockExecCommand(true);
    mockClipboard(writeText);

    await expect(copyTextToClipboardInPlace('# Звіт')).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('# Звіт');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['both formats', '<b>Звіт</b>', { 'text/html': '<b>Звіт</b>', 'text/plain': 'Звіт' }],
    ['plain text', undefined, { 'text/plain': 'Звіт' }],
  ])(
    '#4182 falls back to a copy event with %s, without moving focus',
    async (_, html, expected) => {
      const data = new Map<string, string>();
      mockCopyEvent(data);
      mockClipboard();
      const focused = document.createElement('button');
      document.body.appendChild(focused);
      focused.focus();

      await expect(copyTextToClipboardInPlace('Звіт', html)).resolves.toBeUndefined();

      expect(Object.fromEntries(data)).toEqual(expected);
      expect(document.activeElement).toBe(focused);
      expect(document.querySelector('textarea')).toBeNull();
      focused.remove();
    },
  );

  it('#4182 falls back to a copy event when the Clipboard API rejects', async () => {
    const data = new Map<string, string>();
    mockCopyEvent(data);
    mockClipboard(vi.fn().mockRejectedValue(new Error('denied')));

    await expect(copyTextToClipboardInPlace('Звіт')).resolves.toBeUndefined();

    expect(Object.fromEntries(data)).toEqual({ 'text/plain': 'Звіт' });
  });

  it('#4182 rejects when no copy method works', async () => {
    mockExecCommand(false);
    mockClipboard();

    await expect(copyTextToClipboardInPlace('Звіт', '<b>Звіт</b>')).rejects.toThrow(
      'Copy command was rejected',
    );
  });
});
