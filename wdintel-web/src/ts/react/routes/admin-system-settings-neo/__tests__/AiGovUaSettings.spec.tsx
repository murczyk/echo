/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), models: vi.fn(), notify: vi.fn() }));
vi.mock('../../../services/api/ai-engines', () => ({
  getAiGovUaSettings: mocks.get,
  saveAiGovUaSettings: mocks.save,
  listAiGovUaModels: mocks.models,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
import { AiGovUaSettings } from '../AiGovUaSettings';

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

// Regression: https://github.com/echoua/echo/issues/3682
it('preserves an existing secret on save and reports failed authorization through a toast', async () => {
  const settings = {
    enabled: true,
    tenantId: 'tenant',
    clientId: 'client',
    scope: 'api://resource/.default',
    hasClientSecret: true,
    updatedAt: 1,
  };
  mocks.get.mockResolvedValue(settings);
  mocks.save.mockResolvedValue(settings);
  mocks.models.mockRejectedValue(new Error('Azure AI authentication returned HTTP 401'));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AiGovUaSettings />));
  await click('Державний шлюз ШІ: авторизація Azure');
  expect(document.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
  await click('Зберегти');
  expect(mocks.save).toHaveBeenCalledWith({
    enabled: true,
    tenantId: 'tenant',
    clientId: 'client',
    scope: 'api://resource/.default',
    clientSecret: null,
    clearClientSecret: false,
  });
  await click('Перевірити збережені налаштування');
  expect(mocks.notify).toHaveBeenCalledWith({
    severity: 'error',
    message: 'Azure AI authentication returned HTTP 401',
  });
  await click('Закрити');
  await act(async () => root.unmount());
});
