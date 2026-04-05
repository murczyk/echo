/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { emptyQueryState } from '../helpers';

const analysisFilterFieldSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionDetails: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionSummary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

import { AnalysisFiltersPanel } from './AnalysisFiltersPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildOptions(): AnalysisPageState['options'] {
  return {
    aors: [],
    groups: [],
    senders: [],
    freqs: ['100.0000'],
    newFreqs: ['100.0000'],
    callsigns: [],
    units: [],
    locations: [],
    posts: [],
    networks: ['12'],
    metadataCcs: [],
    metadataSenders: [],
    metadataReceivers: [],
    metadataHashes: [],
  };
}

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisFiltersPanel>> = {}): ComponentProps<typeof AnalysisFiltersPanel> {
  return {
    isDirty: false,
    canResetFilters: false,
    counts: null,
    includeOnlyNewFreqs: false,
    loadedSavedFilter: null,
    options: buildOptions(),
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
    updateExisting: vi.fn(),
    updateQueryState: vi.fn(),
    ...overrides,
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

  it('keeps server-backed filter fields interactive while their options refresh', async () => {
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
    expect(frequencyField?.loading).toBe(true);
    expect(groupsField?.disabled ?? false).toBe(false);
    expect(groupsField?.loading).toBe(true);
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
  });

  it('shows the explicit server-default hint chip when the tri-state filter is unset', async () => {
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

    expect(view.container.textContent).toContain('режим: серверний дефолт');
  });

  it('shows the Elm-style exact-match hint chip when count stats are available', async () => {
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

    expect(view.container.textContent).toContain('неточних збігів: 7');
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
});
