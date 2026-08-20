/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listAttempts: vi.fn(),
  saveSettings: vi.fn(),
  listEngines: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('material-react-table', async (importOriginal) => {
  const original = await importOriginal<typeof import('material-react-table')>();
  return {
    ...original,
    MaterialReactTable: ({ table }: { table: { options: { data: unknown[] } } }) => (
      <table>
        <tbody>
          <tr>
            <td>{JSON.stringify(table.options.data)}</td>
          </tr>
        </tbody>
      </table>
    ),
  };
});

vi.mock('../../services/api/ai-intel-report', () => ({
  getAiIntelReportSettings: mocks.getSettings,
  listAiIntelReportAttempts: mocks.listAttempts,
  saveAiIntelReportSettings: mocks.saveSettings,
}));
vi.mock('../../services/api/ai-engines', () => ({
  listAiEngines: mocks.listEngines,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AdminAiIntelReportsPage } from './index';

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminAiIntelReportsPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
  window.history.replaceState({}, '', '/admin/ai/intelligence-reports');
  mocks.getSettings.mockReset().mockResolvedValue({
    quickSuggestionEnabled: true,
    quickAiEngineId: 'engine-a',
    legacyCommentCutoff: 1,
    updatedAt: 1,
  });
  mocks.listEngines.mockReset().mockResolvedValue([
    {
      id: 'engine-a',
      name: 'Engine A',
      url: 'http://engine-a/v1',
      modelName: 'model-a',
      enabled: true,
      callsignEnabled: true,
      ocrEnabled: false,
      hasToken: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  mocks.listAttempts.mockReset().mockResolvedValue([
    {
      id: 'attempt-success',
      loginId: 'login-a',
      login: 'operator-a',
      aiEngineId: 'engine-a',
      aiEngineName: 'Engine A',
      sourceMessageId: 3128366,
      outcome: 'success',
      suggestions: ['Облаштування позицій противника'],
      rawResponse: '{"suggestions":["Облаштування позицій противника"]}',
      error: null,
      durationMs: 1500,
      createdAt: Date.now(),
    },
    {
      id: 'attempt-failed',
      loginId: 'login-a',
      login: 'operator-a',
      aiEngineId: 'engine-a',
      aiEngineName: 'Engine A',
      sourceMessageId: 3128367,
      outcome: 'failed',
      suggestions: [],
      rawResponse: null,
      error: 'malformed structured output',
      durationMs: 25,
      createdAt: Date.now() - 1000,
    },
  ]);
  mocks.saveSettings.mockReset();
  mocks.notify.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as { localStorage?: Storage }).localStorage;
});

describe('AdminAiIntelReportsPage', () => {
  it('renders successful and failed attempts with their review results', async () => {
    const { container, root } = await renderPage();

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('Спроби швидких пропозицій');
    expect(container.textContent).toContain('Облаштування позицій противника');
    expect(container.textContent).toContain('malformed structured output');
    expect(container.textContent).toContain('3128366');

    await act(async () => root.unmount());
  });

  it('refreshes the attempt log without reloading settings', async () => {
    const { container, root } = await renderPage();
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Оновити',
    );

    await act(async () => refresh?.click());

    expect(mocks.listAttempts).toHaveBeenCalledTimes(2);
    expect(mocks.getSettings).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
