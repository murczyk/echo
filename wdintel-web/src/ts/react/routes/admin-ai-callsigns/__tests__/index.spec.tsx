/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCallsignParseResultItem } from '../../../../../Bindings';

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

vi.mock('../../../services/api/ai-callsigns', () => ({
  getAiCallsignPage: mocks.getPage,
  testAiCallsignParsing: mocks.test,
  saveAiCallsignParsing: mocks.save,
  recalculateAiCallsignParsing: mocks.recalculate,
  resetAiCallsignPrompt: mocks.reset,
  saveAiCallsignWorkerSettings: mocks.saveWorker,
  deleteAiCallsignTestMessage: mocks.deleteMessage,
  createAiCallsignTestMessage: vi.fn(),
  updateAiCallsignTestMessage: vi.fn(),
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AdminAiCallsignsPage } from '.././index';

const testResult: AiCallsignParseResultItem = {
  testMessageId: 'message-a',
  aiEngineId: 'engine-a',
  callsigns: ['ALFA'],
  error: null,
  responseText: '{"callsigns":["ALFA"]}',
  updatedAt: null,
};

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminAiCallsignsPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
}

beforeEach(() => {
  mocks.getPage.mockReset();
  mocks.test.mockReset();
  mocks.save.mockReset();
  mocks.recalculate.mockReset();
  mocks.reset.mockReset();
  mocks.saveWorker.mockReset();
  mocks.deleteMessage.mockReset();
  mocks.notify.mockReset();
  mocks.getPage.mockResolvedValue({
    prompt: 'Find callsigns',
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
  mocks.test.mockResolvedValue({ results: [testResult] });
  mocks.save.mockResolvedValue({
    results: [{ ...testResult, updatedAt: 2 }],
  });
  mocks.reset.mockResolvedValue({
    prompt: 'Default callsign prompt',
    promptOverridden: false,
  });
  mocks.saveWorker.mockResolvedValue({
    enabled: true,
    aiEngineId: 'engine-a',
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});
describe('AdminAiCallsignsPage', () => {
  it('tests selected engines and saves the displayed results', async () => {
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Тест')?.click());
    expect(mocks.test).toHaveBeenCalledWith({
      prompt: 'Find callsigns',
      aiEngineIds: ['engine-a'],
    });
    expect(container.textContent).toContain('ALFA');
    expect(container.textContent).toContain('ТЕСТ:');

    await act(async () => button(container, 'Зберегти')?.click());
    expect(mocks.save).toHaveBeenCalledWith({
      prompt: 'Find callsigns',
      results: [testResult],
    });
    expect(container.textContent).not.toContain('ТЕСТ:');
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Промпт і результати збережено.',
    });
    await act(async () => root.unmount());
  });

  it('resets the override and clears unsaved test results', async () => {
    const { container, root } = await renderPage();

    await act(async () => button(container, 'Тест')?.click());
    expect(container.textContent).toContain('ТЕСТ:');

    await act(async () => button(container, 'Скинути до стандартного')?.click());

    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(container.querySelector('textarea')?.value).toBe('Default callsign prompt');
    expect(container.textContent).not.toContain('ТЕСТ:');
    expect(button(container, 'Скинути до стандартного')?.disabled).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Відновлено стандартний промпт.',
    });
    await act(async () => root.unmount());
  });
});
