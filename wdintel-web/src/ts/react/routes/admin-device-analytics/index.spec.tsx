/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archiveTag: vi.fn(),
  createTag: vi.fn(),
  listTags: vi.fn(),
  notify: vi.fn(),
  reanalyzeAll: vi.fn(),
  restoreTag: vi.fn(),
  saveRule: vi.fn(),
  updateTag: vi.fn(),
  updateDeviceSettings: vi.fn(),
}));

vi.mock('../../services/api/device-analytics', () => ({
  archiveAnalyticsTag: mocks.archiveTag,
  createAnalyticsTag: mocks.createTag,
  listAdminAnalyticsTags: mocks.listTags,
  restoreAnalyticsTag: mocks.restoreTag,
  saveAnalyticsTagRule: mocks.saveRule,
  updateAnalyticsTag: mocks.updateTag,
}));

vi.mock('../../services/api/devices', () => ({
  reanalyzeAll: mocks.reanalyzeAll,
  updateDeviceSettings: mocks.updateDeviceSettings,
}));

vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

vi.mock('./RuleExpressionEditor', () => ({
  RuleExpressionEditor: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange({ match: { field: 'file_name', matcher: 'contains', values: ['звіт'] } })
      }
    >
      Встановити тестове правило
    </button>
  ),
}));

vi.mock('./RuleTestPanel', () => ({
  RuleTestPanel: ({ tagId, expression }: { tagId: string | null; expression: unknown }) => (
    <div data-testid="rule-test-panel" data-tag-id={tagId ?? ''}>
      {expression === null ? 'Без правила' : 'Локальне правило'}
    </div>
  ),
}));

import { AdminDeviceAnalyticsPage } from '.';

const TAG_ID = '018f0000-0000-7000-8000-000000000101';
const NOW = '2026-08-06T12:00:00Z';
const localExpression = { match: { field: 'file_name', matcher: 'contains', values: ['звіт'] } };
const createdTag = {
  id: TAG_ID,
  name: 'Звіти',
  ruleExpression: null,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

let container: HTMLDivElement;
let root: Root;

function buttonWithText(text: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    globalThis.setTimeout(resolve, 0);
    await promise;
  });
}

async function openDeviceTagsTab() {
  const tab = buttonWithText('Теги пристроїв');
  if (!tab) throw new Error('Device tags tab was not rendered');
  await act(async () => tab.click());
  await flush();
}

