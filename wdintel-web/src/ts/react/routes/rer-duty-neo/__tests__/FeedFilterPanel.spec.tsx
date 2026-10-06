/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedFilterPanelProps } from '.././FeedFilterPanel';
import type { SignalGroupEntry } from '../../../../../Bindings';

const selectionSpy = vi.hoisted(() => vi.fn());
const radioFeatures = vi.hoisted(() => ({ allowed: true }));

vi.mock('../../shared/RadioFeatures', () => ({ useRadioFeatures: () => radioFeatures.allowed }));

vi.mock('.././FeedFilterSelectionSection', () => ({
  FeedFilterSelectionSection: (props: { title: string }) => {
    selectionSpy(props);
    return <div data-testid={`selection-${props.title}`} />;
  },
}));

vi.mock('../../../components/SavedFiltersControl', () => ({
  SavedFiltersControl: () => <div data-testid="saved-filters-control" />,
}));

import { FeedFilterPanel } from '.././FeedFilterPanel';

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
    radioFeatures.allowed = true;
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

  type LocationSectionProps = {
    title: string;
    mode: 'include' | 'exclude';
    value: string[];
    options: string[];
    placeholder?: string;
    bulkPasteSeparators?: string[];
    bulkPasteMenuLabel?: string;
    bulkCopyMenuLabel?: string;
    loading?: boolean;
    getOptionLabel: (option: string) => string;
    onModeChange: (mode: 'include' | 'exclude') => void;
    onInputChange?: (value: string) => void;
    onOpen?: () => void;
    resolveBulkPasteOptions?: (tokens: readonly string[]) => Promise<readonly string[]>;
  };

  function latestSectionProps(title: string): LocationSectionProps | undefined {
    return selectionSpy.mock.calls
      .map(([value]) => value as LocationSectionProps)
      .filter((value) => value.title === title)
      .at(-1);
  }

  function sectionTitles(): string[] {
    const titles = selectionSpy.mock.calls.map(([value]) => (value as { title: string }).title);
    return [...new Set(titles)];
  }

  function buildLocationProps(
    filterState: Partial<FeedFilterPanelProps['panel']['filterState']> = {},
    actions: Partial<FeedFilterPanelProps['panel']['actions']> = {},
  ): FeedFilterPanelProps {
    const base = buildProps().panel;
    return buildProps({
      filterState: { ...base.filterState, ...filterState },
      sources: { ...base.sources, locationsList: ['', 'КИЇВ'] },
      actions: { ...base.actions, ...actions },
    });
  }

  function pelengCheckbox(): HTMLInputElement | null {
    const label = Array.from(container.querySelectorAll('label')).find((node) =>
      node.textContent?.includes('Включати пеленг-локації'),
    );
    return label?.querySelector('input[type="checkbox"]') ?? null;
  }

  it('renders the locations section between posts and units', async () => {
    await act(async () => root.render(<FeedFilterPanel {...buildLocationProps()} />));

    const titles = sectionTitles();
    expect(titles.indexOf('Локації')).toBe(titles.indexOf('Пост') + 1);
    expect(titles.indexOf('Підрозділи')).toBe(titles.indexOf('Локації') + 1);
    const locations = latestSectionProps('Локації');
    expect(locations?.options).toEqual(['', 'КИЇВ']);
    expect(locations?.getOptionLabel('')).toBe('<Не вказано>');
    expect(locations?.placeholder).toBe('всі');
    expect(locations?.bulkPasteSeparators).toEqual(['\n']);
    expect(locations?.bulkPasteMenuLabel).toBe('Додати кілька локацій');
    expect(locations?.bulkCopyMenuLabel).toBe('Копіювати обрані локації');
  });

  it('keeps the locations section without radio features', async () => {
    radioFeatures.allowed = false;
    await act(async () => root.render(<FeedFilterPanel {...buildLocationProps()} />));

    expect(sectionTitles()).not.toContain('Пост');
    expect(sectionTitles()).toContain('Локації');
  });

  it('merges saved and typed locations into the options', async () => {
    await act(async () =>
      root.render(
        <FeedFilterPanel
          {...buildLocationProps({ locationsSelected: ['ЛЬВІВ'], locationsDenied: [] })}
        />,
      ),
    );
    expect(latestSectionProps('Локації')?.options).toEqual(['', 'КИЇВ', 'ЛЬВІВ']);

    act(() => latestSectionProps('Локації')?.onInputChange?.('  одеса '));
    expect(latestSectionProps('Локації')?.options).toEqual(['', 'КИЇВ', 'ЛЬВІВ', 'ОДЕСА']);
  });

  it('resolves bulk-pasted locations as normalized free-entry values', async () => {
    await act(async () => root.render(<FeedFilterPanel {...buildLocationProps()} />));

    const resolved = await latestSectionProps('Локації')?.resolveBulkPasteOptions?.([
      ' харків ',
      '<не вказано>',
    ]);
    expect(resolved).toEqual(['ХАРКІВ', '']);
  });

  it('moves location values between include and exclude modes', async () => {
    const onLocationsModeTransfer = vi.fn();
    await act(async () =>
      root.render(
        <FeedFilterPanel
          {...buildLocationProps({ locationsSelected: ['КИЇВ'] }, { onLocationsModeTransfer })}
        />,
      ),
    );
    expect(latestSectionProps('Локації')?.mode).toBe('include');

    act(() => latestSectionProps('Локації')?.onModeChange('exclude'));
    expect(onLocationsModeTransfer).toHaveBeenCalledWith({
      includeValues: [],
      excludeValues: ['КИЇВ'],
    });
    expect(latestSectionProps('Локації')?.mode).toBe('exclude');
  });

  it('starts in exclude mode for denied locations', async () => {
    await act(async () =>
      root.render(<FeedFilterPanel {...buildLocationProps({ locationsDenied: ['КИЇВ'] })} />),
    );
    expect(latestSectionProps('Локації')?.mode).toBe('exclude');
    expect(latestSectionProps('Локації')?.value).toEqual(['КИЇВ']);
  });

  it('uses the exclude placeholder for an empty exclude mode', async () => {
    await act(async () => root.render(<FeedFilterPanel {...buildLocationProps()} />));
    act(() => latestSectionProps('Локації')?.onModeChange('exclude'));
    expect(latestSectionProps('Локації')?.placeholder).toBe('жодна');
  });

  it('hides the peleng checkbox without selected or denied locations', async () => {
    await act(async () => root.render(<FeedFilterPanel {...buildLocationProps()} />));
    expect(pelengCheckbox()).toBeNull();
  });

  it('hides the peleng checkbox without radio features', async () => {
    radioFeatures.allowed = false;
    await act(async () =>
      root.render(<FeedFilterPanel {...buildLocationProps({ locationsSelected: ['КИЇВ'] })} />),
    );
    expect(pelengCheckbox()).toBeNull();
  });

  it.each([
    ['selected', { locationsSelected: ['КИЇВ'] }],
    ['denied', { locationsDenied: ['КИЇВ'] }],
  ])('shows an unchecked peleng checkbox for %s locations', async (_label, filterState) => {
    const onIncludePelengLocationsChange = vi.fn();
    await act(async () =>
      root.render(
        <FeedFilterPanel
          {...buildLocationProps(filterState, { onIncludePelengLocationsChange })}
        />,
      ),
    );

    const checkbox = pelengCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    act(() => checkbox?.click());
    expect(onIncludePelengLocationsChange).toHaveBeenCalledWith(true);
  });

  it('loads locations when the field is opened', async () => {
    const onLoadLocations = vi.fn();
    await act(async () =>
      root.render(<FeedFilterPanel {...buildLocationProps({}, { onLoadLocations })} />),
    );
    expect(onLoadLocations).not.toHaveBeenCalled();

    act(() => latestSectionProps('Локації')?.onOpen?.());
    act(() => latestSectionProps('Локації')?.onOpen?.());
    expect(onLoadLocations).toHaveBeenCalledTimes(2);
  });
});
