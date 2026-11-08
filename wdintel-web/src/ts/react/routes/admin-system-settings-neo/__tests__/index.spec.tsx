/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  replayStatus: vi.fn(),
  cleanup: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../RerReportSettings', () => ({ RerReportSettings: () => <div>Звіт РЕР</div> }));

vi.mock('../../../services/api/system-settings', () => ({
  listSystemSettings: mocks.list,
  createSystemSettings: mocks.save,
  getRerDutyTestReplayStatus: mocks.replayStatus,
  cleanupOrbitOtherUnits: mocks.cleanup,
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

function signozMetricsControls(container: HTMLElement) {
  return {
    enabled: Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Експорт метрик до SigNoz'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    endpoint: container.querySelector<HTMLInputElement>('input[type="url"]'),
  };
}

async function enableSignozMetrics(container: HTMLElement, endpoint: string) {
  const controls = signozMetricsControls(container);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    controls.enabled?.click();
    setValue.call(controls.endpoint, endpoint);
    controls.endpoint?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button(container, 'зберегти')?.click());
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
    mocks.cleanup.mockReset();
    mocks.cleanup.mockResolvedValue({ deletedCount: 0, activeUnits: [] });
    mocks.notify.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });
  it('loads and saves #3788 API throttling independently of other settings', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#api');
    mocks.list.mockResolvedValue([
      { id: 1, deleted: false, apiRateLimitReplenishIntervalMs: 750, apiRateLimitBurstSize: 4 },
    ]);
    const { container, root } = await renderPage();
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
    expect(inputs[0]?.value).toBe('750');
    expect(inputs[1]?.value).toBe('4');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(inputs[0], '500');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      setValue.call(inputs[1], '5');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ apiRateLimitReplenishIntervalMs: 500, apiRateLimitBurstSize: 5 }),
    );
    await act(async () => root.unmount());
  });
  it.each([
    ['0', '5', 'додатними цілими числами'],
    ['2147483647', '2147483647', 'поєднання інтервалу'],
  ])('rejects #3788 invalid quotas %s/%s before saving', async (interval, burst, message) => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#api');
    const { container, root } = await renderPage();
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      for (const [input, value] of [
        [inputs[0], interval],
        [inputs[1], burst],
      ] as const) {
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => button(container, 'зберегти')?.click());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    await act(async () => root.unmount());
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
  it('keeps the exact-match setting as a selectable label-controlled switch', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#main');
    const { container, root } = await renderPage();
    const label = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('Прапорець «точний збіг за еталонкою» на Аналізі увімкнений'),
    );
    const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(label?.querySelector('button')).toBeNull();
    expect(checkbox?.checked).toBe(true);
    await act(async () => label?.click());
    expect(checkbox?.checked).toBe(false);
    await act(async () => root.unmount());
  });
  it('loads report defaults and saves normalized report settings', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#reports');
    const { container, root } = await renderPage();
    const hoursInput = container.querySelector<HTMLInputElement>(
      'input[type="number"][value="24"]',
    );
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
  it('saves the #3940 РЕР mode toggle using the inverse hide-networks value', async () => {
    const { container, root } = await renderPage();
    const checkbox = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Режим РЕР'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(checkbox?.checked).toBe(true);
    await act(async () => checkbox?.click());
    await act(async () => button(container, 'зберегти')?.click());

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ hideNetworks: true }));
    await act(async () => checkbox?.click());
    await act(async () => button(container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ hideNetworks: false }));
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
  it('saves the Orbit exclusion setting', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#integrations');
    const { container, root } = await renderPage();
    const checkbox = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Не імпортувати підрозділи управління'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);

    await act(async () => checkbox?.click());
    await act(async () => button(container, 'зберегти')?.click());

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrbitOtherUnits: false }),
    );
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
    expect(checkbox?.checked).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Помилка збереження: save failed',
    });
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

  it('saves the Duty selected-groups flag and reloads the disabled choice', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    const first = await renderPage();
    const groupsToggle = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('Відображати обрані групи в оперативному'))
        ?.querySelector<HTMLInputElement>('input');
    expect(groupsToggle(first.container)?.checked).toBe(true);
    await act(async () => groupsToggle(first.container)?.click());
    await act(async () => button(first.container, 'зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ dutySelectedGroupsEnabled: false }),
    );
    await act(async () => first.root.unmount());
    mocks.list.mockResolvedValue([{ id: 2, deleted: false, dutySelectedGroupsEnabled: false }]);
    const reloaded = await renderPage();
    expect(groupsToggle(reloaded.container)?.checked).toBe(false);
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

  it('reads the active tab from the anchor and has no provider tab', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#duty');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    const { container, root } = await renderPage();
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const dutyTab = tabs.find((tab) => tab.textContent?.includes('Оперативний'));
    const analysisTab = tabs.find((tab) => tab.textContent?.includes('Аналіз'));

    expect(dutyTab?.getAttribute('aria-selected')).toBe('true');
    expect(tabs.some((tab) => tab.textContent?.includes('ШІ'))).toBe(false);
    await act(async () => analysisTab?.click());

    expect(window.location.hash).toBe('#analysis');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  // Regression: https://github.com/echoua/echo/issues/4034
  it('#4034 loads and saves SigNoz metrics export settings on the Monitoring tab', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#monitoring');
    mocks.list.mockResolvedValue([
      {
        id: 1,
        deleted: false,
        signozMetricsEnabled: false,
        signozMetricsEndpoint: 'http://old-signoz:4317',
      },
    ]);
    const { container, root } = await renderPage();
    const controls = signozMetricsControls(container);
    expect(controls.enabled?.checked).toBe(false);
    expect(controls.endpoint?.value).toBe('http://old-signoz:4317');
    expect(container.textContent).toContain('Зміни діють після перезапуску Echo.');

    await enableSignozMetrics(container, ' http://signoz-echo.eagle-atria.ts.net:4317 ');

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        signozMetricsEnabled: true,
        signozMetricsEndpoint: 'http://signoz-echo.eagle-atria.ts.net:4317',
      }),
    );
    await act(async () => root.unmount());
  });
  it.each([
    ['', 'вкажіть адресу SigNoz'],
    ['signoz-echo:4317', 'має бути http або https URL'],
  ])('#4034 blocks enabling SigNoz metrics with endpoint %j', async (endpoint, message) => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#monitoring');
    const { container, root } = await renderPage();

    await enableSignozMetrics(container, endpoint);

    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    await act(async () => root.unmount());
  });

  it('shows media cache settings beside cache maintenance', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#cache');
    const { container, root } = await renderPage();

    expect(container.textContent).toContain('Перерахунок кешу');
    expect(container.textContent).toContain('Локальний кеш медіа');
    expect(button(container, 'зберегти')?.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it('double-confirms Orbit cleanup and allows roadblock override', async () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#integrations');
    mocks.cleanup
      .mockResolvedValueOnce({
        deletedCount: 0,
        activeUnits: [{ id: 7, name: 'Active unit' }],
      })
      .mockResolvedValueOnce({
        deletedCount: 2,
        activeUnits: [{ id: 7, name: 'Active unit' }],
      });
    const { root } = await renderPage();

    await act(async () => button(document.body, 'Видалити підрозділи управління')?.click());
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await act(async () => button(document.body, 'Продовжити')?.click());
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await act(async () => button(document.body, 'Так, видалити')?.click());
    await act(async () => Promise.resolve());

    expect(mocks.cleanup).toHaveBeenCalledWith(false);
    expect(document.body.textContent).toContain('Операцію заблоковано');
    expect(document.body.querySelector('a[href="/rer-units/7"]')?.textContent).toBe('Active unit');

    await act(async () => button(document.body, 'Ігнорувати та продовжити')?.click());
    await act(async () => Promise.resolve());

    expect(mocks.cleanup).toHaveBeenLastCalledWith(true);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Видалено підрозділів: 2.',
    });
    await act(async () => root.unmount());
  });
});
