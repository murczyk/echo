/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedFilterPanelProps } from './FeedFilterPanel';
import type { SignalGroupEntry } from '../../../../Bindings';

vi.mock('../../components/SavedFiltersControl', () => ({
  SavedFiltersControl: () => <div data-testid="saved-filters-control" />,
}));

import { FeedFilterPanel } from './FeedFilterPanel';

function buildGroupInfo(masterKey: string, name: string): SignalGroupEntry {
  return {
    masterKey,
    name,
    ignoreOperativny: false,
    groupStats: { activityLastDay: 0, activityLastWeek: 0 },
    adminData: null,
    areasOfResponsibility: null,
  };
}

function buildProps(overrides: Partial<FeedFilterPanelProps['panel']> = {}): FeedFilterPanelProps {
  return {
    panel: {
      feedId: 'mf-0',
      filterState: {
        groupsSelected: [],
        deniedGroups: [],
        sendersSelected: [],
        deniedSenders: [],
        freqsSelected: [],
        freqsDenied: [],
        postsSelected: [],
        postsDenied: [],
      },
      sources: {
        groupsList: ['group-1'],
        groupInfos: { 'group-1': buildGroupInfo('group-1', 'Група 1') },
        profiles: {},
        senderOptions: [{ id: 'sender-1', label: 'Sender 1' }],
        freqs: ['100.000'],
        postsList: ['post-1'],
      },
      toggles: {
        adjacentFreqsRange: 0,
        highlightSignalsEnabled: false,
        onlyMyUnitTagsEnabled: false,
        reloadFreqsLoading: false,
      },
      savedFilters: {
        savedFilters: [],
        selectedSavedId: null,
        saveFilterName: '',
      },
      actions: {
        onGroupsChange: vi.fn(),
        onDeniedGroupsChange: vi.fn(),
        onSendersChange: vi.fn(),
        onDeniedSendersChange: vi.fn(),
        onFreqsChange: vi.fn(),
        onFreqsDeniedChange: vi.fn(),
        onPostsChange: vi.fn(),
        onPostsDeniedChange: vi.fn(),
        onAdjacentFreqsRangeChange: vi.fn(),
        onHighlightSignalsChange: vi.fn(),
        onOnlyMyUnitTagsChange: vi.fn(),
        onReloadFreqs: vi.fn(),
        onSavedFilterSelect: vi.fn(),
        onSaveFilterNameChange: vi.fn(),
        onSaveFilter: vi.fn(async () => true),
        onUpdateSelectedSavedFilter: vi.fn(async () => {}),
        onRenameSelectedSavedFilter: vi.fn(async () => true),
        onDeleteSelectedSavedFilter: vi.fn(async () => {}),
        onApplySavedFilter: vi.fn(),
      },
      ...overrides,
    },
  };
}

describe('FeedFilterPanel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('fills the parent height and keeps the internal scroll area scrollable', async () => {
    await act(async () => {
      root.render(<FeedFilterPanel {...buildProps()} />);
    });

    const panel = container.querySelector('[aria-label="Панель фільтрів"]');
    expect(panel).not.toBeNull();

    const scrollArea = panel?.firstElementChild as HTMLElement | null;
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.style.width).toBe('100%');
    expect(scrollArea?.style.height).toBe('auto');
    expect(scrollArea?.style.maxHeight).toBe('100%');
    expect(scrollArea?.style.overflowY).toBe('auto');
    expect(scrollArea?.style.overflowX).toBe('hidden');
  });
});
