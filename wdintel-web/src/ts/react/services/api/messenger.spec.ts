import { describe, expect, it, vi } from 'vitest';

import { postJson } from './client';
import { getSystemServiceNameAvailability } from './messenger';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

describe('messenger API', () => {
  it('normalizes the system service name availability response', async () => {
    const abortController = new AbortController();
    postJsonMock.mockResolvedValueOnce({
      system_service_name: 'echo-kherson-2',
      exists: true,
    });

    const rsp = await getSystemServiceNameAvailability(
      {
        messenger: 'signal',
        systemServiceName: 'echo-kherson',
      },
      abortController.signal,
    );

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/messenger/system-service-name-availability',
      {
        messenger: 'signal',
        system_service_name: 'echo-kherson',
      },
      { signal: abortController.signal },
    );
    expect(rsp).toEqual({
      systemServiceName: 'echo-kherson-2',
      exists: true,
    });
  });
});
