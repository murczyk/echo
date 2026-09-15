/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedFilterPanelProps } from './FeedFilterPanel';
import type { SignalGroupEntry } from '../../../../Bindings';

const selectionSpy = vi.hoisted(() => vi.fn());

vi.mock('./FeedFilterSelectionSection', () => ({
  FeedFilterSelectionSection: (props: { title: string }) => {
    selectionSpy(props);
    return <div data-testid={`selection-${props.title}`} />;
  },
}));

vi.mock('../../components/SavedFiltersControl', () => ({
  SavedFiltersControl: () => <div data-testid="saved-filters-control" />,
}));

import { FeedFilterPanel } from './FeedFilterPanel';

function buildGroupInfo(masterKey: string, name: string): SignalGroupEntry {
  return {
    masterKey,
    name,
    ignoreOperativny: false,
    interseptionKind: 'rer',
    disableNetworkAssignment: false,
    groupStats: { activityLastDay: 0, activityLastWeek: 0 },
    adminData: null,
    areasOfResponsibility: null,
  };
}

function buildProps(overrides: Partial<FeedFilterPanelProps['panel']> = {}): FeedFilterPanelProps {
  return {
    panel: {
      feedId: 'mf-0',
      hasActiveFilter: false,
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
        onGroupsModeTransfer: vi.fn(),
        onSendersChange: vi.fn(),
        onDeniedSendersChange: vi.fn(),
        onSendersModeTransfer: vi.fn(),
        onFreqsChange: vi.fn(),
        onFreqsDeniedChange: vi.fn(),
        onFreqsModeTransfer: vi.fn(),
        onPostsChange: vi.fn(),
        onPostsDeniedChange: vi.fn(),
        onPostsModeTransfer: vi.fn(),
        onUnitsModeTransfer: vi.fn(),
        onAdjacentFreqsRangeChange: vi.fn(),
        onHighlightSignalsChange: vi.fn(),
        onOnlyMyUnitTagsChange: vi.fn(),
        onReloadFreqs: vi.fn(),
        onReloadGroupCatalog: vi.fn(),
        onSavedFilterSelect: vi.fn(),
        onSaveFilterNameChange: vi.fn(),
        onSaveFilter: vi.fn(async () => true),
        onUpdateSelectedSavedFilter: vi.fn(async () => {}),
        onRenameSelectedSavedFilter: vi.fn(async () => true),
        onDeleteSelectedSavedFilter: vi.fn(async () => {}),
        onApplySavedFilter: vi.fn(),
        onDiscardCurrentFilter: vi.fn(),
      },
      ...overrides,
    },
  };
}

describe('FeedFilterPanel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    selectionSpy.mockClear();
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

  it('uses newline-only bulk paste for posts and units', async () => {
    await act(async () => {
      root.render(<FeedFilterPanel {...buildProps()} />);
    });

    const selectionProps = selectionSpy.mock.calls.map(
      ([value]) => value as { title: string; bulkPasteSeparators?: string[] },
    );

    expect(selectionProps.find((value) => value.title === 'Пост')?.bulkPasteSeparators).toEqual([
      '\n',
    ]);
    expect(
      selectionProps.find((value) => value.title === 'Підрозділи')?.bulkPasteSeparators,
    ).toEqual(['\n']);
  });

  it('discards the current filter from the filter panel', async () => {
    const onDiscardCurrentFilter = vi.fn();
    await act(async () => {
      root.render(
        <FeedFilterPanel
          {...buildProps({
            hasActiveFilter: true,
            actions: { ...buildProps().panel.actions, onDiscardCurrentFilter },
          })}
        />,
      );
    });

    const discardButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Скинути поточний фільтр',
    );
    expect(discardButton?.disabled).toBe(false);

    act(() => discardButton?.click());
    expect(onDiscardCurrentFilter).toHaveBeenCalledOnce();
  });

  it('keeps catalog errors persistent and maps their structured severity', async () => {
    vi.useFakeTimers();
    const onReloadGroupCatalog = vi.fn();
    const props = buildProps({
      toggles: {
        ...buildProps().panel.toggles,
        groupCatalogError: { kind: 'catalog', message: 'catalog failed' },
      },
      actions: { ...buildProps().panel.actions, onReloadGroupCatalog },
    });
    await act(async () => root.render(<FeedFilterPanel {...props} />));

    const alert = container.querySelector('.MuiAlert-root');
    expect(alert?.getAttribute('class')).toContain('MuiAlert-standardError');
    expect(alert?.textContent).toContain('Не вдалося завантажити повний список груп');
    expect(alert?.textContent).toContain('Повторити');
    expect(alert?.querySelector('button[aria-label="Close"]')).toBeNull();

    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('.MuiAlert-root')).not.toBeNull();
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Повторити',
    );
    expect(retry).toBeDefined();
    if (retry) {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(onReloadGroupCatalog).toHaveBeenCalledTimes(1);

    await act(async () =>
      root.render(
        <FeedFilterPanel
          {...buildProps({
            toggles: {
              ...buildProps().panel.toggles,
              groupCatalogLoading: true,
              groupCatalogError: { kind: 'details', message: 'details failed' },
            },
            actions: { ...buildProps().panel.actions, onReloadGroupCatalog },
          })}
        />,
      ),
    );
    const detailsAlert = container.querySelector('.MuiAlert-root');
    expect(detailsAlert?.getAttribute('class')).toContain('MuiAlert-standardWarning');
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Повторити',
      )?.disabled,
    ).toBe(true);

    await act(async () => root.render(<FeedFilterPanel {...buildProps()} />));
    expect(container.querySelector('.MuiAlert-root')).toBeNull();
    vi.useRealTimers();
  });

  it('selects multiple groups without reloading the catalog', async () => {
    const onGroupsChange = vi.fn();
    const onReloadGroupCatalog = vi.fn();
    const props = buildProps({
      sources: {
        ...buildProps().panel.sources,
        groupsList: ['A', 'B', 'C'],
        groupInfos: {},
      },
      actions: {
        ...buildProps().panel.actions,
        onGroupsChange,
        onReloadGroupCatalog,
      },
    });
    await act(async () => root.render(<FeedFilterPanel {...props} />));

    const groupProps = selectionSpy.mock.calls
      .map(
        ([value]) =>
          value as {
            title: string;
            options: string[];
            onValueChange: (value: string[]) => void;
            keepOpenOnSelect?: boolean;
            preserveInputOnSelect?: boolean;
          },
      )
      .find((value) => value.title === 'Групи');
    expect(groupProps).toBeDefined();
    expect(groupProps?.options).toEqual(['A', 'B', 'C']);
    expect(groupProps?.keepOpenOnSelect).toBe(true);
    expect(groupProps?.preserveInputOnSelect).toBe(false);

    act(() => groupProps?.onValueChange(['A']));
    act(() => groupProps?.onValueChange(['A', 'B']));
    expect(onGroupsChange).toHaveBeenNthCalledWith(1, ['A']);
    expect(onGroupsChange).toHaveBeenNthCalledWith(2, ['A', 'B']);
    expect(onReloadGroupCatalog).not.toHaveBeenCalled();
  });
});
