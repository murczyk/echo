/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listEngines: vi.fn(),
  listContainers: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/ai-agent', () => ({
  getAiAgentSettings: mocks.getSettings,
  saveAiAgentSettings: mocks.saveSettings,
  listAiAgentContainers: mocks.listContainers,
  startAiAgentContainer: mocks.startContainer,
  stopAiAgentContainer: mocks.stopContainer,
}));
vi.mock('../../services/api/ai-engines', () => ({ listAiEngines: mocks.listEngines }));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../admin-ai-callsigns', () => ({ AdminAiCallsignsPage: () => null }));
vi.mock('../admin-system-settings-neo/AiEnginesSection', () => ({
  AiEnginesSection: () => null,
}));

import type { AiAgentAuditRequestDetail } from '../../services/api/ai-agent';
import { AdminAiAgentPage, RequestDetailsDialog, requestDurationSeconds } from '.';

const ENGINE = {
  id: 'engine-1',
  name: 'Gemma',
  url: 'http://vllm.example:8000/v1',
  modelName: 'gemma',
  enabled: true,
  hasToken: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const INCOMPATIBLE_ENGINE = {
  ...ENGINE,
  id: 'engine-2',
  name: 'OpenAI',
  url: 'https://api.openai.com/v1',
  modelName: 'gpt-5.6-luna',
  hasToken: true,
};

const SETTINGS = {
  enabled: false,
  defaultProviderId: ENGINE.id,
  allowedProviderIds: [ENGINE.id],
  providerRuntimeProfiles: [
    {
      aiEngineId: ENGINE.id,
      contextWindowTokens: 131_072,
      maxOutputTokens: 16_384,
      compactionReserveTokens: 32_768,
      compactionKeepRecentTokens: 16_384,
    },
  ],
  templateLoginId: '019fc7f7-9770-7f83-9c1a-211af29b02e6',
  reviewerProviderId: ENGINE.id,
  reviewEnabled: false,
  mattermostChatEnabled: false,
  mattermostWebhookConfigured: false,
  mattermostWebhookUrl: '',
  clearMattermostWebhook: false,
};

describe('requestDurationSeconds', () => {
  it('uses total elapsed request time and keeps active requests current', () => {
    expect(
      requestDurationSeconds({
        createdAt: 1_000,
        completedAt: 11_550,
        state: 'completed',
      }),
    ).toBe(10.6);
    expect(
      requestDurationSeconds({ createdAt: 1_000, completedAt: null, state: 'running' }, 6_000),
    ).toBe(5);
  });
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

function clickSave() {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Зберегти',
  );
  expect(button).toBeDefined();
  button?.click();
}

function controlLabel(text: string): HTMLLabelElement {
  const label = Array.from(container.querySelectorAll('label')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(label).toBeDefined();
  return label!;
}

beforeEach(async () => {
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
  mocks.getSettings.mockResolvedValue(SETTINGS);
  mocks.saveSettings.mockResolvedValue(SETTINGS);
  mocks.listEngines.mockResolvedValue([ENGINE]);
  mocks.listContainers.mockResolvedValue([
    {
      id: 'container-1',
      humanLoginId: 'login-1',
      humanLogin: 'alice',
      linkedLoginId: 'login-2',
      linkedLogin: 'alice-ai-agent',
      instanceName: 'echo-ai-agent-login-2',
      status: 'stopped',
      cpuCount: 2,
      memoryMib: 4096,
      storageGib: 20,
      processLimit: 512,
      lastError: null,
      lastStartedAt: null,
      lastStoppedAt: 1_700_000_000_000,
    },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AdminAiAgentPage section="settings" />));
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('AdminAiAgentPage settings', () => {
  it('saves the eligible allowlist and reports success', async () => {
    await act(async () => clickSave());
    await flush();

    expect(mocks.saveSettings).toHaveBeenCalledWith(SETTINGS);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Налаштування ШІ збережено.',
    });
  });

  it('reports settings save failures through a toast', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('preflight failed'));

    await act(async () => clickSave());
    await flush();

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося зберегти налаштування: preflight failed',
    });
  });

  it('enables Mattermost chat monitoring', async () => {
    expect(container.querySelector('input[type="url"]')).toBeNull();

    await act(async () =>
      controlLabel('Надсилати запити ШІ чату до Mattermost').querySelector('input')?.click(),
    );

    expect(container.querySelector('input[type="url"]')).not.toBeNull();

    await act(async () => clickSave());
    await flush();

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      ...SETTINGS,
      mattermostChatEnabled: true,
    });
  });

  it('places the Mattermost clear control before the chat toggle and webhook field', async () => {
    mocks.getSettings.mockResolvedValueOnce({
      ...SETTINGS,
      mattermostWebhookConfigured: true,
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AdminAiAgentPage section="settings" />));
    await flush();

    const labels = Array.from(container.querySelectorAll('label'));
    const indexOfLabel = (text: string) =>
      labels.findIndex((label) => label.textContent?.trim() === text);

    expect(indexOfLabel('Очистити налаштований Mattermost webhook')).toBeLessThan(
      indexOfLabel('Надсилати запити ШІ чату до Mattermost'),
    );
    expect(indexOfLabel('Надсилати запити ШІ чату до Mattermost')).toBeLessThan(
      indexOfLabel('Mattermost webhook'),
    );
  });

  it('selects an HTTPS token reviewer after enabling asynchronous security review', async () => {
    const settings = {
      ...SETTINGS,
      reviewerProviderId: null,
      reviewEnabled: false,
    };
    mocks.getSettings.mockResolvedValueOnce(settings);
    mocks.listEngines.mockResolvedValueOnce([ENGINE, INCOMPATIBLE_ENGINE]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AdminAiAgentPage section="settings" />));
    await flush();

    await act(async () =>
      controlLabel('Асинхронна безпекова перевірка').querySelector('input')?.click(),
    );
    const reviewerSelect = container.querySelector(
      '[aria-labelledby="ai-agent-reviewer-provider-label"]',
    );
    expect(reviewerSelect).not.toBeNull();
    await act(async () =>
      reviewerSelect?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    await flush();
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((candidate) =>
      candidate.textContent?.includes(INCOMPATIBLE_ENGINE.name),
    );
    expect(option).toBeDefined();
    await act(async () => (option as HTMLElement | undefined)?.click());
    await act(async () => clickSave());
    await flush();

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      ...settings,
      reviewerProviderId: INCOMPATIBLE_ENGINE.id,
      reviewEnabled: true,
    });
  });

  it('preserves incompatible provider settings instead of filtering them out', async () => {
    const incompatibleSettings = {
      ...SETTINGS,
      defaultProviderId: INCOMPATIBLE_ENGINE.id,
      allowedProviderIds: [INCOMPATIBLE_ENGINE.id],
      providerRuntimeProfiles: [
        {
          aiEngineId: INCOMPATIBLE_ENGINE.id,
          contextWindowTokens: 1_050_000,
          maxOutputTokens: 32_768,
          compactionReserveTokens: 65_536,
          compactionKeepRecentTokens: 32_768,
        },
      ],
      reviewerProviderId: INCOMPATIBLE_ENGINE.id,
    };
    mocks.getSettings.mockResolvedValueOnce(incompatibleSettings);
    mocks.listEngines.mockResolvedValueOnce([ENGINE, INCOMPATIBLE_ENGINE]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AdminAiAgentPage section="settings" />));
    await flush();
    await act(async () => clickSave());
    await flush();

    expect(mocks.saveSettings).toHaveBeenCalledWith(incompatibleSettings);
  });
});

