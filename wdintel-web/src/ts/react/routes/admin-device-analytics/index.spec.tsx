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
  mocks.reanalyzeAll.mockResolvedValue({ scheduledFileCount: 42 });
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
  it('creates the first tag and saves only the current local rule expression', async () => {
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

  it('archives and restores an existing tag from the edit dialog', async () => {
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
    await act(async () => buttonWithText('Повторно проаналізувати всі файли')?.click());
    await flush();

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.reanalyzeAll).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Заплановано повторний аналіз 42 файлів.',
    });
  });
});
