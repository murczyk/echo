/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  conversations: vi.fn(),
}));

vi.mock('../../services/api/ai-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/ai-agent')>()),
  getAiAgentConfiguration: mocks.configuration,
  listAiAgentConversations: mocks.conversations,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: vi.fn() }),
}));

import { AiAgentChat } from '.';

const PROVIDER = {
  id: 'provider-1',
  name: 'Gemma',
  modelName: 'gemma',
  enabled: true,
  isDefault: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderChat() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onAvailabilityChange = vi.fn();
  act(() => root.render(<AiAgentChat onAvailabilityChange={onAvailabilityChange} />));
  return { container, root, onAvailabilityChange };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('AiAgentChat initial loading', () => {
  it('shows one React-owned spinner while configuration is unresolved', () => {
    mocks.configuration.mockReturnValue(new Promise(() => {}));
    const view = renderChat();

    expect(view.container.querySelectorAll('[aria-label="Завантаження ШІ чату"]')).toHaveLength(1);
    expect(view.container.textContent).not.toContain('Спитайте ЕХО');
    expect(view.container.textContent).not.toContain('Алгоритм роботи');

    act(() => view.root.unmount());
  });

  it('keeps the same spinner while conversation history is unresolved', async () => {
    const conversations = deferred<never[]>();
    mocks.configuration.mockResolvedValue({
      enabled: true,
      defaultProviderId: PROVIDER.id,
      providers: [PROVIDER],
    });
    mocks.conversations.mockReturnValue(conversations.promise);
    const view = renderChat();

    await act(async () => Promise.resolve());
    expect(view.container.querySelectorAll('[aria-label="Завантаження ШІ чату"]')).toHaveLength(1);
    expect(view.container.textContent).not.toContain('Спитайте ЕХО');
    expect(view.container.textContent).not.toContain('Алгоритм роботи');
    expect(view.container.querySelector('[aria-label="Провайдер ШІ"]')).toBeNull();

    act(() => conversations.resolve([]));
    await act(async () => Promise.resolve());
    expect(view.container.textContent).toContain('Спитайте ЕХО');
    expect(view.container.querySelectorAll('[aria-label="Завантаження ШІ чату"]')).toHaveLength(0);

    act(() => view.root.unmount());
  });

  it('keeps an unavailable bootstrap mounted with a retry state', async () => {
    mocks.configuration.mockRejectedValue(new Error('temporary failure'));
    const view = renderChat();

    await act(async () => Promise.resolve());
    expect(view.onAvailabilityChange).toHaveBeenCalledWith('unavailable');
    expect(view.container.textContent).toContain('Спробувати ще раз');
    expect(view.container.textContent).not.toContain('Спитайте ЕХО');
    expect(view.container.querySelector('[aria-label="Завантаження ШІ чату"]')).toBeNull();

    act(() => view.root.unmount());
  });
});
