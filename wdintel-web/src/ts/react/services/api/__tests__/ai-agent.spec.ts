/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

vi.mock('../client', () => ({
  getJson: mocks.getJson,
  postJson: mocks.postJson,
  postVoid: mocks.postVoid,
}));

import {
  cancelAiAgentRequest,
  getAiAgentAuditRequest,
  getAiAgentSettings,
  saveAiAgentDispatcher,
  saveAiAgentSettings,
  streamAiAgentEvents,
  testAiAgentDispatcher,
  updateAiAgentConversation,
} from '../ai-agent';

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AI agent API mapping', () => {
  // @test-scope safeguard: prevents runtime profiles for disallowed AI engines from being submitted
  it('round-trips provider runtime profiles for allowed engines', async () => {
    const response = {
      featureEnabled: true,
      defaultAiEngineId: 'sol',
      allowedAiEngineIds: ['sol'],
      providerRuntimeProfiles: [
        {
          aiEngineId: 'sol',
          contextWindowTokens: 1_050_000,
          maxOutputTokens: 65_536,
          compactionReserveTokens: 98_304,
          compactionKeepRecentTokens: 49_152,
        },
      ],
      templateLoginId: 'template',
      reviewerAiEngineId: null,
      securityReviewEnabled: false,
      mattermostChatEnabled: false,
      hasMattermostWebhook: false,
    };
    mocks.getJson.mockResolvedValue(response);
    mocks.postJson.mockResolvedValue(response);

    const settings = await getAiAgentSettings();
    await saveAiAgentSettings({
      ...settings,
      providerRuntimeProfiles: [
        ...settings.providerRuntimeProfiles,
        {
          aiEngineId: 'not-allowed',
          contextWindowTokens: 131_072,
          maxOutputTokens: 16_384,
          compactionReserveTokens: 32_768,
          compactionKeepRecentTokens: 16_384,
        },
      ],
    });

    expect(mocks.postJson).toHaveBeenCalledWith('/api/admin/ai-agent/settings', {
      featureEnabled: true,
      defaultAiEngineId: 'sol',
      allowedAiEngineIds: ['sol'],
      providerRuntimeProfiles: response.providerRuntimeProfiles,
      templateLoginId: 'template',
      reviewerAiEngineId: null,
      securityReviewEnabled: false,
      mattermostChatEnabled: false,
      mattermostWebhookUrl: null,
      clearMattermostWebhook: false,
    });
  });

  // @test-scope parser: AI-agent cancellation response state normalization fixture
  it('returns the authoritative state from cancellation', async () => {
    mocks.postJson.mockResolvedValue({ state: 'completed' });

    await expect(cancelAiAgentRequest('request-1')).resolves.toBe('completed');
    expect(mocks.postJson).toHaveBeenCalledWith('/api/ai-agent/requests/cancel', {
      requestId: 'request-1',
    });
  });

  // @test-scope parser: AI-agent audit activity and conversation response normalization fixture
  it('keeps structured API activity and Mattermost alert retry state', async () => {
    mocks.postJson.mockResolvedValue({
      request: {
        id: 'request-1',
        conversationId: 'conversation-1',
        humanLoginId: 'human-1',
        humanLogin: 'ziggy',
        aiEngineId: 'engine-1',
        aiEngineName: 'Gemma',
        prompt: 'Запит',
        response: 'Відповідь',
        state: 'completed',
        error: 'runner release mismatch',
        queuedAt: 1_700_000_000_000,
        startedAt: 1_700_000_001_000,
        completedAt: 1_700_000_002_000,
        review: {
          state: 'suspicious',
          severity: 'high',
          categories: ['route-probing'],
          summary: 'Підозрілий маршрут',
          attemptCount: 2,
          lastError: null,
          alertState: 'failed',
          alertAttemptCount: 3,
          alertLastError: 'Mattermost HTTP 503',
        },
      },
      conversation: {
        id: 'conversation-1',
        title: 'Контекст',
        aiEngineId: 'engine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_002_000,
        messages: [
          {
            requestId: 'request-0',
            requestState: 'completed',
            role: 'user',
            content: 'Попередній запит',
            createdAt: 1_699_999_999_000,
          },
          {
            requestId: 'request-0',
            requestState: 'completed',
            role: 'assistant',
            content: 'Попередня відповідь',
            createdAt: 1_699_999_999_500,
          },
          {
            requestId: 'request-1',
            requestState: 'completed',
            role: 'user',
            content: 'Запит',
            createdAt: 1_700_000_000_000,
          },
          {
            requestId: 'request-1',
            requestState: 'completed',
            role: 'assistant',
            content: 'Відповідь',
            createdAt: 1_700_000_002_000,
          },
        ],
      },
      events: [
        {
          sequence: 1,
          eventType: 'tool_end',
          payloadJson: JSON.stringify({
            tool: 'echo_current_user',
            method: 'GET',
            path: '/api/user',
            status: 200,
            is_error: false,
            reasoning: 'не показувати',
          }),
          createdAt: 1_700_000_001_500,
        },
      ],
    });

    const request = await getAiAgentAuditRequest('request-1');

    expect(request.toolActivity).toEqual([
      'echo_current_user · GET /api/user · HTTP 200 · успішно',
    ]);
    expect(request).toMatchObject({
      reviewCategories: ['route-probing'],
      reviewAttemptCount: 2,
      reviewLastError: null,
      error: 'runner release mismatch',
      alertState: 'failed',
      alertAttemptCount: 3,
      alertLastError: 'Mattermost HTTP 503',
    });
    expect(request.conversation).toMatchObject({
      id: 'conversation-1',
      title: 'Контекст',
    });
    expect(request.conversation.messages.map((message) => message.id)).toEqual([
      'request-0-user',
      'request-0-assistant',
      'request-1-user',
      'request-1-assistant',
    ]);
    expect(JSON.stringify(request)).not.toContain('не показувати');
  });

  // @test-scope parser: AI-agent conversation response normalization generates unique message keys.
  it('normalizes response-generated unique message keys after a title update', async () => {
    mocks.postJson.mockResolvedValue({
      id: 'conversation-1',
      title: 'Нова назва',
      aiEngineId: 'provider-1',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      messages: [
        {
          requestId: 'request-1',
          requestState: 'completed',
          role: 'user',
          content: 'Запит',
          createdAt: 1_700_000_000_000,
        },
        {
          requestId: 'request-1',
          requestState: 'completed',
          role: 'assistant',
          content: 'Відповідь',
          createdAt: 1_700_000_001_000,
        },
      ],
    });

    const conversation = await updateAiAgentConversation('conversation-1', 'Нова назва');

    expect(conversation.messages.map((message) => message.id)).toEqual([
      'request-1-user',
      'request-1-assistant',
    ]);
    expect(conversation.messages.map((message) => message.requestState)).toEqual([
      'completed',
      'completed',
    ]);
  });

  // @test-scope safeguard: prevents an inactive AI event stream from retaining a client request forever.
  it('aborts an inactive event stream after 15 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const stream = streamAiAgentEvents({
      requestId: 'request-1',
      afterSequence: 0,
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    const result = expect(stream).rejects.toThrow('Потік подій неактивний понад 15 секунд.');
    await vi.advanceTimersByTimeAsync(15_001);

    await result;
  });

  // @test-scope safeguard: prevents dispatcher saves from sending non-editable sensitive host-file settings
  it('saves only editable dispatcher fields and tests the singleton', async () => {
    const dispatcher = {
      configured: true,
      host: 'echo-ai-agent-vm.example',
      sshPort: 22031,
      sshUser: 'echo-ai-agent-staging',
      namespace: 'echo-staging',
      identityFile: '/etc/echo/ai-agent/dispatcher_ed25519',
      knownHostsFile: '/etc/echo/ai-agent/known_hosts',
      identityFilePresent: true,
      knownHostsFilePresent: true,
      lastTestedAt: null,
      lastTestError: null,
    };
    mocks.postJson.mockResolvedValue(dispatcher);

    await saveAiAgentDispatcher(dispatcher);
    await testAiAgentDispatcher();

    expect(mocks.postJson).toHaveBeenNthCalledWith(1, '/api/admin/ai-agent/dispatcher', {
      host: dispatcher.host,
      sshPort: dispatcher.sshPort,
      sshUser: dispatcher.sshUser,
      namespace: dispatcher.namespace,
    });
    expect(mocks.postJson).toHaveBeenNthCalledWith(2, '/api/admin/ai-agent/dispatcher/test', {});
  });
});
