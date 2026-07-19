/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/system-settings', () => ({
  listSystemSettings: mocks.list,
  createSystemSettings: mocks.save,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));
vi.mock('../../components/PowerButton', () => ({
  PowerButton: ({
    children,
    onClick,
    type = 'button',
    disabled,
    ...props
  }: {
    children: unknown;
    onClick?: () => void;
    type?: 'button' | 'submit';
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));
vi.mock('../admin-control-panel-neo', () => ({ AdminControlPanelNeoSection: () => null }));

import { AdminSystemSettingsNeoPage } from './index';

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminSystemSettingsNeoPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

describe('AdminSystemSettingsNeoPage success notifications', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue([]);
    mocks.save.mockResolvedValue(undefined);
    mocks.notify.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves a changed boolean and notifies after the API resolves', async () => {
    let resolveSave!: () => void;
    mocks.save.mockReturnValue(new Promise<void>((resolve) => (resolveSave = resolve)));
    const { container, root } = await renderPage();
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox?.click());
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('зберегти'),
    );
    expect(saveButton).not.toBeUndefined();
    await act(async () => saveButton?.click());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.notify).not.toHaveBeenCalled();
    resolveSave();
    await act(async () => Promise.resolve());
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Нове системне налаштування збережено.',
    });
    await act(async () => root.unmount());
  });
});
