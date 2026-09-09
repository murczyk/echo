/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentSettings: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  check: vi.fn(),
  listResults: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../services/api/transcriber', () => ({
  listTranscriberInstances: mocks.list,
  createTranscriberInstance: mocks.create,
  updateTranscriberInstance: mocks.update,
  deleteTranscriberInstance: mocks.remove,
  checkTranscriberInstance: mocks.check,
  listTranscriptionResults: mocks.listResults,
}));
vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: mocks.currentSettings,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));

import { AdminTranscriptionSettingsPage } from '.././index';

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

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminTranscriptionSettingsPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
}

async function clickButton(label: string) {
  await act(async () => {
    button(label)?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 410));
  });
}

async function clickDeleteAction() {
  await clickButton('Дії');
  const deleteItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === 'Видалити',
  );
  expect(deleteItem).toBeDefined();
  await act(async () => {
    deleteItem?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 410));
  });
}

function editorDialog(): HTMLElement {
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
    (item) => item.textContent?.includes('Echo GPU інстанс'),
  );
  if (!dialog) throw new Error('Editor dialog was not found');
  return dialog;
}

function editorInputs(): NodeListOf<HTMLInputElement> {
  return editorDialog().querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])');
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function confirmMutation() {
  expect(document.body.textContent).toContain('wdintel-rs-bgworker');
  await clickButton('Підтвердити');
}

