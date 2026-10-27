/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { minimalInboxMessage } from '../../rer-duty-neo/inbox-message-mocks';

import type { AiAgentEvent } from '../../../services/api/ai-agent';

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
  delete: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
  map: vi.fn(),
  fetchSources: vi.fn(),
}));

vi.mock('../../../services/api/ai-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/ai-agent')>()),
  getAiAgentConfiguration: mocks.configuration,
  listAiAgentConversations: mocks.conversations,
  getAiAgentConversation: mocks.conversation,
  submitAiAgentRequest: mocks.submit,
  cancelAiAgentRequest: mocks.cancel,
  deleteAiAgentConversation: mocks.delete,
  getAiAgentMap: mocks.map,
  openAiAgentMapWorkspace: async (summary: unknown, signal?: AbortSignal) => {
    const document = await mocks.map(summary, signal);
    return {
      revision: 1,
      canUndo: false,
      canRedo: false,
      document,
      changes: { addedCount: 0, updatedCount: 0, removedCount: 0, changes: [] },
      revisions: [],
    };
  },
}));
vi.mock('../../../services/api/inbox-messages', () => ({
  fetchMessagesByIdsWithMetadata: mocks.fetchSources,
}));
vi.mock('../stream', () => ({
  streamAiAgentEventsWithReconnect: mocks.stream,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../MapCanvas', () => ({ default: () => <div>Точки мапи</div> }));
vi.mock('../app6d-catalog', async (importOriginal) => {
  const { APP6D_CATALOG } = await import('./app6d-catalog-fixture');
  return {
    ...(await importOriginal<typeof import('../app6d-catalog')>()),
    loadCatalog: () => Promise.resolve(APP6D_CATALOG),
  };
});

import { AiAgentChat } from '..';
import { resetSharedMapDocuments } from '../map-documents';
import { AI_AGENT_NEW_CONVERSATION_EVENT } from '../conversation-url';
import { HttpRequestError } from '../../../services/api/client';

const PROVIDER = {
  id: 'provider-1',
  name: 'Gemma',
  modelName: 'gemma',
  enabled: true,
  isDefault: true,
};

const CONVERSATION = {
  id: '11111111-1111-4111-8111-111111111111',
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
  window.history.replaceState({}, '', '/');
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
  mocks.delete.mockResolvedValue(undefined);
  mocks.map.mockImplementation(async (summary) => ({ ...summary, records: [] }));
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
  resetSharedMapDocuments();
});
describe('AiAgentChat request queue', () => {
  it('#3724 requires explicit Deep selection and preserves it on retry', async () => {
    mocks.configuration.mockResolvedValue({
      enabled: true,
      reasoningPresetsEnabled: true,
      defaultProviderId: PROVIDER.id,
      providers: [
        {
          ...PROVIDER,
          reasoningAvailable: true,
          reasoningPresets: [
            { preset: 'fast', maxRuntimeSeconds: 120, reasoningEffort: 'low' },
            { preset: 'balanced', maxRuntimeSeconds: 300, reasoningEffort: 'high' },
            { preset: 'deep', maxRuntimeSeconds: 1800, reasoningEffort: 'max' },
          ],
        },
      ],
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AiAgentChat />));
    await flush();
    const selector = () =>
      container.querySelector('[role="combobox"][aria-label="Глибина аналізу"]') as HTMLElement;
    expect(selector().textContent).toContain('Збалансований');
    await act(async () => selector().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await flush();
    const deep = Array.from(document.body.querySelectorAll('[role="option"]')).find((item) =>
      item.textContent?.includes('Глибокий'),
    )!;
    await act(async () => deep.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    mocks.submit.mockResolvedValueOnce({
      id: 'request-deep',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    setTextarea('Досліди докладно');
    submitForm();
    await flush();
    expect(mocks.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningPreset: 'deep' }),
    );
    expect(selector().textContent).toContain('Збалансований');
    await act(async () => streamEvent('request-deep', 1, 'error', 'provider failure'));
    mocks.submit.mockResolvedValueOnce({
      id: 'request-retry',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    await act(async () => clickButton('Спробувати ще раз'));
    await flush();
    expect(mocks.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningPreset: 'deep' }),
    );
    expect(container.textContent).toContain('Ви · Глибокий');
  });

  // The map workspace is lazy and pulls in milsymbol; load it once up front so
  // its first transform does not count against an individual test.
  beforeAll(async () => {
    await import('../MapWorkspace');
  }, 60_000);
  it('#3064 deduplicates replayed publications, replaces maps, and preserves draft text', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'request-maps',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    setTextarea('Побудуй мапу');
    submitForm();
    await flush();
    const summary = {
      id: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-maps',
      title: 'Головна',
      isMain: true,
      totalCount: 1,
      validCount: 1,
      invalidCount: 0,
      warnings: [],
    };
    const emitMap = (sequence: number, value = summary) =>
      connections.get('request-maps')?.onEvent({
        sequence,
        requestId: 'request-maps',
        type: 'map_artifact',
        createdAt: Date.now(),
        map: value,
        text: null,
        toolCallId: null,
        toolName: null,
        sourceTitle: null,
        sourceUrl: null,
        method: null,
        path: null,
        status: null,
        isError: null,
      });
    await act(async () => emitMap(1, { ...summary, isMain: false, title: 'Підмапа' }));
    expect(container.querySelectorAll('.ai-map-chip')).toHaveLength(1);
    expect(container.querySelectorAll('.ai-map-preview')).toHaveLength(0);
    await act(async () => clickAriaButton('Відкрити мапу: Підмапа'));
    await flush();
    await vi.waitFor(
      () => expect(document.querySelector('section[aria-label="Мапа відповіді"]')).not.toBeNull(),
      { timeout: 10_000 },
    );
    await act(async () => clickAriaButton('Закрити мапу', document.body));
    const main = { ...summary, id: '44444444-4444-4444-8444-444444444444' };
    await act(async () => {
      emitMap(2, main);
      emitMap(3, main);
    });
    expect(container.querySelectorAll('.ai-map-preview')).toHaveLength(1);
    expect(container.querySelectorAll('.ai-map-chip')).toHaveLength(1);
    setTextarea('Наступна чернетка');
    await act(async () => clickAriaButton('Відкрити мапу: Головна'));
    await flush();
    await vi.waitFor(
      () => expect(document.querySelector('section[aria-label="Мапа відповіді"]')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Наступна чернетка',
    );
    const next = { ...summary, id: '33333333-3333-4333-8333-333333333333', title: 'Наступна' };
    await act(async () => emitMap(4, next));
    await act(async () => clickAriaButton('Відкрити мапу: Наступна'));
    await flush();
    await vi.waitFor(
      () =>
        expect(
          document.querySelector<HTMLInputElement>(
            'section[aria-label="Мапа відповіді"] input[aria-label="Назва мапи"]',
          )?.value,
        ).toBe('Наступна'),
      { timeout: 10_000 },
    );
    await act(async () => clickAriaButton('Закрити мапу', document.body));
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Наступна чернетка',
    );
    await act(async () => clickAriaButton('Відкрити мапу: Наступна'));
    await act(async () => window.dispatchEvent(new Event(AI_AGENT_NEW_CONVERSATION_EVENT)));
    await flush();
    expect(document.querySelector('section[aria-label="Мапа відповіді"]')).toBeNull();
  });
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
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);

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

  it('#3064 stops queued and running tasks from the composer, deduplicates clicks and retains published maps and drafts', async () => {
    mocks.submit
      .mockResolvedValueOnce({ id: 'request-1', conversationId: CONVERSATION.id, state: 'queued' })
      .mockResolvedValueOnce({
        id: 'request-2',
        conversationId: CONVERSATION.id,
        state: 'running',
      });
    setTextarea('Перший запит');
    submitForm();
    await flush();
    setTextarea('Другий запит');
    submitForm();
    await flush();
    setTextarea('Чернетка наступного запиту');
    const map = {
      id: '33333333-3333-4333-8333-333333333333',
      requestId: 'request-1',
      title: 'Опублікована мапа',
      isMain: false,
      totalCount: 107,
      validCount: 107,
      invalidCount: 0,
      warnings: [],
    };
    await act(async () =>
      connections.get('request-1')!.onEvent({
        sequence: 1,
        requestId: 'request-1',
        type: 'map_artifact',
        createdAt: Date.now(),
        text: null,
        toolCallId: null,
        toolName: null,
        sourceTitle: null,
        sourceUrl: null,
        method: null,
        path: null,
        status: null,
        isError: null,
        map,
      }),
    );
    let acceptStop!: () => void;
    mocks.cancel
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acceptStop = () => resolve('cancelled');
          }),
      )
      .mockRejectedValueOnce(new Error('Сервіс недоступний'));
    await act(async () => {
      clickAriaButton('Зупинити всі запити');
      clickAriaButton('Зупинити всі запити');
    });
    await flush();
    expect(mocks.cancel.mock.calls).toEqual([['request-1'], ['request-2']]);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        message: 'Не вдалося скасувати запит: Сервіс недоступний',
      }),
    );
    await act(async () => acceptStop());
    await flush();
    const stop = container.querySelector(
      'button[aria-label="Зупинити запит"]',
    ) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="live-request-request-1"]')?.textContent,
    ).toContain('Скасовано');
    expect(container.querySelector('.ai-map-chip')).not.toBeNull();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Чернетка наступного запиту',
    );
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 410));
      clickAriaButton('Зупинити запит');
    });
    await flush();
    expect(mocks.cancel.mock.calls).toEqual([['request-1'], ['request-2'], ['request-2']]);
    expect(container.querySelector('button[aria-label="Зупинити запит"]')).toBeNull();
    expect(container.querySelector('.ai-map-chip')).not.toBeNull();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Чернетка наступного запиту',
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
    await act(async () => clickAriaButton('Зупинити запит'));
    await flush();

    expect(request.textContent).not.toContain('Завершено');
    expect(request.textContent).toContain('Повна відповідь');
    expect(request.textContent).not.toContain('Скасовано');
    expect(connections.get('request-1')?.signal.aborted).toBe(false);
  });

  it.each(['Незавершена нотатка', ''])(
    '#3064 preserves the composer on retry rejection and submits once for rapid retry clicks (draft: %s)',
    async (draft) => {
      mocks.submit.mockResolvedValueOnce({
        id: 'request-failed',
        conversationId: CONVERSATION.id,
        state: 'running',
      });
      setTextarea('Повтори цей початковий запит');
      submitForm();
      await flush();
      await act(async () => streamEvent('request-failed', 1, 'error', 'internal diagnostic'));
      await act(async () => setTextarea(draft));

      let rejectRetry!: (error: Error) => void;
      mocks.submit.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRetry = reject;
          }),
      );
      const request = container.querySelector(
        '[data-testid="live-request-request-failed"]',
      ) as HTMLElement;
      const retry = Array.from(request.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Спробувати ще раз',
      ) as HTMLButtonElement;
      expect(retry).toBeDefined();
      await act(async () => {
        clickButton('Спробувати ще раз', request);
        clickButton('Спробувати ще раз', request);
      });
      await flush();

      expect(mocks.submit).toHaveBeenCalledTimes(2);
      expect(mocks.submit).toHaveBeenLastCalledWith({
        conversationId: CONVERSATION.id,
        providerId: PROVIDER.id,
        message: 'Повтори цей початковий запит',
      });
      expect(retry.disabled).toBe(true);
      expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(draft);

      await act(async () => rejectRetry(new Error('мережа недоступна')));
      await flush();

      expect(retry.disabled).toBe(false);
      expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(draft);
      expect(container.querySelector('[data-testid="pending-ai-agent-request"]')).toBeNull();
      expect(mocks.notify).toHaveBeenCalledWith({
        severity: 'error',
        message: 'Не вдалося надіслати запит: мережа недоступна',
      });
    },
  );

  it('restores a failed submission and reports it through a toast', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('мережа недоступна'));
    setTextarea('Не втратити цей текст');
    submitForm();
    await flush();

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Не втратити цей текст',
    );
    expect(window.location.search).toBe('');
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

    await act(async () => clickAriaButton('Відновити потік', request));
    await flush();

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(connections.get('request-1')?.signal.aborted).toBe(false);
    expect(request.textContent).not.toContain('Потік перервано');
  });

  it('#3724 restored a context-limited answer and its coverage warning after reload', async () => {
    mocks.fetchSources.mockResolvedValue({
      inboxItems: [
        [1, minimalInboxMessage({ text: 'Synthetic document', groupMasterKey: 'fixture' })],
      ],
      signalGroups: [{ masterKey: 'fixture', name: 'Документи' }],
    });
    mocks.conversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          id: 'request-partial-assistant',
          requestId: 'request-partial',
          requestState: 'completed',
          role: 'assistant',
          content: 'Часткова відповідь [джерело](/rer-analysis-neo?m=fixture-1)',
          createdAt: Date.now(),
          startedAt: Date.now() - 317_000,
          citations: [{ messageId: 1, messageIdentifier: 'fixture-1' }],
          completionMetadata: { coverageLimited: true, reason: 'context_limit' },
        },
      ],
    });
    window.history.replaceState({}, '', `?conversation=${CONVERSATION.id}`);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AiAgentChat />));
    await flush();
    expect(container.textContent).toContain('Часткова відповідь');
    expect(container.textContent).toContain('Охоплення джерел неповне');
    expect(container.querySelector('a[href="/rer-analysis-neo?m=fixture-1"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Не вдалося виконати запит');
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

  it('opens prior conversations from a side panel and updates the URL', async () => {
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
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);
  });

  it('restores the active conversation and reconnects every queued or running request', async () => {
    window.history.replaceState({}, '', `/?conversation=${CONVERSATION.id}`);
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
    window.history.replaceState({}, '', `/?conversation=${CONVERSATION.id}`);
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

// Regression: https://github.com/echoua/echo/issues/3064
async function navigateToConversation(id: string | null) {
  await act(async () => {
    window.history.pushState({}, '', id === null ? '/' : `/?conversation=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await flush();
}

async function resetFromLogo() {
  await act(async () => {
    window.dispatchEvent(new Event(AI_AGENT_NEW_CONVERSATION_EVENT));
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await flush();
}

async function reloadChat() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<AiAgentChat />));
  await flush();
}

async function openDeleteDialog() {
  if (container.querySelector('aside')?.getAttribute('aria-hidden') === 'true') {
    await act(async () => clickAriaButton('Розгорнути ліву панель'));
  }
  await act(async () => clickAriaButton(`Меню розмови «${CONVERSATION.title}»`));
  await flush();
  const item = document.body.querySelector('[role="menuitem"]');
  expect(item?.textContent).toBe('Видалити');
  await act(async () => item?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('#3064 conversation navigation races', () => {
  it('ignores legacy storage and resets a draft even when the logo already points to /', async () => {
    window.sessionStorage.setItem('echo.ai-agent.active-conversation-id', CONVERSATION.id);
    await reloadChat();
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('echo.ai-agent.active-conversation-id')).toBeNull();
    setTextarea('Чернетка');
    await resetFromLogo();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(window.location.search).toBe('');
  });

  it('detaches the stream without cancelling the server request and restores it on return', async () => {
    mocks.submit.mockResolvedValueOnce({
      id: 'background',
      conversationId: CONVERSATION.id,
      state: 'running',
    });
    setTextarea('Продовжуй у фоні');
    submitForm();
    await flush();
    const connection = connections.get('background')!;
    await resetFromLogo();
    expect(connection.signal.aborted).toBe(true);
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => connection.onEvent({ sequence: 1, type: 'error' } as AiAgentEvent));
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.conversation.mockResolvedValueOnce({
      ...CONVERSATION,
      messages: [
        {
          id: 'user',
          requestId: 'background',
          requestState: 'running',
          role: 'user',
          content: 'Продовжуй у фоні',
          createdAt: 1,
        },
      ],
    });
    await navigateToConversation(CONVERSATION.id);
    expect(container.textContent).toContain('Продовжуй у фоні');
    expect(connections.get('background')?.signal.aborted).toBe(false);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('does not let an old submission reclaim the URL or unlock a newer pending submission', async () => {
    const old = deferred<{ id: string; conversationId: string; state: string }>();
    const next = deferred<{ id: string; conversationId: string; state: string }>();
    mocks.submit.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    setTextarea('Старий запит');
    submitForm();
    await flush();
    expect(window.location.search).toBe('');
    await resetFromLogo();
    setTextarea('Новий запит');
    submitForm();
    await flush();
    await act(async () =>
      old.resolve({ id: 'old', conversationId: CONVERSATION.id, state: 'running' }),
    );
    await flush();
    expect(window.location.search).toBe('');
    expect(container.textContent).not.toContain('Старий запит');
    expect(
      container.querySelector('[data-testid="pending-ai-agent-request"]')?.textContent,
    ).toContain('Новий запит');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(mocks.stream).not.toHaveBeenCalled();
    const nextId = '22222222-2222-4222-8222-222222222222';
    await act(async () => next.resolve({ id: 'new', conversationId: nextId, state: 'queued' }));
    await flush();
    expect(window.location.search).toBe(`?conversation=${nextId}`);
    expect(container.textContent).toContain('Новий запит');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('discards late conversation loads after returning to a fresh dialogue', async () => {
    const old = deferred<unknown>();
    mocks.conversation.mockReturnValueOnce(old.promise);
    window.history.replaceState({}, '', `/?conversation=${CONVERSATION.id}`);
    await reloadChat();
    await resetFromLogo();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    setTextarea('Нова чернетка');
    await act(async () =>
      old.resolve({
        ...CONVERSATION,
        messages: [
          {
            id: 'old',
            requestId: 'old',
            requestState: 'completed',
            role: 'assistant',
            content: 'Застаріла відповідь',
            createdAt: 1,
          },
        ],
      }),
    );
    await flush();
    expect(window.location.search).toBe('');
    expect(container.textContent).not.toContain('Застаріла відповідь');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Нова чернетка',
    );
  });

  it('clears invalid or unavailable bookmarks but retains a transiently failed URL for retry', async () => {
    await navigateToConversation('not-a-uuid');
    expect(window.location.search).toBe('');
    expect(mocks.conversation).not.toHaveBeenCalled();
    mocks.conversation.mockRejectedValueOnce(new HttpRequestError(404, 'Розмову не знайдено'));
    await navigateToConversation(CONVERSATION.id);
    expect(window.location.search).toBe('');
    mocks.conversation.mockRejectedValueOnce(new HttpRequestError(503, 'Тимчасово недоступно'));
    await navigateToConversation(CONVERSATION.id);
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => clickButton('Спробувати ще раз'));
    await flush();
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    expect(mocks.notify).toHaveBeenCalledTimes(3);
  });
});

describe('#3064 history deletion safeguards', () => {
  beforeEach(async () => {
    mocks.conversations.mockResolvedValue([CONVERSATION]);
    await reloadChat();
  });

  it('requires confirmation, keeps failed deletions, and only resets the viewed conversation after success', async () => {
    await selectConversation();
    await openDeleteDialog();
    expect(mocks.delete).not.toHaveBeenCalled();
    await act(async () => clickButton('Скасувати', document.body));
    await flush();
    expect(mocks.delete).not.toHaveBeenCalled();
    await openDeleteDialog();
    mocks.delete.mockRejectedValueOnce(new Error('Неможливо видалити розмову з активним запитом'));
    await act(async () => clickButton('Видалити', document.body));
    await flush();
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);
    expect(container.querySelector('aside')?.textContent).toContain(CONVERSATION.title);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('активним запитом') }),
    );
    const deletion = deferred<void>();
    mocks.delete.mockReturnValueOnce(deletion.promise);
    await act(async () => {
      clickButton('Видалити', document.body);
      clickButton('Видалити', document.body);
    });
    await flush();
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe(`?conversation=${CONVERSATION.id}`);
    await act(async () => deletion.resolve());
    await flush();
    expect(window.location.search).toBe('');
    expect(container.querySelector('aside')?.textContent).not.toContain(CONVERSATION.title);
  });

  it('keeps a different viewed conversation and filters deleted rows from late history responses', async () => {
    const listing = deferred<unknown>();
    mocks.conversations.mockReturnValueOnce(listing.promise);
    const otherId = '22222222-2222-4222-8222-222222222222';
    mocks.submit.mockResolvedValueOnce({ id: 'other', conversationId: otherId, state: 'running' });
    setTextarea('Інша розмова');
    submitForm();
    await flush();
    await openDeleteDialog();
    await act(async () => clickButton('Видалити', document.body));
    await flush();
    expect(window.location.search).toBe(`?conversation=${otherId}`);
    expect(container.textContent).toContain('Інша розмова');
    await act(async () => listing.resolve([CONVERSATION]));
    await flush();
    expect(container.querySelector('aside')?.textContent).not.toContain(CONVERSATION.title);
    expect(connections.get('other')?.signal.aborted).toBe(false);
  });
});
