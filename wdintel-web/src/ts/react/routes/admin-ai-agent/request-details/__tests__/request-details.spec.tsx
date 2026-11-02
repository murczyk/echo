/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AiAgentAuditRequestDetail,
  AiAgentEvent,
  AiAgentMessage,
} from '../../../../services/api/ai-agent';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../../services/api/ai-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/ai-agent')>()),
  getAiAgentAuditRequest: mocks.get,
  streamAiAgentAdminEvents: mocks.stream,
}));
vi.mock('../../../../services/api/inbox-messages', () => ({
  fetchMessagesByIdsWithMetadata: vi.fn(),
}));
vi.mock('../../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { RequestDetailsDialog } from '../RequestDetailsDialog';

const CREATED_AT = 1_700_000_000_000;

function message(requestId: string, role: AiAgentMessage['role'], content: string): AiAgentMessage {
  return {
    id: `${requestId}-${role}`,
    requestId,
    role,
    requestState: 'completed',
    content,
    createdAt: CREATED_AT,
    citations: [],
    fileCitations: [],
    maps: [],
    attachments: [],
  };
}

function event(
  sequence: number,
  type: AiAgentEvent['type'],
  extra: Partial<AiAgentEvent> = {},
): AiAgentEvent {
  return {
    sequence,
    requestId: 'request-2',
    type,
    createdAt: CREATED_AT + sequence * 1000,
    text: null,
    toolCallId: null,
    toolName: null,
    sourceTitle: null,
    sourceUrl: null,
    method: null,
    path: null,
    status: null,
    isError: null,
    ...extra,
  };
}

function detail(overrides: Partial<AiAgentAuditRequestDetail> = {}): AiAgentAuditRequestDetail {
  return {
    id: 'request-2',
    humanLoginId: 'human',
    humanLogin: 'operator',
    conversationId: 'conversation',
    providerName: 'Engine',
    state: 'running',
    prompt: 'Second question',
    response: null,
    error: null,
    progress: [],
    toolActivity: [],
    createdAt: CREATED_AT,
    startedAt: CREATED_AT + 1000,
    completedAt: null,
    reviewState: 'pending',
    severity: null,
    reviewSummary: null,
    reviewCategories: [],
    reviewAttemptCount: 0,
    reviewLastError: null,
    alertState: null,
    alertAttemptCount: 0,
    alertLastError: null,
    conversation: {
      id: 'conversation',
      title: 'Dialogue',
      providerId: 'engine',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      messages: [
        message('request-1', 'user', 'First question'),
        message('request-1', 'assistant', 'Earlier **bold** answer'),
        { ...message('request-2', 'user', 'Second question'), requestState: 'running' },
        message('request-3', 'user', 'Third question'),
        message('request-3', 'assistant', 'Later answer'),
      ],
    },
    events: [],
    metadata: {
      aiEngineModelName: 'glm-5.3',
      aiEngineHost: 'llm.example:8443',
      agentLogin: 'agent',
      providerApi: 'openai-completions',
      reasoningPreset: 'deep',
      reasoningEffort: 'high',
      checkpointEffort: null,
      synthesisEffort: null,
      maxRuntimeSeconds: 900,
      finalizationSeconds: 60,
      completionMetadata: null,
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(request: AiAgentAuditRequestDetail, props: Record<string, unknown> = {}) {
  const callbacks = {
    onClose: vi.fn(),
    onRequestUpdated: vi.fn(),
    onOpenRequest: vi.fn(),
    ...props,
  };
  await act(async () =>
    root.render(<RequestDetailsDialog request={request} {...(callbacks as never)} />),
  );
  await flush();
  return callbacks;
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.stream.mockReset();
  mocks.notify.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RequestDetailsDialog', () => {
  it('streams a running request like the chat and refreshes it once it finishes', async () => {
    let finish!: () => void;
    mocks.stream.mockImplementation(({ onEvent }: { onEvent: (value: AiAgentEvent) => void }) => {
      onEvent(event(1, 'request_start'));
      onEvent(event(2, 'progress', { text: 'Шукаю повідомлення' }));
      onEvent(event(3, 'assistant_delta', { text: 'Live **answer**' }));
      return new Promise<void>((resolve) => {
        finish = () => {
          onEvent(event(4, 'completion'));
          resolve();
        };
      });
    });
    const completed = detail({ state: 'completed', response: 'Live **answer**' });
    mocks.get.mockResolvedValue(completed);

    const callbacks = await render(detail());
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-2', afterSequence: 0 }),
    );
    const current = document.body.querySelector('[data-testid="admin-ai-current-turn"]')!;
    expect(current.querySelector('[data-testid="request-activity-title"]')?.textContent).toContain(
      'Шукаю повідомлення',
    );
    expect(current.querySelector('strong')?.textContent).toBe('answer');

    await act(async () => finish());
    await flush();
    expect(mocks.get).toHaveBeenCalledWith('request-2');
    expect(callbacks.onRequestUpdated).toHaveBeenCalledWith(completed);
  });
});