// @test-scope safeguard: prevents transcription-instance operations from bypassing confirmation, persisting invalid values, or leaving stale operational state.
describe('AdminTranscriptionSettingsPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/transcription-settings');
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
    mocks.currentSettings.mockReset().mockResolvedValue({ enableAudioTranscription: true });
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.remove.mockReset();
    mocks.check.mockReset();
    mocks.listResults.mockReset().mockResolvedValue({
      rows: [],
      total: 0,
      has_more: false,
      next_cursor: null,
      previous_cursor: null,
    });
    mocks.notify.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as { localStorage?: Storage }).localStorage;
  });

  it('redirects to system settings when transcription is disabled', async () => {
    mocks.currentSettings.mockResolvedValue({ enableAudioTranscription: false });
    const { root } = await renderPage();
    expect(window.location.pathname).toBe('/admin/system-settings-neo');
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('uses a common table with an add dialog and reports restart failure after create', async () => {
    mocks.create.mockResolvedValue({
      instance,
      deleted: false,
      restart_status: 'failed',
      restart_error: 'systemd unavailable',
    });
    const { container, root } = await renderPage();
    expect(container.querySelector('table')).not.toBeNull();
    expect(button('Додати інстанс')).toBeDefined();
    expect(
      document.getElementById('transcription-instances-tab')?.getAttribute('aria-controls'),
    ).toBe('transcription-instances-panel');
    expect(
      document.getElementById('transcription-results-tab')?.getAttribute('aria-controls'),
    ).toBe('transcription-results-panel');

    await clickButton('Додати інстанс');
    await clickButton('Додати');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Вкажіть назву інстансу');

    const inputs = editorInputs();
    await act(async () => {
      setInput(inputs[0], 'GPU 1');
      setInput(inputs[1], 'gpu-1.local');
    });
    await clickButton('Додати');
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

  // @test-scope safeguard: prevents an instance-table filter from being sent to the unrelated transcription-results query.
  it('does not send instance column filters to transcription results', async () => {
    const columnFilters = encodeURIComponent(JSON.stringify([{ id: 'name', value: 'GPU 1' }]));
    window.history.replaceState(
      {},
      '',
      `/admin/transcription-settings?columnFilters=${columnFilters}`,
    );
    const { root } = await renderPage();

    await clickButton('Результати транскрибації');

    expect(mocks.listResults).toHaveBeenCalledWith(
      {
        globalFilter: '',
        columnFilters: [],
        limit: 100,
      },
      expect.objectContaining({ signal: expect.anything() }),
    );
    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents a failed transcription-results request from leaving the operator without an error signal.
  it('shows transcription-result load failures in a toast', async () => {
    mocks.listResults.mockRejectedValue(new Error('results unavailable'));
    const { root } = await renderPage();

    await clickButton('Результати транскрибації');

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: expect.stringContaining('results unavailable'),
    });
    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents cursor pagination from skipping or repeating transcription results between pages.
  it('uses the server cursor for the next transcription-results page', async () => {
    mocks.listResults
      .mockResolvedValueOnce({
        rows: [],
        total: 101,
        has_more: true,
        next_cursor: 'cursor-100',
        previous_cursor: null,
      })
      .mockResolvedValueOnce({
        rows: [],
        total: 101,
        has_more: false,
        next_cursor: null,
        previous_cursor: 'cursor-previous',
      });
    const { root } = await renderPage();

    await clickButton('Результати транскрибації');
    await clickButton('Наступна сторінка');

    expect(mocks.listResults).toHaveBeenLastCalledWith(
      {
        globalFilter: '',
        columnFilters: [],
        limit: 100,
        after: 'cursor-100',
      },
      expect.objectContaining({ signal: expect.anything() }),
    );
    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents the final transcription-results page from becoming unreachable when the response total changes.
  it('derives the last transcription-results page from the response total', async () => {
    const result = {
      id: '01900000-0000-7000-8000-000000000002',
      source_id: '01900000-0000-7000-8000-000000000003',
      file_name: 'recording.mp3',
      created_at: 1_700_000_000_000,
      started_transcription_at: null,
      completion_time_seconds: null,
      status: 'queued',
      transcribed_value: null,
      error: null,
      instance_id: null,
      instance_name: null,
    };
    mocks.listResults
      .mockResolvedValueOnce({
        rows: [result],
        total: 200,
        has_more: true,
        next_cursor: 'cursor-next',
        previous_cursor: null,
      })
      .mockResolvedValueOnce({
        rows: [result],
        total: 201,
        has_more: false,
        next_cursor: null,
        previous_cursor: 'cursor-previous',
      });
    const { container, root } = await renderPage();

    await clickButton('Результати транскрибації');
    await clickButton('1-1 з 200');
    const lastPageItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Остання сторінка'));
    expect(lastPageItem).toBeDefined();
    await act(async () => {
      lastPageItem?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 410));
    });

    expect(mocks.listResults).toHaveBeenLastCalledWith(
      {
        globalFilter: '',
        columnFilters: [],
        limit: 100,
        lastPage: true,
      },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(container.textContent).toContain('201-201 з 201');
    await act(async () => root.unmount());
  });

  it('uses operator defaults and the next available ordering in the add dialog', async () => {
    mocks.list.mockResolvedValue([{ ...instance, ordering: 4 }]);
    const { root } = await renderPage();
    await clickButton('Додати інстанс');
    const inputs = editorInputs();
    expect(inputs[2].value).toBe('3001');
    expect(inputs[3].value).toBe('3000');
    expect(inputs[4].value).toBe('5');
    await act(async () => root.unmount());
  });

  it('rejects values outside backend text and ordering limits', async () => {
    const { root } = await renderPage();
    await clickButton('Додати інстанс');
    const inputs = editorInputs();
    await act(async () => {
      setInput(inputs[0], 'я'.repeat(256));
      setInput(inputs[1], 'gpu-1.local');
    });
    await clickButton('Додати');
    expect(document.body.textContent).toContain('не більше 255 символів');

    await act(async () => {
      setInput(inputs[0], 'GPU 1');
      setInput(inputs[4], '2147483648');
    });
    await clickButton('Додати');
    expect(document.body.textContent).toContain('2147483647');
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('checks both services from the edit dialog without mutation confirmation', async () => {
    mocks.list.mockResolvedValue([instance]);
    mocks.check.mockResolvedValue({
      rust: { ok: true, status: 200, error: null },
      python: { ok: false, status: 503, error: 'busy' },
    });
    const { root } = await renderPage();
    await clickButton('Редагувати');
    await clickButton('Перевірити');
    expect(mocks.check).toHaveBeenCalledWith(instance.id);
    expect(document.body.textContent).not.toContain('wdintel-rs-bgworker');
    expect(document.body.textContent).toContain('Rust: доступний; Python: недоступний');
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
    const { root } = await renderPage();
    await clickButton('Редагувати');
    await clickButton('Перевірити');
    expect(document.body.textContent).toContain('Rust: доступний');

    await clickButton('Перевірити');
    expect(document.body.textContent).not.toContain('Rust: доступний');
    expect(document.body.textContent).toContain('probe failed');
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
    const { root } = await renderPage();
    await clickButton('Редагувати');
    await clickButton('Зберегти');
    expect(mocks.update).not.toHaveBeenCalled();
    await confirmMutation();
    expect(mocks.update).toHaveBeenCalledWith(instance.id, {
      name: instance.name,
      host: instance.host,
      rs_port: instance.rs_port,
      py_port: instance.py_port,
      ordering: instance.ordering,
      is_active: true,
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
    const first = await renderPage();
    await clickButton('Редагувати');
    const activeSwitch = editorDialog().querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => activeSwitch?.click());
    await clickButton('Зберегти');
    await confirmMutation();
    expect(mocks.update).toHaveBeenCalledWith(instance.id, {
      name: instance.name,
      host: instance.host,
      rs_port: instance.rs_port,
      py_port: instance.py_port,
      ordering: instance.ordering,
      is_active: false,
    });
    await act(async () => first.root.unmount());

    const second = await renderPage();
    await clickDeleteAction();
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
    const { container, root } = await renderPage();
    expect(container.textContent).toContain(instance.name);

    await clickDeleteAction();
    await confirmMutation();

    expect(container.textContent).not.toContain(instance.name);
    expect(container.textContent).toContain('refresh failed');
    await act(async () => root.unmount());
  });

  it('disables editor mutation controls while a request is in flight', async () => {
    mocks.list.mockResolvedValue([instance]);
    let finishCheck: ((health: unknown) => void) | undefined;
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    const { root } = await renderPage();
    await clickButton('Редагувати');
    await act(async () => {
      button('Перевірити')?.click();
      await Promise.resolve();
    });

    expect(button('Зберегти')?.disabled).toBe(true);
    expect(button('Скасувати')?.disabled).toBe(true);
    expect(editorDialog().querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(
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
