/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  conversations: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../services/api/ai-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/ai-agent')>()),
  getAiAgentConfiguration: mocks.configuration,
  listAiAgentConversations: mocks.conversations,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AiAgentChat } from '../.';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('AiAgentChat feature flag', () => {
  it('does not call protected chat APIs while the feature is disabled', async () => {
    mocks.configuration.mockResolvedValue({
      enabled: false,
      defaultProviderId: null,
      providers: [],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAvailabilityChange = vi.fn();

    await act(async () => root.render(<AiAgentChat onAvailabilityChange={onAvailabilityChange} />));
    await act(async () => Promise.resolve());

    expect(onAvailabilityChange).toHaveBeenCalledWith('disabled');
    expect(mocks.conversations).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
    await act(async () => root.unmount());
  });
});