beforeEach(async () => {
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    value: vi.fn(() => true),
  });
  mocks.listTags.mockResolvedValue({ tags: [] });
  mocks.createTag.mockResolvedValue(createdTag);
  mocks.saveRule.mockResolvedValue({ ...createdTag, ruleExpression: localExpression });
  mocks.archiveTag.mockResolvedValue({ ...createdTag, archivedAt: NOW });
  mocks.restoreTag.mockResolvedValue(createdTag);
  mocks.reanalyzeAll.mockResolvedValue({ definitionId: 'definition-1', createdRunCount: 42 });
  mocks.updateDeviceSettings.mockResolvedValue({ hasMattermostWebhook: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AdminDeviceAnalyticsPage />));
  await flush();
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AdminDeviceAnalyticsPage', () => {
  it('loads general settings first and opens device tags in the second tab', async () => {
    expect(container.textContent).toContain('Аналіз пристроїв');

    const generalTab = buttonWithText('Основні налаштування');
    const tagsTab = buttonWithText('Теги пристроїв');
    const generalPanel = container.querySelector<HTMLElement>(
      '#device-analysis-settings-panel-general',
    );
    const tagsPanel = container.querySelector<HTMLElement>('#device-analysis-settings-panel-tags');

    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
    expect(tagsTab?.getAttribute('aria-selected')).toBe('false');
    expect(generalPanel?.hidden).toBe(false);
    expect(generalPanel?.textContent).toContain('Налаштування відсутні');
    expect(generalPanel?.textContent).toContain('Webhook ще не налаштовано.');
    expect(generalPanel?.textContent).toContain(
      'Echo надсилатиме сповіщення про створення пристроїв і завершення їх аналізу.',
    );
    expect(tagsPanel?.hidden).toBe(true);
    expect(mocks.updateDeviceSettings).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(mocks.listTags).not.toHaveBeenCalled();

    await openDeviceTagsTab();

    expect(generalTab?.getAttribute('aria-selected')).toBe('false');
    expect(tagsTab?.getAttribute('aria-selected')).toBe('true');
    expect(generalPanel?.hidden).toBe(true);
    expect(tagsPanel?.hidden).toBe(false);
    expect(container.textContent).toContain('Каталог порожній');
    expect(mocks.listTags).toHaveBeenCalledTimes(1);
  });

  it('replaces the masked device webhook and clears it only through the explicit action', async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();

    act(() => setInputValue(input!, '  https://mattermost.example/hooks/device-secret  '));
    mocks.updateDeviceSettings.mockResolvedValueOnce({ hasMattermostWebhook: true });
    await act(async () => buttonWithText('Зберегти webhook')?.click());
    await flush();

    expect(mocks.updateDeviceSettings).toHaveBeenNthCalledWith(2, {
      mattermostWebhookUrl: 'https://mattermost.example/hooks/device-secret',
    });
    expect(container.textContent).toContain('Webhook налаштовано. Поточний URL приховано.');
    expect(input?.value).toBe('');
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Mattermost webhook для пристроїв збережено.',
    });

    mocks.updateDeviceSettings.mockResolvedValueOnce({ hasMattermostWebhook: false });
    await act(async () => buttonWithText('Видалити webhook')?.click());
    await flush();

    expect(mocks.updateDeviceSettings).toHaveBeenNthCalledWith(3, {
      clearMattermostWebhook: true,
    });
    expect(container.textContent).toContain('Webhook ще не налаштовано.');
  });

  it('creates the first tag and saves only the current local rule expression', async () => {
    await openDeviceTagsTab();

    expect(container.textContent).toContain('Каталог порожній');
    expect(container.textContent).toContain('Теги пристроїв');

    await act(async () => buttonWithText('Створити тег')?.click());
    const nameInput = document.querySelector<HTMLInputElement>('input');
    expect(nameInput).not.toBeNull();
    act(() => setInputValue(nameInput!, '  Звіти  '));
    await act(async () => buttonWithText('Встановити тестове правило')?.click());

    expect(document.querySelector('[data-testid="rule-test-panel"]')?.textContent).toBe(
      'Локальне правило',
    );
    expect(mocks.createTag).not.toHaveBeenCalled();
    expect(mocks.saveRule).not.toHaveBeenCalled();

    await act(async () => buttonWithText('Зберегти')?.click());
    await flush();

    expect(mocks.createTag).toHaveBeenCalledWith({ name: 'Звіти' });
    expect(mocks.saveRule).toHaveBeenCalledWith({
      id: TAG_ID,
      ruleExpression: localExpression,
    });
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Тег пристроїв і його активне правило збережено.',
    });
  });

  it('creates a tag without saving an unchanged empty rule', async () => {
    await openDeviceTagsTab();

    await act(async () => buttonWithText('Створити тег')?.click());
    const nameInput = document.querySelector<HTMLInputElement>('input');
    expect(nameInput).not.toBeNull();
    act(() => setInputValue(nameInput!, 'Звіти'));
    await act(async () => buttonWithText('Зберегти')?.click());
    await flush();

    expect(mocks.createTag).toHaveBeenCalledWith({ name: 'Звіти' });
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it('skips rule saving when a renamed or unchanged tag keeps the same rule', async () => {
    const existingTag = { ...createdTag, ruleExpression: localExpression };
    const renamedTag = { ...existingTag, name: 'Оновлені звіти' };
    mocks.listTags.mockResolvedValue({ tags: [existingTag] });
    mocks.updateTag.mockResolvedValue(renamedTag);
    await openDeviceTagsTab();

    await act(async () => buttonWithText('Редагувати')?.click());
    const nameInput = document.querySelector<HTMLInputElement>('input');
    expect(nameInput).not.toBeNull();
    act(() => setInputValue(nameInput!, renamedTag.name));
    await act(async () => buttonWithText('Зберегти')?.click());
    await flush();

    expect(mocks.updateTag).toHaveBeenCalledWith({ id: TAG_ID, name: renamedTag.name });
    expect(mocks.saveRule).not.toHaveBeenCalled();

    await act(async () => buttonWithText('Редагувати')?.click());
    await act(async () => buttonWithText('Зберегти')?.click());
    await flush();

    expect(mocks.updateTag).toHaveBeenCalledTimes(1);
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it('archives and restores an existing tag from the edit dialog', async () => {
    await openDeviceTagsTab();

    await act(async () => buttonWithText('Створити тег')?.click());
    const nameInput = document.querySelector<HTMLInputElement>('input');
    act(() => setInputValue(nameInput!, 'Звіти'));
    await act(async () => buttonWithText('Зберегти')?.click());
    await flush();

    await act(async () => buttonWithText('Редагувати')?.click());
    await act(async () => buttonWithText('Архівувати тег')?.click());
    await flush();

    expect(mocks.archiveTag).toHaveBeenCalledWith({ id: TAG_ID });
    expect(document.body.textContent).toContain(
      'Архівний тег спочатку потрібно відновити, щоб змінити назву або правило.',
    );

    const restoreButton = buttonWithText('Відновити тег');
    expect(restoreButton).not.toBeUndefined();
    expect(restoreButton?.disabled).toBe(false);
    await act(async () => restoreButton?.click());
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.archiveTag).toHaveBeenCalledTimes(1);

    expect(mocks.restoreTag).toHaveBeenCalledWith({ id: TAG_ID });
    expect(buttonWithText('Встановити тестове правило')).not.toBeUndefined();
  });

  it('requires confirmation before scheduling global reanalysis', async () => {
    await openDeviceTagsTab();

    await act(async () => buttonWithText('Повторно проаналізувати всі файли')?.click());
    await flush();

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.reanalyzeAll).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Створено запусків повторного аналізу: 42.',
    });
  });
});
