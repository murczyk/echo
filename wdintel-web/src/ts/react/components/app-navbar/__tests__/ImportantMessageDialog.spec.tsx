/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const importantAdd = vi.hoisted(() => vi.fn());
const currentSystemSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/inbox-message-actions', () => ({ importantAdd }));
vi.mock('../../../services/api/system-settings', () => ({ currentSystemSettings }));

import {
  IMPORTANT_MESSAGE_REQUEST_EVENT,
  IMPORTANT_MESSAGE_UPDATED_EVENT,
  ImportantMessageDialog,
} from '../ImportantMessageDialog';

const roots: Root[] = [];

function renderDialog() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<ImportantMessageDialog />));
  return container;
}

async function requestImportantMessage(groupMasterKey: string | null = 'group-a') {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(IMPORTANT_MESSAGE_REQUEST_EVENT, {
        detail: { messageId: 17, groupMasterKey },
      }),
    );
  });
}

beforeEach(() => {
  currentSystemSettings.mockResolvedValue({ importantNotifyAllEnabled: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  importantAdd.mockReset();
  currentSystemSettings.mockReset();
});

describe('ImportantMessageDialog', () => {
  it('#3610 closes without mutation when cancelled', async () => {
    renderDialog();
    await requestImportantMessage();

    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Закрити')
        ?.click(),
    );

    expect(importantAdd).not.toHaveBeenCalled();
  });

  it('#3610 submits a personal mark when notification is switched off', async () => {
    const updated = vi.fn();
    importantAdd.mockResolvedValueOnce(true);
    window.addEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, updated);
    renderDialog();
    await requestImportantMessage();

    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Позначити')
        ?.click();
    });

    expect(importantAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 17,
        groupMasterKey: null,
        notifyGroup: false,
        operationId: expect.any(String),
      }),
    );
    expect(updated).toHaveBeenCalledOnce();
    window.removeEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, updated);
  });

  it('#3610 preserves notification selection after a submission failure', async () => {
    importantAdd.mockRejectedValueOnce(new Error('network failure'));
    renderDialog();
    await requestImportantMessage();

    await act(async () =>
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
    );
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Позначити')
        ?.click();
    });

    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(document.body.textContent).toContain('network failure');
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Позначити',
      )?.disabled,
    ).toBe(false);
  });

  it('#3610 resets notification selection when reopened after cancelling', async () => {
    renderDialog();
    await requestImportantMessage();
    act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);

    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Закрити')
        ?.click(),
    );
    await requestImportantMessage();

    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(importantAdd).not.toHaveBeenCalled();
  });

  it('#3987 marks directly without the dialog when notify-all is disabled', async () => {
    const updated = vi.fn();
    currentSystemSettings.mockResolvedValue({ importantNotifyAllEnabled: false });
    importantAdd.mockResolvedValueOnce(true);
    window.addEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, updated);
    renderDialog();
    await requestImportantMessage();

    expect(document.body.textContent).not.toContain('Сповістити всіх?');
    expect(importantAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 17,
        groupMasterKey: null,
        notifyGroup: false,
        operationId: expect.any(String),
      }),
    );
    expect(updated).toHaveBeenCalledOnce();
    expect((updated.mock.calls[0][0] as CustomEvent).detail).toEqual({
      messageId: 17,
      important: true,
    });
    window.removeEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, updated);
  });

  it('#3987 neither opens the dialog nor marks when settings fail to load', async () => {
    currentSystemSettings.mockRejectedValue(new Error('settings unavailable'));
    renderDialog();
    await requestImportantMessage();

    expect(document.body.textContent).not.toContain('Сповістити всіх?');
    expect(importantAdd).not.toHaveBeenCalled();
  });
});
