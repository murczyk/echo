/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupFeedState } from '../../../../../../Bindings';
import { createGroupFeedStateStore } from '../group-feed-state-store';
import { useGroupFeedNavigation } from '../useGroupFeedNavigation';

const serverGroup: GroupFeedState = {
  masterKey: 'g-1',
  name: 'Група 1',
  colorKey: 'blue',
  ignoreOperativny: false,
  unreadCount: 4,
  oldestUnreadMessageRef: null,
  lastReadCreatedAtOrder: null,
  lastReadMessageId: null,
  lastActivityAt: null,
  latestCursor: null,
};

function Harness({
  allUnreadCount,
  store,
  onModel,
}: {
  allUnreadCount: number;
  store: ReturnType<typeof createGroupFeedStateStore>;
  onModel: (model: ReturnType<typeof useGroupFeedNavigation>) => void;
}) {
  const model = useGroupFeedNavigation({
    enabled: true,
    scope: { kind: 'all' },
    allUnreadCount,
    onSelect: vi.fn(),
    onError: vi.fn(),
    store,
  });
  onModel(model);
  return null;
}

describe('useGroupFeedNavigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps all-groups unread supplied by the owning feed', async () => {
    const store = createGroupFeedStateStore({ fetchStates: async () => [serverGroup] });
    let firstModel: ReturnType<typeof useGroupFeedNavigation> | null = null;
    let secondModel: ReturnType<typeof useGroupFeedNavigation> | null = null;

    await act(async () => {
      root.render(
        <>
          <Harness allUnreadCount={2} store={store} onModel={(model) => (firstModel = model)} />
          <Harness allUnreadCount={9} store={store} onModel={(model) => (secondModel = model)} />
        </>,
      );
    });

    expect(firstModel!.groups[0]).toMatchObject({ kind: 'all', unreadCount: 2 });
    expect(secondModel!.groups[0]).toMatchObject({ kind: 'all', unreadCount: 9 });
    expect(firstModel!.groups[1]).toMatchObject({ kind: 'group', unreadCount: 4 });
  });

  it('resolves a selected group once while the group list is hidden', async () => {
    const fetchStates = vi.fn(async () => [serverGroup]);
    const store = createGroupFeedStateStore({ fetchStates });
    let model: ReturnType<typeof useGroupFeedNavigation> | null = null;

    function ScopedHarness() {
      model = useGroupFeedNavigation({
        enabled: false,
        resolveSelectedGroupWhenHidden: true,
        scope: { kind: 'group', masterKey: serverGroup.masterKey },
        onSelect: vi.fn(),
        onError: vi.fn(),
        store,
      });
      return null;
    }

    await act(async () => {
      root.render(<ScopedHarness />);
      await Promise.resolve();
    });

    expect(fetchStates).toHaveBeenCalledTimes(1);
    expect(model!.selectedGroup.name).toBe(serverGroup.name);

    await act(async () => {
      store.invalidate();
      await Promise.resolve();
    });
    expect(fetchStates).toHaveBeenCalledTimes(1);
  });
});
