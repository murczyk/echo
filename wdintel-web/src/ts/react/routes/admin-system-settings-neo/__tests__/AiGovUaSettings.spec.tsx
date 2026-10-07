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
  await click('Перевірити налаштування');
  expect(mocks.notify).toHaveBeenCalledWith({
    severity: 'error',
    message: 'Azure AI authentication returned HTTP 401',
  });
  await click('Закрити');
  await act(async () => root.unmount());
});

// Regression: https://github.com/echoua/echo/issues/3682
it('checks unsaved form credentials while the gateway is disabled without saving them', async () => {
  mocks.get.mockResolvedValue({
    enabled: false,
    tenantId: 'tenant',
    clientId: 'client',
    scope: 'api://resource/.default',
    hasClientSecret: false,
    updatedAt: 1,
  });
  mocks.models.mockResolvedValue(['gpt-6-sol']);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AiGovUaSettings />));
  await click('Державний шлюз ШІ: авторизація Azure');
  const secret = document.querySelector<HTMLInputElement>('input[type=password]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      secret,
      'draft-secret',
    );
    secret.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Перевірити налаштування');
  expect(mocks.models).toHaveBeenCalledWith({
    enabled: false,
    tenantId: 'tenant',
    clientId: 'client',
    scope: 'api://resource/.default',
    clientSecret: 'draft-secret',
    clearClientSecret: false,
  });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(secret.value).toBe('draft-secret');
  expect(document.body.textContent).toContain('gpt-6-sol');
  await act(async () => root.unmount());
});
