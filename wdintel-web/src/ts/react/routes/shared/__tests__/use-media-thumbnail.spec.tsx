/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMediaThumbnail } from '../use-media-thumbnail';

vi.mock('../../../auth-redirect', () => ({
  AUTH_UNAUTHORIZED_EVENT: 'echo:api-unauthorized',
  emitUnauthorizedEvent: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it('#3930 prevents callbacks from a previous thumbnail from loading or failing the replacement', async () => {
  let finishReplacement!: (response: Response) => void;
  const response = () =>
    ({
      status: 200,
      blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    }) as Response;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReplacement = resolve;
          }),
      ),
  );
  let sequence = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:thumbnail-${++sequence}`);
      static revokeObjectURL = vi.fn();
    },
  );
  let current!: ReturnType<typeof useMediaThumbnail>;
  function Harness({ source }: { source: string }) {
    current = useMediaThumbnail(source, true);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness source="/thumbnail/revision-1" />));
    const old = current;
    expect(old.imageSrc).toBe('blob:thumbnail-1');
    await act(async () => root.render(<Harness source="/thumbnail/revision-2" />));
    expect(current.imageSrc).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-1');
    await act(async () => {
      old.markLoaded();
      old.markFailed();
    });
    expect(current.state).toBe('loading');
    await act(async () => finishReplacement(response()));
    await act(async () => {
      old.markLoaded();
      old.markFailed();
    });
    expect(current.imageSrc).toBe('blob:thumbnail-2');
    expect(current.state).toBe('loading');
    await act(async () => current.markLoaded());
    expect(current.state).toBe('loaded');
  } finally {
    act(() => root.unmount());
  }
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-2');
});
