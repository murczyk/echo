/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedFilter, SignalGroupEntry } from '../../../../../Bindings';
import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { emptyQueryState } from '../helpers';

const analysisFilterFieldSpy = vi.fn();
const accordionSpy = vi.fn();
const powerChipSpy = vi.fn();

function uniqueInOrder(values: string[]): string[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

vi.mock('@mui/material', () => ({
  Accordion: (props: { children: ReactNode; onChange?: (event: unknown, nextExpanded: boolean) => void }) => {
    accordionSpy(props);
    return <div>{props.children}</div>;
  },
  AccordionDetails: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionSummary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Checkbox: (props: { checked?: boolean; onChange?: (_event: Event, checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.nativeEvent, event.currentTarget.checked)}
    />
  ),
  CircularProgress: () => <span data-testid="spinner" />,
  Divider: () => <hr />,
  FormControl: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormControlLabel: (props: { control: ReactNode; label: ReactNode }) => (
    <label>
      {props.control}
      <span>{props.label}</span>
    </label>
  ),
  InputAdornment: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  InputLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
  Paper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: (props: {
    children: ReactNode;
    value: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <select value={props.value} onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}>
      {props.children}
    </select>
  ),
  ToggleButtonGroup: ({
    children,
    onChange,
  }: {
    children: ReactNode;
    onChange?: (_event: unknown, value: string | null) => void;
  }) => (
    <div data-testid="toggle-button-group">
      {children}
      {void (toggleButtonGroupOnChange = onChange)}
    </div>
  ),
  ToggleButton: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" onClick={() => toggleButtonGroupOnChange?.(null, value)}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: (props: { checked?: boolean; onChange?: (_event: Event, checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.nativeEvent, event.currentTarget.checked)}
    />
  ),
  TextField: (props: { label?: string; value?: string; onChange?: (event: { target: { value: string } }) => void; type?: string }) => (
    <label>
      <span>{props.label}</span>
      <input type={props.type ?? 'text'} value={props.value ?? ''} onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })} />
    </label>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMediaQuery: () => false,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/Search', () => ({
  default: () => <span>search</span>,
}));

vi.mock('@mui/icons-material/ExpandMore', () => ({
  default: () => <span>expand</span>,
}));

vi.mock('./AnalysisFilterField', () => ({
  AnalysisFilterField: (props: unknown) => {
    analysisFilterFieldSpy(props);
    return <div data-testid={`filter-${String((props as { label?: string }).label ?? 'unknown')}`} />;
  },
}));

vi.mock('./AnalysisSavedFiltersCard', () => ({
  AnalysisSavedFiltersCard: () => <div data-testid="saved-filters-card" />,
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: (props: { label: ReactNode; onDelete?: () => void }) => {
    powerChipSpy(props);
    return (
      <button type="button" data-testid="saved-filter-chip">
        {props.label}
      </button>
    );
  },
}));

import { AnalysisFiltersPanel } from './AnalysisFiltersPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

let toggleButtonGroupOnChange: ((_event: unknown, value: string | null) => void) | undefined;

function buildOptions(): AnalysisPageState['options'] {
  const option = (value: string, label: string, count = 1) => ({ value, label, count });
  return {
    tags: [],
    aors: [option('1', '1')],
    groups: [],
    senders: [],
    freqs: [option('100.0000', '100.0000')],
    newFreqs: [option('100.0000', '100.0000')],
    callsigns: [],
    units: [],
    locations: [],
    posts: [],
    networks: [option('12', '12')],
    metadataCcs: [],
    metadataSenders: [],
    metadataReceivers: [],
    metadataHashes: [],
  };
}

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

function buildNetwork(id: number, name: string): AnalysisPageState['networks'][number] {
  return {
    id,
    freqs: [],
    unitIds: [1, 2],
    aorIds: [],
    name,
    location: 'KYIV',
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'NetworkActive',
  };
}

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisFiltersPanel>['page']> = {}): ComponentProps<typeof AnalysisFiltersPanel> {
  return {
    page: {
      isDirty: false,
      canResetFilters: false,
      counts: null,
      aorEntries: [],
      includeOnlyNewFreqs: false,
      loadedSavedFilter: null,
      networkDisplayMap: {},
      options: buildOptions(),
      groupInfos: {},
      networks: [],
      queryState: emptyQueryState(),
      saveInFlight: false,
      savedFilterName: '',
      savedFilters: [],
      tagsMap: {},
      applySavedFilter: vi.fn(),
      deleteLoadedSavedFilter: vi.fn(),
      renameExistingSavedFilter: vi.fn(),
      resetFilters: vi.fn(),
      saveAsNew: vi.fn(),
      setIncludeOnlyNewFreqs: vi.fn(),
      setSavedFilterName: vi.fn(),
      loadFilterSection: vi.fn(),
      updateExisting: vi.fn(),
      updateQueryState: vi.fn(),
      ...overrides,
    },
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisFiltersPanel>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisFiltersPanel {...props} />);
  });
  return { container, root };
}

function findLabelInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(labelText));
  if (!label) throw new Error(`Label not found: ${labelText}`);
  const input = label.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found for label: ${labelText}`);
  return input;
}

function findLabelSelect(container: HTMLElement, labelText: string): HTMLSelectElement {
  const wrapper = Array.from(container.querySelectorAll('div,label')).find((item) => {
    if (!item.textContent?.includes(labelText)) return false;
    const select = item.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    const optionValues = Array.from(select.options).map((option) => option.value);
    return optionValues.includes('default') && optionValues.includes('exact') && optionValues.includes('non-exact');
  });
  if (!wrapper) throw new Error(`Select label not found: ${labelText}`);
  const select = wrapper.querySelector('select');
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found for label: ${labelText}`);
  return select;
}

async function setChecked(input: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (input.checked !== checked) {
      input.click();
    }
  });
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AnalysisFiltersPanel', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    analysisFilterFieldSpy.mockClear();
    accordionSpy.mockClear();
    powerChipSpy.mockClear();
    toggleButtonGroupOnChange = undefined;
  });

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('passes Elm-parity disabled states into the frequency and network filters', async () => {
    const props = buildProps({
      includeOnlyNewFreqs: true,
      queryState: {
        ...emptyQueryState(),
        withoutNetwork: true,
      },
    });

    rendered.push(await renderComponent(props));

    const frequencyField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; disabled?: boolean; loading?: boolean })
      .find((callProps) => callProps.label === 'Частоти');
    const networkField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; disabled?: boolean; loading?: boolean })
      .find((callProps) => callProps.label === 'Мережі');

    expect(frequencyField?.disabled).toBe(true);
    expect(networkField?.disabled).toBe(true);
  });

  it('keeps server-backed filter fields interactive while the page reloads', async () => {
    const props = buildProps({
      filtersLoading: true,
    });

    rendered.push(await renderComponent(props));

    const frequencyField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; disabled?: boolean; loading?: boolean })
      .find((callProps) => callProps.label === 'Частоти');
    const groupsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; disabled?: boolean; loading?: boolean })
      .find((callProps) => callProps.label === 'Групи');

    expect(frequencyField?.disabled ?? false).toBe(false);
    expect(frequencyField?.loading ?? false).toBe(false);
    expect(groupsField?.disabled ?? false).toBe(false);
    expect(groupsField?.loading ?? false).toBe(false);
  });

  it('shows loading state for an opened lazy section instead of an empty-options message', async () => {
    let resolveLoad: (() => void) | null = null;
    const loadFilterSection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const view = await renderComponent(
      buildProps({
        loadFilterSection,
      }),
    );
    rendered.push(view);

    const tagsAccordion = accordionSpy.mock.calls
      .map(([callProps]) => callProps as { 'data-section-id'?: string; onChange?: (event: unknown, nextExpanded: boolean) => void })
      .find((callProps) => callProps['data-section-id'] === 'Теги' && typeof callProps.onChange === 'function');
    await act(async () => {
      tagsAccordion?.onChange?.(null, true);
    });

    expect(
      analysisFilterFieldSpy.mock.calls.some(
        ([callProps]) => (callProps as { label: string; loading?: boolean }).label === 'Теги' && (callProps as { label: string; loading?: boolean }).loading === true,
      ),
    ).toBe(true);
    expect(loadFilterSection).toHaveBeenCalledWith('tags');

    await act(async () => {
      resolveLoad?.();
    });
  });

  it('keeps the tags section counter scoped to tag controls only', async () => {
    const view = await renderComponent(
      buildProps({
        options: {
          ...buildOptions(),
          tags: [
            { value: '1', label: '1', count: 1 },
            { value: '2', label: '2', count: 1 },
            { value: '3', label: '3', count: 1 },
            { value: '4', label: '4', count: 1 },
          ],
        },
        queryState: {
          ...emptyQueryState(),
          tags: [1],
          filterTagsOption: 'AllTags',
          withoutModelTags: true,
          reportTagsOnlyThisUnit: true,
          orWithExtendedForm: true,
          orBookmarked: true,
          orImportant: true,
          orWithCoords: true,
          orWithoutCoords: true,
        },
      }),
    );
    rendered.push(view);

    expect(view.container.textContent ?? '').toContain('4 з 4');
    expect(view.container.textContent ?? '').not.toContain('8 з 4');
  });

  it('passes group master keys as filter values while keeping duplicate group names as labels', async () => {
    const props = buildProps({
      groupInfos: {
        'group-a': buildGroupInfo('group-a', 'Грак Пл'),
        'group-b': buildGroupInfo('group-b', 'Грак Пл'),
      },
      options: {
        ...buildOptions(),
        groups: [
          { value: 'group-a', label: 'group-a', count: 1 },
          { value: 'group-b', label: 'group-b', count: 1 },
        ],
      },
      queryState: {
        ...emptyQueryState(),
        groupsSelected: ['group-b'],
      },
    });

    rendered.push(await renderComponent(props));

    const groupsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }>; value: string[] })
      .find((callProps) => callProps.label === 'Групи');

    expect(groupsField?.options).toEqual([
      { value: 'group-a', label: 'Грак Пл', count: 1 },
      { value: 'group-b', label: 'Грак Пл', count: 1 },
    ]);
    expect(groupsField?.value).toEqual(['group-b']);
  });

  it('uses the network stats label and sorts networks by it', async () => {
    const props = buildProps({
      networks: [buildNetwork(12, 'управління'), buildNetwork(13, 'відділ')],
      options: {
        ...buildOptions(),
        networks: [
          { value: '12', label: 'р/м управління 2 гсад', count: 6 },
          { value: '13', label: 'р/м відділ 1 мсб', count: 3 },
        ],
      },
    });

    rendered.push(await renderComponent(props));

    const networksField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Мережі');

    expect(networksField?.options).toEqual([
      { value: '13', label: 'р/м відділ 1 мсб', count: 3 },
      { value: '12', label: 'р/м управління 2 гсад', count: 6 },
    ]);
  });

  it('renders filters in the expected order with collapsed sections by default', async () => {
    const props = buildProps({
      aorEntries: [
        { id: 1, name: 'Смуга Б' },
        { id: 2, name: 'Смуга А' },
        { id: 3, name: 'Вся смуга' },
      ],
      tagsMap: {
        1: { label: 'Бета', extra: false, ord: null, keywords: null, isPalitra: false },
        2: { label: 'Альфа', extra: false, ord: null, keywords: null, isPalitra: false },
      } as AnalysisPageState['tagsMap'],
      options: {
        ...buildOptions(),
        tags: [
          { value: '1', label: '1', count: 2 },
          { value: '2', label: '2', count: 1 },
        ],
        aors: [
          { value: '2', label: '2', count: 1 },
          { value: '3', label: '3', count: 7 },
          { value: '1', label: '1', count: 4 },
        ],
        locations: [
          { value: 'ivanivka', label: 'Іванівка', count: 18 },
          { value: 'empty', label: '', count: 1674 },
          { value: 'ambarne', label: 'Амбарне', count: 7 },
        ],
        posts: [
          { value: '2', label: 'Пост Б', count: 2 },
          { value: '1', label: 'Пост А', count: 3 },
        ],
        units: [
          { value: 'u2', label: '3 мсб 121 мсп', count: 11 },
          { value: 'u1', label: '344 мсп 69 мсд 6 а', count: 22 },
          { value: 'u3', label: '128 омсбр', count: 8 },
        ],
        metadataCcs: [
          { value: 'z', label: 'Зет', count: 1 },
          { value: 'a', label: 'Альфа', count: 2 },
        ],
        metadataSenders: [
          { value: '7', label: '7', count: 1 },
          { value: '1', label: '1', count: 1 },
          { value: '856', label: '856', count: 1 },
        ],
        metadataReceivers: [
          { value: 'c', label: 'c', count: 1 },
          { value: 'a', label: 'a', count: 1 },
          { value: 'b', label: 'b', count: 1 },
        ],
        groups: [
          { value: 'group2', label: 'group2', count: 1 },
          { value: 'group1', label: 'group1', count: 2 },
        ],
      },
      groupInfos: {
        group1: buildGroupInfo('group1', 'Група Б'),
        group2: buildGroupInfo('group2', 'Група А'),
      },
      queryState: {
        ...emptyQueryState(),
        tags: [2],
        aorsSelected: ['1'],
        groupsSelected: ['group1'],
        locationsSelected: ['ambarne'],
        postsSelected: ['1'],
      },
    });

    rendered.push(await renderComponent(props));

    expect(accordionSpy.mock.calls.map(([callProps]) => (callProps as { expanded: boolean }).expanded).every((expanded) => expanded === false)).toBe(true);

    const renderedLabels = uniqueInOrder(analysisFilterFieldSpy.mock.calls.map(([callProps]) => (callProps as { label?: string }).label ?? ''));
    expect(renderedLabels).toEqual([
      'Смуги',
      'Частоти',
      'Позивні',
      'Мережі',
      'Підрозділи',
      'Групи',
      'Відправники',
      'Пости',
      'Локації',
      'Теги',
      'Метадані CC',
      'Метадані відправника',
      'Метадані отримувача',
      'Хеш метаданих',
    ]);

    const tagsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Теги');
    const aorsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Смуги');
    const groupsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Групи');
    const locationsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Локації');
    const postsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Пости');
    const unitsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Підрозділи');
    const metadataCcsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Метадані CC');
    const metadataSendersField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Метадані відправника');
    const metadataReceiversField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number }> })
      .find((callProps) => callProps.label === 'Метадані отримувача');

    expect(tagsField?.options.map((option) => option.label)).toEqual(['Альфа', 'Бета']);
    expect(aorsField?.options.map((option) => option.label)).toEqual(['Вся смуга', 'Смуга А', 'Смуга Б']);
    expect(groupsField?.options.map((option) => option.label)).toEqual(['Група А', 'Група Б']);
    expect(unitsField?.options.map((option) => option.label)).toEqual(['3 мсб 121 мсп', '128 омсбр', '344 мсп 69 мсд 6 а']);
    expect(locationsField?.options.map((option) => option.label)).toEqual(['<Не вказано>', 'Амбарне', 'Іванівка']);
    expect(postsField?.options.map((option) => option.label)).toEqual(['Пост А', 'Пост Б']);
    expect(metadataCcsField?.options.map((option) => option.label)).toEqual(['Альфа', 'Зет']);
    expect(metadataSendersField?.options.map((option) => option.label)).toEqual(['1', '7', '856']);
    expect(metadataReceiversField?.options.map((option) => option.label)).toEqual(['a', 'b', 'c']);
  });

  it('shows collapsed section counts like the old analysis sidebar', async () => {
    const view = await renderComponent(
      buildProps({
        counts: {
          countOverall: 0,
          countSelected: 0,
          groupsCount: 57,
          sendersCount: 83,
          freqsCount: 305,
          callsignsCount: 624,
          unitsCount: 142,
          locationsCount: 239,
          postsCount: 50,
          tagsCount: 15,
          aorsCount: 7,
          networksCount: 155,
          unitsExactMatchesCount: 0,
          unitsNonExactMatchesCount: 0,
        } as AnalysisPageState['counts'],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('7');
    expect(view.container.textContent).toContain('155');
  });

  it('keeps reset available while the initial filters load is still in flight', async () => {
    const view = await renderComponent(
      buildProps({
        canResetFilters: true,
        filtersLoading: true,
      }),
    );
    rendered.push(view);

    const resetButton = Array.from(view.container.querySelectorAll('button')).find((item) => item.textContent?.includes('Скинути'));
    expect(resetButton).toBeTruthy();
    expect((resetButton as HTMLButtonElement | undefined)?.disabled ?? true).toBe(false);
  });

  it('reloads an already open section after filter invalidation completes', async () => {
    const loadFilterSection = vi.fn();
    const props = buildProps({
      filtersLoading: true,
      loadFilterSection,
    });

    const view = await renderComponent(props);
    rendered.push(view);

    const tagsAccordion = accordionSpy.mock.calls
      .map(([callProps]) => callProps as { 'data-section-id'?: string; onChange?: (event: unknown, nextExpanded: boolean) => void })
      .find((callProps) => callProps['data-section-id'] === 'Теги' && typeof callProps.onChange === 'function');
    expect(tagsAccordion?.onChange).toBeTypeOf('function');

    await act(async () => {
      tagsAccordion?.onChange?.(null, true);
    });
    expect(loadFilterSection).toHaveBeenCalledWith('tags');

    loadFilterSection.mockClear();
    await act(async () => {
      view.root.render(
        <AnalysisFiltersPanel
          {...buildProps({
            filtersLoading: false,
            loadFilterSection,
          })}
        />,
      );
    });

    expect(loadFilterSection).toHaveBeenCalledWith('tags');
  });

  it('uppercases callsign labels without changing filter values sent to the API state', async () => {
    const updateQueryState = vi.fn();
    const props = buildProps({
      updateQueryState,
      options: {
        ...buildOptions(),
        callsigns: [
          { value: 'alpha', label: 'alpha', count: 1, values: ['alpha', 'Alpha'] },
          { value: 'ALPHA', label: 'ALPHA', count: 1, values: ['ALPHA'] },
        ],
      },
      queryState: {
        ...emptyQueryState(),
        callsignsSelected: ['Bravo'],
      },
    });

    rendered.push(await renderComponent(props));

    const callsignsField = analysisFilterFieldSpy.mock.calls
      .map(([callProps]) => callProps as { label: string; options: Array<{ value: string; label: string; count: number; values: string[] }>; value: string[]; onChange: (next: string[]) => void })
      .find((callProps) => callProps.label === 'Позивні');

    expect(callsignsField?.options).toEqual([
      { value: 'ALPHA', label: 'ALPHA', count: 2, values: ['alpha', 'Alpha', 'ALPHA'] },
    ]);
    expect(callsignsField?.value).toEqual(['Bravo']);

    callsignsField?.onChange(['alpha', 'ALPHA']);
    expect(updateQueryState).toHaveBeenCalledWith({ callsignsSelected: ['alpha', 'ALPHA'] });
  });

  it('wires checkbox and switch changes into the analysis callbacks', async () => {
    const setIncludeOnlyNewFreqs = vi.fn();
    const updateQueryState = vi.fn();
    const props = buildProps({
      setIncludeOnlyNewFreqs,
      updateQueryState,
    });

    const view = await renderComponent(props);
    rendered.push(view);

    await setChecked(findLabelInput(view.container, 'Тільки нові частоти'), true);
    await setChecked(findLabelInput(view.container, 'Лише теги мого підрозділу'), true);
    await setChecked(findLabelInput(view.container, 'Тільки без мережі'), true);

    expect(setIncludeOnlyNewFreqs).toHaveBeenCalledWith(true);
    expect(updateQueryState).toHaveBeenCalledWith({ reportTagsOnlyThisUnit: true });
    expect(updateQueryState).toHaveBeenCalledWith({ withoutNetwork: true });

    const toggleButton = (labelText: string) => {
      const button = Array.from(view.container.querySelectorAll('button')).find((item) => item.textContent?.includes(labelText));
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`Button not found for label: ${labelText}`);
      }
      return button;
    };

    await act(async () => {
      toggleButton('Без пеленга').click();
    });
    await act(async () => {
      toggleButton('З пеленгом').click();
    });
    await act(async () => {
      toggleButton('Усі').click();
    });

    expect(updateQueryState).toHaveBeenCalledWith({ orWithoutCoords: true, orWithCoords: false });
    expect(updateQueryState).toHaveBeenCalledWith({ orWithoutCoords: false, orWithCoords: true });
    expect(updateQueryState).toHaveBeenCalledWith({ orWithoutCoords: false, orWithCoords: false });
  });

  it('renders the peleng filter as a clear exclusive choice with helper text', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(view.container.textContent).toContain('Режим пеленга');
    expect(view.container.textContent).toContain('Усі');
    expect(view.container.textContent).toContain('З пеленгом');
    expect(view.container.textContent).toContain('Без пеленга');
    expect(view.container.textContent).toContain('Показувати всі записи або лише ті, де є координати пеленга.');
  });

  it('uses the lighter default label for the units exact-match selector without an extra hint chip', async () => {
    const view = await renderComponent(
      buildProps({
        counts: {
          countOverall: 0,
          countSelected: 0,
          groupsCount: 0,
          sendersCount: 0,
          freqsCount: 0,
          callsignsCount: 0,
          unitsCount: 0,
          locationsCount: 0,
          postsCount: 0,
          tagsCount: 0,
          aorsCount: 0,
          networksCount: 0,
          unitsExactMatchesCount: 3,
          unitsNonExactMatchesCount: 7,
        } as AnalysisPageState['counts'],
        queryState: {
          ...emptyQueryState(),
          unitsExactMatchOnly: null,
        },
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('За замовчуванням');
    expect(view.container.textContent).not.toContain('режим:');
  });

  it('does not render the removed exact-match hint chip when count stats are available', async () => {
    const view = await renderComponent(
      buildProps({
        counts: {
          countOverall: 0,
          countSelected: 0,
          groupsCount: 0,
          sendersCount: 0,
          freqsCount: 0,
          callsignsCount: 0,
          unitsCount: 0,
          locationsCount: 0,
          postsCount: 0,
          tagsCount: 0,
          aorsCount: 0,
          networksCount: 0,
          unitsExactMatchesCount: 3,
          unitsNonExactMatchesCount: 7,
        } as AnalysisPageState['counts'],
        queryState: {
          ...emptyQueryState(),
          unitsExactMatchOnly: true,
        },
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('За замовчуванням');
    expect(view.container.textContent).not.toContain('неточних збігів: 7');
  });

  it('updates the tri-state units match filter explicitly', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(
      buildProps({
        updateQueryState,
        queryState: {
          ...emptyQueryState(),
          unitsExactMatchOnly: null,
        },
      }),
    );
    rendered.push(view);

    const select = findLabelSelect(view.container, 'Збіг за еталонкою');
    await setSelectValue(select, 'exact');
    await setSelectValue(select, 'non-exact');
    await setSelectValue(select, 'default');

    expect(updateQueryState).toHaveBeenCalledWith({ unitsExactMatchOnly: true });
    expect(updateQueryState).toHaveBeenCalledWith({ unitsExactMatchOnly: false });
    expect(updateQueryState).toHaveBeenCalledWith({ unitsExactMatchOnly: null });
  });

  it('renders reset inside the filters panel and disables it when there is nothing to reset', async () => {
    const resetFilters = vi.fn();
    const view = await renderComponent(
      buildProps({
        canResetFilters: false,
        resetFilters,
      }),
    );
    rendered.push(view);

    const button = Array.from(view.container.querySelectorAll('button')).find((item) => item.textContent?.includes('Скинути'));
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    button?.click();
    expect(resetFilters).not.toHaveBeenCalled();
  });

  it('shows loading indicators for filter counters while the initial filters load is still in flight', async () => {
    const view = await renderComponent(
      buildProps({
        filtersLoading: true,
      }),
    );
    rendered.push(view);

    expect(view.container.querySelectorAll('[data-testid="spinner"]').length).toBeGreaterThan(0);
  });

  it('renders the loaded saved filter as a status chip above the important section and orders sections alphabetically', async () => {
    const loadedSavedFilter: SavedFilter = {
      id: 7,
      name: 'Saved filter',
      req: {
        sinceDateInclusiveMs: 1,
        tillDateNoninclusiveMs: 2,
        selectedGroups: null,
        selectedSenders: null,
        selectedFreqs: null,
        selectedPosts: null,
        selectedCallsigns: null,
        selectedUnits: null,
        selectedLocations: null,
        selectedAors: null,
        orWithExtendedForm: null,
        orBookmarked: null,
        orImportant: null,
        orWithCoords: null,
        orWithoutCoords: null,
        search: null,
        selectedTags: null,
        selectedNetworks: null,
        withoutNetwork: null,
        metadataCc: null,
        metadataSender: null,
        metadataReceiver: null,
        metadataHash: null,
        onlyWithMetadata: null,
        withoutMetadata: null,
        includePelengLocations: null,
        unitsExactMatchOnly: null,
        filterTagsOption: null,
        withoutModelTags: null,
        reportTagsOnlyThisUnit: null,
      },
    };
    const view = await renderComponent(
      buildProps({
        loadedSavedFilter,
      }),
    );
    rendered.push(view);

    const chipProps = powerChipSpy.mock.calls.at(-1)?.[0] as { onDelete?: () => void } | undefined;
    expect(chipProps?.onDelete).toBeUndefined();
    expect(view.container.querySelector('[data-testid="saved-filter-chip"]')?.textContent).toBe('Saved filter');

    expect(
      uniqueInOrder(
        accordionSpy.mock.calls
          .map(([props]) => String((props as { 'data-section-id'?: string })['data-section-id']))
          .filter((value) => value !== 'undefined'),
      ).slice(0, 12),
    ).toEqual([
      'Смуги',
      'Частоти',
      'Позивні',
      'Мережі',
      'Підрозділи',
      'Групи',
      'Відправники',
      'Пости',
      'Локації',
      'important',
      'Теги',
      'Метадані',
    ]);
  });
});
