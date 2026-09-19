/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upsertMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api/organism-keyword-sets', () => ({
  upsertOrganismKeywordSet: upsertMock,
  deleteOrganismKeywordSet: vi.fn(),
  suggestNewKeywordSetName: vi.fn(),
}));

import { useOrganismKeywordSetsEditor } from '../useOrganismKeywordSetsEditor';

const selected = { id: 4, name: 'Alpha', words: ['a'], canEdit: true, canDelete: true };

function Harness({
  onReady,
  reload,
}: {
  onReady: (value: ReturnType<typeof useOrganismKeywordSetsEditor>) => void;
  reload: () => Promise<void>;
}) {
  const value = useOrganismKeywordSetsEditor([selected], reload);
  useEffect(() => {
    onReady(value);
  }, [onReady, value]);
  return null;
}

async function renderHook(reload: () => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let current!: ReturnType<typeof useOrganismKeywordSetsEditor>;
  await act(async () =>
    root.render(<Harness onReady={(value) => (current = value)} reload={reload} />),
  );
  await act(async () => Promise.resolve());
  return {
    root,
    get current() {
      return current;
    },
  };
}
describe('useOrganismKeywordSetsEditor save behavior', () => {
  beforeEach(() => upsertMock.mockReset());
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('awaits keyword reload before resolving with the saved ID', async () => {
    upsertMock.mockResolvedValue({ ...selected, name: 'Updated' });
    let resolveReload!: () => void;
    const reload = vi.fn(() => new Promise<void>((resolve) => (resolveReload = resolve)));
    const view = await renderHook(reload);
    let result!: number | null | undefined;
    await act(async () => {
      const promise = view.current.handleSave();
      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
      result = undefined;
      promise.then((value) => (result = value));
    });
    expect(result).toBeUndefined();
    resolveReload();
    await act(async () => Promise.resolve());
    expect(result).toBe(4);
    expect(upsertMock).toHaveBeenCalledWith({ id: 4, name: 'Alpha', words: ['a'] });
    await act(async () => view.root.unmount());
  });

  it('exposes the renamed error-clearing API without success state', async () => {
    const view = await renderHook(vi.fn().mockResolvedValue(undefined));
    expect(typeof view.current.clearSaveError).toBe('function');
    expect('saveSuccess' in view.current).toBe(false);
    expect('clearSaveFeedback' in view.current).toBe(false);
    await act(async () => view.root.unmount());
  });
});
