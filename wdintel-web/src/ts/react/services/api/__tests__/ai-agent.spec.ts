/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  postBytes: vi.fn(),
  postVoid: vi.fn(),
}));

vi.mock('../client', () => ({
  getJson: mocks.getJson,
  postJson: mocks.postJson,
  postBytes: mocks.postBytes,
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
  normalizeAiAgentEvent,
  getAiAgentConfiguration,
  getAiAgentMap,
  downloadAiAgentMap,
} from '../ai-agent';

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AI agent API mapping', () => {
  it('#4112 keeps engine health and model-failure reasons', async () => {
    mocks.getJson.mockResolvedValue({
      featureEnabled: true,
      reasoningPresetsEnabled: false,
      defaultAiEngineId: 'glm',
      providers: [
        {
          id: 'glm',
          name: 'GLM-5.3',
          modelName: 'glm-5.3',
          unhealthy: true,
          healthMessage: 'Шлюз',
        },
        { id: 'flash', name: 'Flash', modelName: 'flash' },
      ],
    });
    const configuration = await getAiAgentConfiguration();
    expect(configuration.providers.map((item) => [item.unhealthy, item.healthMessage])).toEqual([
      [true, 'Шлюз'],
      [false, null],
    ]);
    const event = normalizeAiAgentEvent(
      {
        sequence: 2,
        eventType: 'completion_metadata',
        createdAt: 1,
        payloadJson: JSON.stringify({ coverageLimited: false, reason: 'model_refusal' }),
      },
      'request-1',
    );
    expect(event.completionMetadata).toEqual({ coverageLimited: false, reason: 'model_refusal' });
  });

  it('#3064 exposes map summaries in replay and retrieves/downloads with the request identity', async () => {
    const summary = {
      id: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-1',
      title: 'Події',
      isMain: true,
      totalCount: 2,
      validCount: 1,
      invalidCount: 1,
      warnings: ['Рядок 2: INVALID'],
    };
    const event = normalizeAiAgentEvent(
      {
        sequence: 1,
        eventType: 'map_artifact',
        createdAt: 1,
        payloadJson: JSON.stringify({
          document: { ...summary, records: [{ name: 'Private record' }] },
        }),
      },
      'request-1',
    );
    expect(event.map).toEqual(summary);
    expect(event.map).not.toHaveProperty('records');
    const signal = new AbortController().signal;
    mocks.postJson.mockResolvedValue({ ...summary, records: [] });
    await getAiAgentMap(summary, signal);
    expect(mocks.postJson).toHaveBeenCalledWith(
      '/api/ai-agent/maps/get',
      { requestId: summary.requestId, mapId: summary.id, revision: null },
      { signal },
    );
    const blob = new Blob(['CSV'], { type: 'text/csv' });
    mocks.postBytes.mockResolvedValue(blob);
    await expect(downloadAiAgentMap(summary, 'csv')).resolves.toBe(blob);
    const icons = [{ sidc: '10031000001211020000', pngBase64: 'iVBORw0KGgo=' }];
    await downloadAiAgentMap(summary, 'kmz', icons);
    expect(mocks.postBytes).toHaveBeenCalledWith('/api/ai-agent/maps/csv', {
      requestId: summary.requestId,
      mapId: summary.id,
      revision: null,
    });
    expect(mocks.postBytes).toHaveBeenCalledWith('/api/ai-agent/maps/kmz', {
      requestId: summary.requestId,
      mapId: summary.id,
      revision: null,
      icons,
    });
  });
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
      refusalRewriteEnabled: true,
      refusalRewriteAiEngineId: 'rewrite-engine',
      mattermostChatEnabled: false,
      hasMattermostWebhook: false,
      hasMattermostChatWebhook: false,
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
      refusalRewriteEnabled: true,
      refusalRewriteAiEngineId: 'rewrite-engine',
      mattermostChatEnabled: false,
      mattermostWebhookUrl: null,
      clearMattermostWebhook: false,
      mattermostChatWebhookUrl: null,
      clearMattermostChatWebhook: false,
    });
  });
  it('returns the authoritative state from cancellation', async () => {
    mocks.postJson.mockResolvedValue({ state: 'completed' });

    await expect(cancelAiAgentRequest('request-1')).resolves.toBe('completed');
    expect(mocks.postJson).toHaveBeenCalledWith('/api/ai-agent/requests/cancel', {
      requestId: 'request-1',
    });
  });
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
    expect(conversation.messages.every((message) => message.maps.length === 0)).toBe(true);
    expect(conversation.messages.map((message) => message.requestState)).toEqual([
      'completed',
      'completed',
    ]);
  });
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
