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

vi.mock('../../services/api/system-settings', () => ({
  listSystemSettings: mocks.list,
  createSystemSettings: mocks.save,
  getRerDutyTestReplayStatus: mocks.replayStatus,
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
vi.mock('./AiEnginesSection', () => ({ AiEnginesSection: () => <div>ШІ движки</div> }));
vi.mock('./CacheBackfillSection', () => ({
  CacheBackfillSection: () => <div>Перерахунок кешу</div>,
}));

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

  it('does not embed instance administration when transcription is enabled', async () => {
    mocks.list.mockResolvedValueOnce([{ id: 1, deleted: false, enableAudioTranscription: true }]);
    const { container, root } = await renderPage();
    expect(button(container, 'Транскрибування')).toBeUndefined();
    await act(async () => root.unmount());
  });

  it('keeps classic menu toggles in their respective tabs', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    const { container, root } = await renderPage();
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

    expect(container.textContent).toContain('Показувати класичний оперативний');
    expect(container.textContent).not.toContain('Показувати класичний аналіз');

    await act(async () => tabs.find((tab) => tab.textContent === 'Аналіз')?.click());

    expect(container.textContent).not.toContain('Показувати класичний оперативний');
    expect(container.textContent).toContain('Показувати класичний аналіз');
    await act(async () => root.unmount());
  });

  it('reads the active tab from the anchor and replaces it on tab changes', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    const { container, root } = await renderPage();
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const dutyTab = tabs.find((tab) => tab.textContent?.includes('Оперативний'));
    const aiTab = tabs.find((tab) => tab.textContent?.includes('ШІ'));

    expect(dutyTab?.getAttribute('aria-selected')).toBe('true');
    await act(async () => aiTab?.click());

    expect(window.location.hash).toBe('#ai');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('shows cache maintenance without the settings save button', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#cache');
    const { container, root } = await renderPage();

    expect(container.textContent).toContain('Перерахунок кешу');
    expect(button(container, 'зберегти')).toBeUndefined();
    await act(async () => root.unmount());
  });
});
