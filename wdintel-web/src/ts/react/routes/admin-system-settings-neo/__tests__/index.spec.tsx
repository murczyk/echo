/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  replayStatus: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../services/api/system-settings', () => ({
  listSystemSettings: mocks.list,
  createSystemSettings: mocks.save,
  getRerDutyTestReplayStatus: mocks.replayStatus,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));
vi.mock('../../../components/PowerButton', () => ({
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
vi.mock('../../admin-control-panel-neo', () => ({ AdminControlPanelNeoSection: () => null }));
vi.mock('.././CacheBackfillSection', () => ({
  CacheBackfillSection: () => <div>Перерахунок кешу</div>,
}));

import { AdminSystemSettingsNeoPage } from '.././index';

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminSystemSettingsNeoPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
}

function audioSwitch(container: HTMLElement): HTMLInputElement | null {
  return (
    Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Увімкнути транскрибування аудіо'))
      ?.querySelector('input') ?? null
  );
}

function botTagsSwitch(container: HTMLElement): HTMLInputElement | null {
  return (
    Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Вимкнути теги бота'))
      ?.querySelector('input') ?? null
  );
}

function dutyTestSwitch(container: HTMLElement): HTMLInputElement | null {
  return (
    Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Увімкнути тестове надходження повідомлень'))
      ?.querySelector('input') ?? null
  );
}

describe('AdminSystemSettingsNeoPage success notifications', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/system-settings-neo');
    mocks.list.mockReset();
    mocks.save.mockReset();
    mocks.list.mockResolvedValue([]);
    mocks.save.mockResolvedValue(undefined);
    mocks.replayStatus.mockResolvedValue({
      status: 'disabled',
      sourceCount: 0,
      nextSourcePosition: null,
      generatedCount: 0,
      nextEmitAtMs: null,
    });
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
    const saveButton = button(container, 'зберегти');
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
  it('loads report defaults and saves normalized report settings', async () => {
    const { container, root } = await renderPage();
    const hoursInput = container.querySelector<HTMLInputElement>('input[type="number"]');
    const limitLabel = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Обмежити неоптимізовані звіти'),
    );
    const limitInput = limitLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('зберегти'),
    );

    expect(hoursInput?.value).toBe('24');
    expect(limitInput?.checked).toBe(false);
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      if (hoursInput) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          hoursInput,
          '36.8',
        );
        hoursInput.dispatchEvent(new Event('input', { bubbles: true }));
        hoursInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      limitInput?.click();
    });
    expect(saveButton?.disabled).toBe(false);

    await act(async () => saveButton?.click());

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        reportChunkingHours: 36,
        limitBigReports: true,
      }),
    );
    expect(saveButton?.disabled).toBe(true);
    await act(async () => root.unmount());
  });
  it('saves the bot tag toggle', async () => {
    const { container, root } = await renderPage();
    const checkbox = botTagsSwitch(container);
    expect(checkbox?.checked).toBe(false);

    await act(async () => checkbox?.click());
    await act(async () => button(container, 'зберегти')?.click());

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ disableBotTags: true }));
    await act(async () => root.unmount());
  });
  it('persists disabling test message replay immediately', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    mocks.list.mockResolvedValue([{ id: 1, deleted: false, rerDutyTestEnabled: true }]);
    const { container, root } = await renderPage();
    const checkbox = dutyTestSwitch(container);
    expect(checkbox?.checked).toBe(true);

    await act(async () => checkbox?.click());
    await act(async () => Promise.resolve());

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ rerDutyTestEnabled: false }));
    await act(async () => root.unmount());
  });
  it('keeps the enablement warning until transcription is saved', async () => {
    const { container, root } = await renderPage();
    const checkbox = audioSwitch(container);
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox?.click());
    expect(container.textContent).toContain('Збережіть налаштування');
    expect(container.textContent).not.toContain('Транскрибування');

    mocks.save.mockRejectedValueOnce(new Error('save failed'));
    await act(async () => button(container, 'зберегти')?.click());
    await act(async () => Promise.resolve());
    await act(async () => root.unmount());
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('saves the Duty minus-menu flag and reloads the disabled choice', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    const first = await renderPage();
    const menuToggle = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('Меню «—» (мінус) в оперативному'))
        ?.querySelector<HTMLInputElement>('input');
    expect(menuToggle(first.container)?.checked).toBe(true);
    await act(async () => menuToggle(first.container)?.click());
    await act(async () => button(first.container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ dutyExcludeMenuEnabled: false }),
    );
    await act(async () => first.root.unmount());
    mocks.list.mockResolvedValue([{ id: 2, deleted: false, dutyExcludeMenuEnabled: false }]);
    const reloaded = await renderPage();
    expect(menuToggle(reloaded.container)?.checked).toBe(false);
    await act(async () => reloaded.root.unmount());
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('#3568 saves the Analysis AOR-filter flag and reloads the disabled choice', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#analysis');
    const first = await renderPage();
    const menuToggle = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('Фільтр смуг'))
        ?.querySelector<HTMLInputElement>('input');
    expect(menuToggle(first.container)?.checked).toBe(true);
    await act(async () => menuToggle(first.container)?.click());
    await act(async () => button(first.container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ analysisAorFilterEnabled: false }),
    );
    await act(async () => first.root.unmount());
    mocks.list.mockResolvedValue([{ id: 2, deleted: false, analysisAorFilterEnabled: false }]);
    const reloaded = await renderPage();
    expect(menuToggle(reloaded.container)?.checked).toBe(false);
    await act(async () => reloaded.root.unmount());
  });

  it('#3568 saves the 2FA flag and reloads the disabled choice', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#main');
    const first = await renderPage();
    const menuToggle = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('Двофакторна автентифікація (2FA)'))
        ?.querySelector<HTMLInputElement>('input');
    expect(menuToggle(first.container)?.checked).toBe(true);
    await act(async () => menuToggle(first.container)?.click());
    await act(async () => button(first.container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ twoFactorAuthEnabled: false }),
    );
    await act(async () => first.root.unmount());
    mocks.list.mockResolvedValue([{ id: 2, deleted: false, twoFactorAuthEnabled: false }]);
    const reloaded = await renderPage();
    expect(menuToggle(reloaded.container)?.checked).toBe(false);
    await act(async () => reloaded.root.unmount());
  });
});
