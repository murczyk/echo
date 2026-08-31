/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiSettlementParseResultItem } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  test: vi.fn(),
  save: vi.fn(),
  recalculate: vi.fn(),
  reset: vi.fn(),
  saveWorker: vi.fn(),
  deleteMessage: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/ai-settlements', () => ({
  getAiSettlementPage: mocks.getPage,
  testAiSettlementParsing: mocks.test,
  saveAiSettlementParsing: mocks.save,
  recalculateAiSettlementParsing: mocks.recalculate,
  resetAiSettlementPrompt: mocks.reset,
  saveAiSettlementWorkerSettings: mocks.saveWorker,
  deleteAiSettlementTestMessage: mocks.deleteMessage,
  createAiSettlementTestMessage: vi.fn(),
  updateAiSettlementTestMessage: vi.fn(),
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AdminAiSettlementsPage } from './index';

const testResult: AiSettlementParseResultItem = {
  testMessageId: 'message-a',
  aiEngineId: 'engine-a',
  settlements: ['АРТІЛЬНЕ'],
  error: null,
  responseText: '{"settlements":["АРТІЛЬНЕ"]}',
  updatedAt: null,
};

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminAiSettlementsPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getPage.mockResolvedValue({
    prompt: 'Find settlements',
    promptOverridden: true,
    engines: [{ id: 'engine-a', name: 'Engine A', modelName: 'model-a' }],
    messages: [
      {
        id: 'message-a',
        message: 'Test message',
        createdAt: 1,
        updatedAt: 1,
        results: [],
      },
    ],
    worker: { enabled: false, aiEngineId: 'engine-a' },
  });
  mocks.test.mockResolvedValue({
    results: [testResult],
    messageVersions: [{ id: 'message-a', version: 'version-a' }],
  });
  mocks.save.mockResolvedValue({
    results: [{ ...testResult, updatedAt: 2 }],
    messageVersions: [{ id: 'message-a', version: 'version-a' }],
  });
  mocks.reset.mockResolvedValue({
    prompt: 'Default settlement prompt',
    promptOverridden: false,
  });
  mocks.saveWorker.mockResolvedValue({ enabled: true, aiEngineId: 'engine-a' });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AdminAiSettlementsPage', () => {
  it('tests selected engines and saves the displayed results', async () => {
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Тест')?.click());
    expect(mocks.test).toHaveBeenCalledWith({
      prompt: 'Find settlements',
      aiEngineIds: ['engine-a'],
    });
    expect(container.textContent).toContain('АРТІЛЬНЕ');
    expect(container.textContent).toContain('ТЕСТ:');

    await act(async () => button(container, 'Зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith({
      prompt: 'Find settlements',
      results: [testResult],
      messageVersions: [{ id: 'message-a', version: 'version-a' }],
    });
    expect(container.textContent).not.toContain('ТЕСТ:');
    await act(async () => root.unmount());
  });

  it('discards test results when the prompt changes during the request', async () => {
    let resolveTest: ((value: Awaited<ReturnType<typeof mocks.test>>) => void) | undefined;
    mocks.test.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve;
        }),
    );
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Тест')?.click());
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => {
      if (prompt) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(prompt, 'Changed prompt');
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => {
      resolveTest?.({
        results: [testResult],
        messageVersions: [{ id: 'message-a', version: 'version-a' }],
      });
    });

    expect(container.textContent).not.toContain('АРТІЛЬНЕ');
    await act(async () => button(container, 'Зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith({
      prompt: 'Changed prompt',
      results: [],
      messageVersions: [],
    });
    await act(async () => root.unmount());
  });

  it('discards in-flight test results when a message is deleted', async () => {
    let resolveTest: ((value: Awaited<ReturnType<typeof mocks.test>>) => void) | undefined;
    mocks.test.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve;
        }),
    );
    mocks.deleteMessage.mockResolvedValueOnce(undefined);
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Тест')?.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Дії"]')?.click(),
    );
    await act(async () => {
      Array.from(document.querySelectorAll('[role="menuitem"]'))
        .find((item) => item.textContent?.includes('Видалити'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => button(document.body, 'Видалити')?.click());
    expect(mocks.deleteMessage).toHaveBeenCalledWith('message-a');

    await act(async () => {
      resolveTest?.({
        results: [testResult],
        messageVersions: [{ id: 'message-a', version: 'version-a' }],
      });
    });
    await act(async () => button(container, 'Зберегти')?.click());

    expect(mocks.save).toHaveBeenCalledWith({
      prompt: 'Find settlements',
      results: [],
      messageVersions: [],
    });
    await act(async () => root.unmount());
  });

  it('clears results from the previous prompt when saving a changed prompt', async () => {
    mocks.getPage.mockResolvedValueOnce({
      ...(await mocks.getPage()),
      messages: [
        {
          id: 'message-a',
          message: 'Test message',
          createdAt: 1,
          updatedAt: 1,
          results: [{ ...testResult, updatedAt: 1 }],
        },
      ],
    });
    mocks.save.mockResolvedValueOnce({ results: [], messageVersions: [] });
    const { container, root } = await renderPage();
    expect(container.textContent).toContain('АРТІЛЬНЕ');

    const prompt = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => {
      if (prompt) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(prompt, 'Changed prompt');
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => button(container, 'Зберегти')?.click());

    expect(mocks.save).toHaveBeenCalledWith({
      prompt: 'Changed prompt',
      results: [],
      messageVersions: [],
    });
    expect(container.textContent).not.toContain('АРТІЛЬНЕ');
    await act(async () => root.unmount());
  });

  it('saves worker settings and resets the prompt override', async () => {
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Скинути до стандартного')?.click());
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(container.querySelector('textarea')?.value).toBe('Default settlement prompt');

    await act(async () => button(container, 'Воркер')?.click());
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => checkbox?.click());
    await act(async () => button(container, 'Зберегти')?.click());
    expect(mocks.saveWorker).toHaveBeenCalledWith({
      enabled: true,
      aiEngineId: 'engine-a',
    });

    await act(async () => root.unmount());
  });
});
