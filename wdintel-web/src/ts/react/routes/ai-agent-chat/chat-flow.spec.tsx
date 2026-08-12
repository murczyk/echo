/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiAgentEvent } from '../../services/api/ai-agent';

type StreamConnection = {
  signal: AbortSignal;
  onEvent: (event: AiAgentEvent) => void;
};

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  conversations: vi.fn(),
  conversation: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/ai-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/ai-agent')>()),
  getAiAgentConfiguration: mocks.configuration,
  listAiAgentConversations: mocks.conversations,
  getAiAgentConversation: mocks.conversation,
  submitAiAgentRequest: mocks.submit,
  cancelAiAgentRequest: mocks.cancel,
}));
vi.mock('./stream', () => ({
  streamAiAgentEventsWithReconnect: mocks.stream,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AiAgentChat } from '.';

const PROVIDER = {
  id: 'provider-1',
  name: 'Gemma',
  modelName: 'gemma',
  enabled: true,
  isDefault: true,
};

const CONVERSATION = {
  id: 'conversation-1',
  title: 'Розвіддані',
  providerId: PROVIDER.id,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

let container: HTMLDivElement;
let root: Root;
let connections: Map<string, StreamConnection>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

function setTextarea(value: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitForm() {
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function clickButton(label: string, scope: ParentNode = container) {
  const button = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function clickAriaButton(label: string, scope: ParentNode = container) {
  const button = scope.querySelector(`button[aria-label="${label}"]`);
  expect(button, `button ${label}`).not.toBeNull();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function selectConversation() {
  const historyButton = container.querySelector(
    'button[aria-label="Розгорнути ліву панель"]',
  ) as HTMLButtonElement;
  await act(async () => historyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
  const historyPanel = container.querySelector('aside');
  expect(historyPanel?.closest('.MuiCard-root')).toBeNull();
  const option = Array.from(document.body.querySelectorAll('[role="button"]')).find((item) =>
    item.textContent?.includes(CONVERSATION.title),
  );
  expect(option).toBeDefined();
  await act(async () => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

function streamEvent(
  requestId: string,
  sequence: number,
  type: AiAgentEvent['type'],
  text: string,
) {
  connections.get(requestId)?.onEvent({
    sequence,
    requestId,
    type,
    createdAt: Date.now(),
    text,
    toolCallId: null,
    toolName: null,
    sourceTitle: null,
    sourceUrl: null,
    method: null,
    path: null,
    status: null,
    isError: null,
  });
}

beforeEach(async () => {
  window.sessionStorage.clear();
  connections = new Map();
  mocks.configuration.mockResolvedValue({
    enabled: true,
    defaultProviderId: PROVIDER.id,
    providers: [PROVIDER],
  });
  mocks.conversations.mockResolvedValue([]);
  mocks.conversation.mockResolvedValue({ ...CONVERSATION, messages: [] });
  mocks.cancel.mockResolvedValue('cancelled');
  mocks.stream.mockImplementation(
    ({ requestId, signal, onEvent }: { requestId: string } & StreamConnection) =>
      new Promise<void>((resolve, reject) => {
        connections.set(requestId, { signal, onEvent });
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AiAgentChat />));
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.sessionStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AiAgentChat request queue', () => {
  it('keeps following new progress when the viewport is at the bottom', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    mocks.submit.mockResolvedValueOnce({
      id: 'request-follow',
      conversationId: CONVERSATION.id,
      state: 'running',
    });

    setTextarea('Покажи хід виконання');
    submitForm();
    await flush();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('renders assistant Markdown as formatted content', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-markdown',
      conversationId: CONVERSATION.id,
      state: 'running',
    });

    setTextarea('Покажи Markdown');
    submitForm();
    await flush();
    await act(async () =>
      streamEvent('request-markdown', 1, 'assistant_delta', '**Важливо**\n\n- пункт'),
    );

    const request = container.querySelector(
      '[data-testid="live-request-request-markdown"]',
    ) as HTMLElement;
    expect(request.querySelector('strong')?.textContent).toBe('Важливо');
    expect(request.querySelector('li')?.textContent).toBe('пункт');
  });

  it('renders assistant Markdown tables', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-table',
      conversationId: CONVERSATION.id,
      state: 'running',
    });

    setTextarea('Покажи таблицю');
    submitForm();
    await flush();
    await act(async () =>
      streamEvent(
        'request-table',
        1,
        'assistant_delta',
        '| Дата | Суть |\n| :--- | :--- |\n| 30.07.2026 | Повідомлення |',
      ),
    );

    const request = container.querySelector(
      '[data-testid="live-request-request-table"]',
    ) as HTMLElement;
    expect(request.querySelectorAll('table')).toHaveLength(1);
    expect(request.querySelectorAll('th')).toHaveLength(2);
    expect(request.querySelectorAll('td')).toHaveLength(2);
  });

  it('serializes request creation, then streams and cancels requests independently', async () => {
    let resolveFirst:
      ((value: { id: string; conversationId: string; state: 'queued' }) => void) | null = null;
    mocks.submit
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        id: 'request-2',
        conversationId: CONVERSATION.id,
        state: 'queued',
      });

    setTextarea('Перший запит');
    submitForm();
    submitForm();
    await flush();
    expect(mocks.submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.({
        id: 'request-1',
        conversationId: CONVERSATION.id,
        state: 'queued',
      });
      await Promise.resolve();
    });
    await flush();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    setTextarea('Другий запит');
    submitForm();
    await flush();

    expect(mocks.submit).toHaveBeenNthCalledWith(2, {
      conversationId: CONVERSATION.id,
      providerId: PROVIDER.id,
      message: 'Другий запит',
    });
    expect(container.querySelector('[data-testid="live-request-request-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="live-request-request-2"]')).not.toBeNull();
    expect(window.sessionStorage.getItem('echo.ai-agent.active-conversation-id')).toBe(
      CONVERSATION.id,
    );

    await act(async () => streamEvent('request-2', 1, 'request_start', ''));
    await act(async () => streamEvent('request-2', 2, 'assistant_delta', 'Друга відповідь'));
    expect(
      container.querySelector('[data-testid="live-request-request-2"]')?.textContent,
    ).toContain('Друга відповідь');
    expect(
      container.querySelector('[data-testid="live-request-request-1"]')?.textContent,
    ).not.toContain('Друга відповідь');

    const firstRequest = container.querySelector(
      '[data-testid="live-request-request-1"]',
    ) as HTMLElement;
    await act(async () => clickAriaButton('Скасувати запит', firstRequest));
    await flush();

    expect(mocks.cancel).toHaveBeenCalledWith('request-1');
    expect(connections.get('request-1')?.signal.aborted).toBe(false);
    expect(connections.get('request-2')?.signal.aborted).toBe(false);
    expect(firstRequest.textContent).toContain('Скасовано');
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Втрачено зв’язок') }),
    );
  });

  it('keeps a completed request and its answer when cancellation loses the terminal-state race', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-1',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    mocks.cancel.mockResolvedValueOnce('completed');
    mocks.conversation.mockResolvedValueOnce({
      ...CONVERSATION,
      messages: [
        {
          id: 'request-1-user',
          requestId: 'request-1',
          requestState: 'completed',
          role: 'user',
          content: 'Запит на межі завершення',
          createdAt: Date.now(),
        },
        {
          id: 'request-1-assistant',
          requestId: 'request-1',
          requestState: 'completed',
          role: 'assistant',
          content: 'Повна відповідь',
          createdAt: Date.now(),
        },
      ],
    });

    setTextarea('Запит на межі завершення');
    submitForm();
    await flush();

    const request = container.querySelector(
      '[data-testid="live-request-request-1"]',
    ) as HTMLElement;
    await act(async () => clickAriaButton('Скасувати запит', request));
    await flush();

    expect(request.textContent).not.toContain('Завершено');
    expect(request.textContent).toContain('Повна відповідь');
    expect(request.textContent).not.toContain('Скасовано');
    expect(connections.get('request-1')?.signal.aborted).toBe(false);
  });

  it('restores a failed submission and reports it through a toast', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('мережа недоступна'));
    setTextarea('Не втратити цей текст');
    submitForm();
    await flush();

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Не втратити цей текст',
    );
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося надіслати запит: мережа недоступна',
    });
  });

  it('keeps a request cancellable and allows reconnect after its stream fails', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-1',
      conversationId: CONVERSATION.id,
      state: 'queued',
    });
    mocks.stream.mockRejectedValueOnce(new Error('тимчасово недоступно'));

    setTextarea('Запит із перепідключенням');
    submitForm();
    await flush();

    const request = container.querySelector(
      '[data-testid="live-request-request-1"]',
    ) as HTMLElement;
    expect(request.textContent).toContain('Готуємо запит…');
    expect(request.textContent).toContain(
      'Потік перервано: Не вдалося відновити з’єднання з потоком відповіді.',
    );
    const cancelButton = request.querySelector('button[aria-label="Скасувати запит"]');
    expect(cancelButton).not.toBeNull();
    expect(cancelButton?.textContent).toBe('');
    expect(cancelButton?.querySelector('svg')).not.toBeNull();
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося відновити з’єднання з потоком відповіді.',
    });
    expect(request.textContent).not.toContain('тимчасово недоступно');

    await act(async () => clickButton('Відновити потік', request));
    await flush();

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(connections.get('request-1')?.signal.aborted).toBe(false);
    expect(request.textContent).not.toContain('Потік перервано');
  });

  it('reconciles a terminal backend state before showing a connection failure', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-terminal',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    mocks.stream.mockRejectedValueOnce(new Error('internal proxy diagnostic'));
    mocks.conversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          id: 'request-terminal-user',
          requestId: 'request-terminal',
          requestState: 'completed',
          role: 'user',
          content: 'Запит',
          createdAt: Date.now(),
        },
        {
          id: 'request-terminal-assistant',
          requestId: 'request-terminal',
          requestState: 'completed',
          role: 'assistant',
          content: 'Збережена відповідь',
          createdAt: Date.now(),
        },
      ],
    });

    setTextarea('Запит');
    submitForm();
    await flush();

    const request = container.querySelector(
      '[data-testid="live-request-request-terminal"]',
    ) as HTMLElement;
    expect(request.textContent).toContain('Збережена відповідь');
    expect(request.textContent).not.toContain('Потік перервано');
    expect(request.textContent).not.toContain('internal proxy diagnostic');
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('з’єднання') }),
    );
  });
});

