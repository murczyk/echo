/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  check: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/transcriber', () => ({
  listTranscriberInstances: mocks.list,
  createTranscriberInstance: mocks.create,
  updateTranscriberInstance: mocks.update,
  deleteTranscriberInstance: mocks.remove,
  checkTranscriberInstance: mocks.check,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));

import { TranscriberInstancesSection } from './TranscriberInstancesSection';

const instance = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'GPU 1',
  host: 'gpu-1.local',
  is_active: true,
  rs_port: 8080,
  py_port: 8000,
  created_at: 1,
  ordering: 1,
};

async function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<TranscriberInstancesSection />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function confirmMutation() {
  expect(document.body.textContent).toContain('wdintel-rs-bgworker');
  await act(async () => button('підтвердити')?.click());
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

describe('TranscriberInstancesSection', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.remove.mockReset();
    mocks.check.mockReset();
    mocks.notify.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('validates input and confirms create before reporting restart failure', async () => {
    mocks.create.mockResolvedValue({
      instance,
      deleted: false,
      restart_status: 'failed',
      restart_error: 'systemd unavailable',
    });
    const { container, root } = await renderSection();
    await act(async () => button('додати інстанс')?.click());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Вкажіть назву інстансу');

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await act(async () => {
      setInput(inputs[0], 'GPU 1');
      setInput(inputs[1], 'gpu-1.local');
    });
    await act(async () => button('додати інстанс')?.click());
    expect(mocks.create).not.toHaveBeenCalled();
    await confirmMutation();
    expect(mocks.create).toHaveBeenCalledWith({
      name: 'GPU 1',
      host: 'gpu-1.local',
      rs_port: 3001,
      py_port: 3000,
      ordering: 1,
    });
    expect(container.textContent).toContain('systemd unavailable');
    await act(async () => root.unmount());
  });

  it('uses operator defaults and the next available ordering', async () => {
    mocks.list.mockResolvedValue([{ ...instance, ordering: 4 }]);
    const { container, root } = await renderSection();
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[2].value).toBe('3001');
    expect(inputs[3].value).toBe('3000');
    expect(inputs[4].value).toBe('5');
    await act(async () => root.unmount());
  });

  it('rejects values outside backend text and ordering limits', async () => {
    const { container, root } = await renderSection();
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await act(async () => {
      setInput(inputs[0], 'я'.repeat(256));
      setInput(inputs[1], 'gpu-1.local');
    });
    await act(async () => button('додати інстанс')?.click());
    expect(container.textContent).toContain('не більше 255 символів');

    await act(async () => {
      setInput(inputs[0], 'GPU 1');
      setInput(inputs[4], '2147483648');
    });
    await act(async () => button('додати інстанс')?.click());
    expect(container.textContent).toContain('2147483647');
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('checks both services without mutation confirmation', async () => {
    mocks.list.mockResolvedValue([instance]);
    mocks.check.mockResolvedValue({
      rust: { ok: true, status: 200, error: null },
      python: { ok: false, status: 503, error: 'busy' },
    });
    const { container, root } = await renderSection();
    await act(async () => button('перевірити')?.click());
    await act(async () => Promise.resolve());
    expect(mocks.check).toHaveBeenCalledWith(instance.id);
    expect(document.body.textContent).not.toContain('wdintel-rs-bgworker');
    expect(container.textContent).toContain('Rust: доступний; Python: недоступний');
    await act(async () => root.unmount());
  });

  it('clears stale health when a repeated check fails', async () => {
    mocks.list.mockResolvedValue([instance]);
    mocks.check
      .mockResolvedValueOnce({
        rust: { ok: true, status: 200, error: null },
        python: { ok: true, status: 200, error: null },
      })
      .mockRejectedValueOnce(new Error('probe failed'));
    const { container, root } = await renderSection();
    await act(async () => button('перевірити')?.click());
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('Rust: доступний');

    await act(async () => button('перевірити')?.click());
    await act(async () => Promise.resolve());
    expect(container.textContent).not.toContain('Rust: доступний');
    expect(container.textContent).toContain('probe failed');
    await act(async () => root.unmount());
  });

  it('confirms edits before updating', async () => {
    mocks.list.mockResolvedValue([instance]);
    mocks.update.mockResolvedValue({
      instance,
      deleted: false,
      restart_status: 'requested',
      restart_error: null,
    });
    const { root } = await renderSection();
    await act(async () => button('редагувати')?.click());
    await act(async () => button('зберегти інстанс')?.click());
    expect(mocks.update).not.toHaveBeenCalled();
    await confirmMutation();
    expect(mocks.update).toHaveBeenCalledWith(instance.id, {
      name: instance.name,
      host: instance.host,
      rs_port: instance.rs_port,
      py_port: instance.py_port,
      ordering: instance.ordering,
    });
    await act(async () => root.unmount());
  });

  it('confirms activation changes and deletion', async () => {
    mocks.list.mockResolvedValue([instance]);
    mocks.update.mockResolvedValue({
      instance: { ...instance, is_active: false },
      deleted: false,
      restart_status: 'requested',
      restart_error: null,
    });
    mocks.remove.mockResolvedValue({
      instance: null,
      deleted: true,
      restart_status: 'requested',
      restart_error: null,
    });
    const first = await renderSection();
    const activeSwitch = first.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => activeSwitch?.click());
    await confirmMutation();
    expect(mocks.update).toHaveBeenCalledWith(instance.id, { is_active: false });
    await act(async () => first.root.unmount());

    const second = await renderSection();
    await act(async () => button('видалити')?.click());
    expect(mocks.remove).not.toHaveBeenCalled();
    await confirmMutation();
    expect(mocks.remove).toHaveBeenCalledWith(instance.id);
    await act(async () => second.root.unmount());
  });

  it('keeps a successful deletion when the follow-up refresh fails', async () => {
    mocks.list.mockResolvedValueOnce([instance]).mockRejectedValueOnce(new Error('refresh failed'));
    mocks.remove.mockResolvedValue({
      instance: null,
      deleted: true,
      restart_status: 'requested',
      restart_error: null,
    });
    const { container, root } = await renderSection();
    expect(container.textContent).toContain(instance.name);

    await act(async () => button('видалити')?.click());
    await confirmMutation();

    expect(container.textContent).not.toContain(instance.name);
    expect(container.textContent).toContain('refresh failed');
    await act(async () => root.unmount());
  });

  it('disables mutation controls while a request is in flight', async () => {
    mocks.list.mockResolvedValue([instance]);
    let finishCheck: ((health: unknown) => void) | undefined;
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    const { container, root } = await renderSection();
    await act(async () => {
      button('перевірити')?.click();
      await Promise.resolve();
    });

    expect(button('редагувати')?.disabled).toBe(true);
    expect(button('видалити')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(
      true,
    );

    await act(async () => {
      finishCheck?.({
        rust: { ok: true, status: 200, error: null },
        python: { ok: true, status: 200, error: null },
      });
      await Promise.resolve();
    });
    await act(async () => root.unmount());
  });
});