describe('RequestDetailsDialog', () => {
  it('shows stored technical details only when the request has an error', async () => {
    const request: AiAgentAuditRequestDetail = {
      id: 'request-1',
      humanLoginId: 'human-1',
      humanLogin: 'alice',
      conversationId: 'conversation-1',
      providerName: 'OpenAI',
      state: 'failed',
      prompt: 'сивый позивний',
      response: null,
      error: 'AI agent harness release is incompatible',
      progress: [],
      toolActivity: [],
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
      completedAt: 1_700_000_002_000,
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
        id: 'conversation-1',
        title: 'Контекст',
        providerId: 'engine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_002_000,
        messages: [],
      },
    };

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <RequestDetailsDialog request={request} onClose={vi.fn()} onReviewRetried={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain('Технічні деталі помилки');
    expect(document.body.textContent).toContain('AI agent harness release is incompatible');

    await act(async () =>
      root.render(
        <RequestDetailsDialog
          request={{ ...request, error: null }}
          onClose={vi.fn()}
          onReviewRetried={vi.fn()}
        />,
      ),
    );

    expect(document.body.textContent).not.toContain('Технічні деталі помилки');
  });
});

describe('AdminAiAgentPage containers', () => {
  it('renders containers in the standard table with the action column first', async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AdminAiAgentPage section="containers" />));
    await flush();
    await flush();

    expect(container.querySelector('table')).not.toBeNull();
    expect(mocks.listContainers).toHaveBeenCalledOnce();
    const headers = Array.from(container.querySelectorAll('thead th')).map((header) =>
      header.textContent?.trim(),
    );
    expect(headers.findIndex((header) => header === 'Дії')).toBeLessThan(
      headers.findIndex((header) => header?.startsWith('Користувач')),
    );
  });
});
