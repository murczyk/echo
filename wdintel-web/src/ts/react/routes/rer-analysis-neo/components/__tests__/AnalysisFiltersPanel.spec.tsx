/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignalGroupEntry } from '../../../../../../Bindings';
import type { AnalysisPageState } from '../../types';
import { emptyQueryState } from '../../helpers';

const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));

const accordionSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Accordion: (props: {
    children: ReactNode;
    onChange?: (event: unknown, nextExpanded: boolean) => void;
  }) => {
    accordionSpy(props);
    return <div>{props.children}</div>;
  },
  AccordionDetails: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionSummary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    startIcon?: ReactNode;
  }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.startIcon}
      {props.children}
    </button>
  ),
  Checkbox: (props: {
    checked?: boolean;
    onChange?: (_event: Event, checked: boolean) => void;
  }) => (
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
  MenuItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  Paper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: (props: {
    children: ReactNode;
    value: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <select
      value={props.value}
      onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
    >
      {props.children}
    </select>
  ),
  ToggleButtonGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="toggle-button-group">{children}</div>
  ),
  ToggleButton: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: (props: { checked?: boolean; onChange?: (_event: Event, checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.nativeEvent, event.currentTarget.checked)}
    />
  ),
  TextField: (props: {
    label?: string;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    type?: string;
  }) => (
    <label>
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value ?? ''}
        onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
      />
    </label>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMediaQuery: useMediaQueryMock,
  Typography: ({ children, role }: { children: ReactNode; role?: string }) => (
    <div role={role}>{children}</div>
  ),
}));

vi.mock('@mui/icons-material/FilterAlt', () => ({
  default: () => <span data-testid="filled-filter-icon" />,
}));

vi.mock('@mui/icons-material/Search', () => ({
  default: () => <span>search</span>,
}));

vi.mock('@mui/icons-material/ExpandMore', () => ({
  default: () => <span>expand</span>,
}));

vi.mock('@mui/icons-material/InfoOutlined', () => ({
  default: () => <span>info</span>,
}));

vi.mock('.././AnalysisFilterField', () => ({
  AnalysisFilterField: (props: { label?: string }) => (
    <div data-testid={`filter-${String(props.label ?? 'unknown')}`} />
  ),
}));

vi.mock('.././AnalysisSavedFiltersCard', () => ({
  AnalysisSavedFiltersCard: () => <div data-testid="saved-filters-card" />,
}));

vi.mock('../../../../components/PowerChip', () => ({
  PowerChip: (props: { label: ReactNode }) => (
    <button type="button" data-testid="saved-filter-chip">
      {props.label}
    </button>
  ),
}));

import { AnalysisFiltersPanel } from '.././AnalysisFiltersPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

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
    interseptionKind: 'rer',
    disableNetworkAssignment: false,
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

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisFiltersPanel>['page']> = {},
): ComponentProps<typeof AnalysisFiltersPanel> {
  return {
    page: {
      isDirty: false,
      canResetFilters: false,
      counts: null,
      countsLoading: false,
      filterSectionLoadStates: {
        tags: 'idle',
        aors: 'idle',
        groups: 'idle',
        senders: 'idle',
        callsigns: 'idle',
        units: 'idle',
        locations: 'idle',
        posts: 'idle',
        networks: 'idle',
        metadata: 'idle',
      },
      aorEntries: [],
      cyberEchoEnabled: false,
      includeOnlyNewFreqs: false,
      loadedSavedFilter: null,
      messagesOverallCount: null,
      messagesTotalCount: null,
      messagesTotalLoading: false,
      isFilterSectionLoading: () => false,
      isFilterSectionEmptyLoading: () => false,
      isFilterSectionStale: () => false,
      networkDisplayMap: {},
      options: buildOptions(),
      groupInfos: {},
      networks: [],
      queryState: emptyQueryState(),
      unitsExactMatchOnlyDefault: false,
      saveInFlight: false,
      savedFilterName: '',
      savedFilters: [],
      tagsMap: {},
      tagsOrder: [],
      unitsMap: {},
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

async function renderComponent(
  props: ComponentProps<typeof AnalysisFiltersPanel>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisFiltersPanel {...props} />);
  });
  return { container, root };
}

describe('AnalysisFiltersPanel', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    accordionSpy.mockClear();
  });

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });
  it('does not auto-reload an already open section after filter invalidation completes', async () => {
    const loadFilterSection = vi.fn();
    const props = buildProps({
      filtersLoading: true,
      loadFilterSection,
    });

    const view = await renderComponent(props);
    rendered.push(view);

    const tagsAccordion = accordionSpy.mock.calls
      .map(
        ([callProps]) =>
          callProps as {
            'data-section-id'?: string;
            onChange?: (event: unknown, nextExpanded: boolean) => void;
          },
      )
      .find(
        (callProps) =>
          callProps['data-section-id'] === 'Теги' && typeof callProps.onChange === 'function',
      );
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

    expect(loadFilterSection).not.toHaveBeenCalled();
  });
});