describe('AiAgentChat conversation controls', () => {
  it('renders the polished empty state, provider control, and hidden history pane', () => {
    expect(container.textContent).toContain('Спитайте ЕХО');
    expect(container.textContent).not.toContain('Поставте запитання про дані ECHO.');
    expect(
      container.querySelector('[aria-label="Провайдер ШІ"]')?.getAttribute('aria-disabled'),
    ).not.toBe('true');
    expect(container.querySelector('.MuiSelect-icon')).not.toBeNull();
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps sources hidden and sanitizes request failures', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-failure',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    setTextarea('Запит');
    submitForm();
    await flush();

    await act(async () => {
      streamEvent('request-failure', 1, 'progress', 'Завантажую дані');
      connections.get('request-failure')?.onEvent({
        sequence: 2,
        requestId: 'request-failure',
        type: 'source',
        createdAt: Date.now(),
        text: null,
        toolCallId: null,
        toolName: 'echo_inbox_messages',
        sourceTitle: 'Дані Echo',
        sourceUrl: null,
        method: 'POST',
        path: '/api/rer-importer/get-inbox',
        status: 200,
        isError: false,
      });
      streamEvent('request-failure', 3, 'error', 'internal stack and credential');
    });

    const request = container.querySelector(
      '[data-testid="live-request-request-failure"]',
    ) as HTMLElement;
    expect(request.textContent).toContain('Завантажую дані');
    expect(request.textContent).toContain('Не вдалося виконати запит. Спробуйте ще раз.');
    expect(request.textContent).not.toContain('Джерела');
    expect(request.textContent).not.toContain('Дані Echo');
    expect(request.textContent).not.toContain('internal stack and credential');
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося виконати запит. Спробуйте ще раз.',
    });
  });

  it('opens prior conversations from a side panel without edit or delete controls', async () => {
    mocks.conversations.mockResolvedValue([CONVERSATION]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AiAgentChat />));
    await flush();

    await selectConversation();
    expect(mocks.conversation).toHaveBeenCalledWith(CONVERSATION.id);
    expect(document.body.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      container.querySelector('[aria-label="Провайдер ШІ"]')?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(document.body.querySelector('[aria-label="Перейменувати розмову"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Видалити розмову"]')).toBeNull();
  });

  it('restores the active conversation and reconnects every queued or running request', async () => {
    window.sessionStorage.setItem('echo.ai-agent.active-conversation-id', CONVERSATION.id);
    mocks.conversations.mockResolvedValue([CONVERSATION]);
    mocks.conversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          id: 'request-queued-user',
          requestId: 'request-queued',
          requestState: 'queued',
          role: 'user',
          content: 'Запит у черзі',
          createdAt: Date.now(),
        },
        {
          id: 'request-running-user',
          requestId: 'request-running',
          requestState: 'running',
          role: 'user',
          content: 'Активний запит',
          createdAt: Date.now(),
        },
      ],
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AiAgentChat />));
    await flush();

    expect(mocks.conversation).toHaveBeenCalledWith(CONVERSATION.id);
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-queued' }),
    );
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-running' }),
    );
    expect(container.textContent).toContain('Запит у черзі');
    expect(container.textContent).toContain('Активний запит');
  });

  it('renders restored failed and cancelled requests inline without repeat toasts', async () => {
    window.sessionStorage.setItem('echo.ai-agent.active-conversation-id', CONVERSATION.id);
    mocks.conversations.mockResolvedValue([CONVERSATION]);
    mocks.conversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          id: 'request-failed-user',
          requestId: 'request-failed',
          requestState: 'failed',
          role: 'user',
          content: 'Невдалий запит',
          createdAt: Date.now(),
        },
        {
          id: 'request-cancelled-user',
          requestId: 'request-cancelled',
          requestState: 'cancelled',
          role: 'user',
          content: 'Скасований запит',
          createdAt: Date.now(),
        },
      ],
    });
    mocks.notify.mockClear();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AiAgentChat />));
    await flush();

    expect(container.textContent).toContain('Не вдалося виконати запит. Спробуйте ще раз.');
    expect(container.textContent).toContain('Запит скасовано.');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
