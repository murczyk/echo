/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuleExpression } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({ listFiles: vi.fn(), testRule: vi.fn() }));

vi.mock('../../services/api/device-analytics', () => ({
  listAnalyticsTagTestFiles: mocks.listFiles,
  testAnalyticsTagRule: mocks.testRule,
}));

import { RuleTestPanel } from './RuleTestPanel';

const TAG_ID = '018f0000-0000-7000-8000-000000000101';
const expression: RuleExpression = {
  match: {
    field: 'full_path',
    matcher: 'contains_token',
    values: ['звіт'],
  },
};

let container: HTMLDivElement;
let root: Root;

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
  mocks.listFiles.mockResolvedValue({
    files: [
      {
        absolutePath: 'C:\\Reports\\Звіт.pdf',
        expectedMatch: true,
      },
      {
        absolutePath: 'C:\\Reports\\Чернетка.tmp',
        expectedMatch: false,
      },
    ],
  });
  mocks.testRule.mockResolvedValue({
    results: [
      { index: 0, matched: true, passed: true },
      { index: 1, matched: false, passed: true },
    ],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<RuleTestPanel tagId={TAG_ID} expression={expression} />));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('RuleTestPanel', () => {
  it('loads positive and negative files and tests the local expression', async () => {
    expect(mocks.listFiles).toHaveBeenCalledWith(
      { id: TAG_ID },
      { signal: expect.any(AbortSignal) },
    );
    expect(container.textContent).toContain('Позитивні кейси');
    expect(container.textContent).toContain('Негативні кейси');
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input'));
    expect(inputs.map((input) => input.value)).toEqual([
      'C:\\Reports\\Звіт.pdf',
      'C:\\Reports\\Чернетка.tmp',
    ]);

    act(() => setInputValue(inputs[0], 'C:\\Reports\\Новий звіт.docx'));

    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Зберегти й перевірити',
    );
    expect(testButton).toBeDefined();
    await act(async () => testButton?.click());
    await flush();

    expect(mocks.testRule).toHaveBeenCalledWith({
      id: TAG_ID,
      ruleExpression: expression,
      files: [
        {
          absolutePath: 'C:\\Reports\\Новий звіт.docx',
          expectedMatch: true,
        },
        {
          absolutePath: 'C:\\Reports\\Чернетка.tmp',
          expectedMatch: false,
        },
      ],
    });
    expect(container.textContent).toContain('Кейс пройдено');
    expect(container.textContent).toContain('Тестові файли збережено. Усі кейси пройдено.');
  });

  it('identifies a false positive in the negative cases', async () => {
    mocks.testRule.mockResolvedValueOnce({
      results: [
        { index: 0, matched: true, passed: true },
        { index: 1, matched: true, passed: false },
      ],
    });

    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Зберегти й перевірити',
    );
    await act(async () => testButton?.click());
    await flush();

    expect(container.textContent).toContain('Тег призначено помилково');
    expect(container.textContent).toContain('Не пройдено кейсів: 1.');
  });

  it('requires a persisted tag before editing reusable test files', async () => {
    await act(async () => root.render(<RuleTestPanel tagId={null} expression={expression} />));
    await flush();

    expect(container.textContent).toContain(
      'Спочатку збережіть тег, щоб додати постійні тестові файли.',
    );
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Зберегти й перевірити',
      ),
    ).toBe(false);
  });
});
