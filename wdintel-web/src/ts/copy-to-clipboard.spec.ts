/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard } from './copy-to-clipboard';

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
