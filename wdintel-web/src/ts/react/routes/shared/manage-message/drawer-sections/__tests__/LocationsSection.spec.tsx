/** @vitest-environment happy-dom */
import { act, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { FormProvider, useForm, type UseFormReturn } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettlementDetails } from '../../../../../services/api/settlements';
import { EMPTY_FORM_VALUES, type MessageFormData } from '../../manage-message-drawer.schema';
import { LocationsSection } from '../LocationsSection';
import { useSettlementAutocomplete } from '../useSettlementAutocomplete';

const mocks = vi.hoisted(() => ({
  autocompleteProps: undefined as Record<string, any> | undefined,
  settlementOptions: [] as SettlementDetails[],
  loading: false,
  hasLocationQuery: false,
  onInputChange: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Autocomplete: (props: Record<string, any>) => {
    mocks.autocompleteProps = props;
    props.renderInput?.({});
    return null;
  },
  CircularProgress: ({ size }: { size?: number }) => createElement('span', { 'data-size': size }),
  Box: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Stack: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextField: () => null,
  Typography: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../useSettlementAutocomplete', () => ({
  useSettlementAutocomplete: vi.fn(() => ({
    settlementOptions: mocks.settlementOptions,
    loading: mocks.loading,
    hasLocationQuery: mocks.hasLocationQuery,
    onInputChange: mocks.onInputChange,
  })),
}));

vi.mock('../CoordinateInputPreview', () => ({ CoordinateInputPreview: () => null }));
vi.mock('../CoordinateListInput', () => ({ CoordinateListInput: () => null }));

const settlements: SettlementDetails[] = [
  {
    id: 1,
    name: 'МЕРЕФА',
    region: 'Харківська область',
    language: 'Ua',
    coords: [49.8, 36.0],
  },
  {
    id: 2,
    name: 'МЕРЕФА',
    region: 'Інша область',
    language: 'Ua',
    coords: [48.1, 35.2],
  },
];

const sameSettlementVariants: SettlementDetails[] = [
  {
    id: 3044302,
    name: 'МЕДВЕДІВКА',
    region: 'Черкаська область',
    language: 'Ua',
    coords: [49.0, 32.0],
  },
  {
    id: 3044302,
    name: 'MEDVEDIVKA',
    region: 'Черкаська область',
    language: 'UaTranslit',
    coords: [49.0, 32.0],
  },
];

let root: Root;
let container: HTMLDivElement;
let methods: UseFormReturn<MessageFormData>;
let signalGroupMasterKey: string | null = null;

function Harness() {
  methods = useForm<MessageFormData>({
    defaultValues: { ...EMPTY_FORM_VALUES, signalGroupMasterKey },
  });
  return createElement(
    FormProvider,
    methods,
    createElement(LocationsSection, {
      busy: false,
      recentValues: { locations: ['Раніше', 'Ще раніше'] },
      open: true,
      onError: vi.fn(),
    }),
  );
}

// @test-scope safeguard: prevents coordinate edits, deletion, and settlement selection from losing the current message location.
describe('LocationsSection', () => {
  beforeEach(() => {
    mocks.autocompleteProps = undefined;
    mocks.settlementOptions = settlements;
    mocks.loading = false;
    mocks.hasLocationQuery = false;
    mocks.onInputChange.mockReset();
    vi.mocked(useSettlementAutocomplete).mockClear();
    signalGroupMasterKey = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderSection() {
    await act(async () => root.render(createElement(Harness)));
    expect(mocks.autocompleteProps).toBeDefined();
    return mocks.autocompleteProps!;
  }

  it('keeps recent options first and preserves settlement order', async () => {
    const props = await renderSection();

    expect(props.options).toEqual([
      { kind: 'recent', key: 'recent:Раніше:0', name: 'Раніше' },
      { kind: 'recent', key: 'recent:Ще раніше:1', name: 'Ще раніше' },
      {
        kind: 'settlement',
        key: 'settlement:1:МЕРЕФА:Харківська область:Ua:49.8,36:0',
        settlement: settlements[0],
      },
      {
        kind: 'settlement',
        key: 'settlement:2:МЕРЕФА:Інша область:Ua:48.1,35.2:1',
        settlement: settlements[1],
      },
    ]);
    expect(props.filterOptions(props.options)).toBe(props.options);
    expect(props.forcePopupIcon).toBe(true);
  });

  it('hides recent options during an active query', async () => {
    mocks.loading = true;
    mocks.hasLocationQuery = true;
    const props = await renderSection();

    expect(props.options).toEqual([
      expect.objectContaining({ kind: 'settlement', settlement: settlements[0] }),
      expect.objectContaining({ kind: 'settlement', settlement: settlements[1] }),
    ]);
    expect(props.filterOptions(props.options)).toBe(props.options);
  });

  it('shows progress while preserving MUI input controls', async () => {
    mocks.loading = true;
    mocks.hasLocationQuery = true;
    const props = await renderSection();
    const paramsInputProps = { endAdornment: createElement('button', null, 'controls') };
    const textField = props.renderInput({ InputProps: paramsInputProps }) as any;
    const adornment = textField.props.slotProps.input.endAdornment;
    const markup = renderToStaticMarkup(adornment);

    expect(markup).toContain('data-size="20"');
    expect(markup).toContain('controls');
  });

  it('renders settlement name and region and generates distinct keys', async () => {
    const props = await renderSection();
    const firstSettlementOption = props.options[2];
    const secondSettlementOption = props.options[3];
    const rendered = props.renderOption({}, firstSettlementOption);
    const markup = renderToStaticMarkup(rendered);

    expect(markup).toContain('МЕРЕФА');
    expect(markup).toContain('Харківська область');
    expect(props.getOptionKey(firstSettlementOption)).not.toBe(
      props.getOptionKey(secondSettlementOption),
    );
  });

  it('disambiguates settlement variants with the same ID', async () => {
    mocks.settlementOptions = sameSettlementVariants;
    const props = await renderSection();
    const firstSettlementOption = props.options[2];
    const secondSettlementOption = props.options[3];
    const firstRendered = props.renderOption({}, firstSettlementOption);
    const secondRendered = props.renderOption({}, secondSettlementOption);

    expect(props.getOptionKey(firstSettlementOption)).not.toBe(
      props.getOptionKey(secondSettlementOption),
    );
    expect(firstRendered.key).toBe(props.getOptionKey(firstSettlementOption));
    expect(secondRendered.key).toBe(props.getOptionKey(secondSettlementOption));
  });

  it('normalizes free text, settlement, comma-separated, and recent selections', async () => {
    const props = await renderSection();

    await act(async () => {
      props.onChange(null, ['Вільний текст', props.options[2], 'Київ, Львів']);
    });
    expect(methods.getValues('locations')).toEqual(['Вільний текст', 'МЕРЕФА', 'Київ', 'Львів']);

    await act(async () => {
      props.onChange(null, [props.options[0]]);
    });
    expect(methods.getValues('locations')).toEqual(['Раніше']);
  });

  it('passes the selected group key to the settlement hook', async () => {
    signalGroupMasterKey = ' group-1 ';
    await renderSection();

    expect(vi.mocked(useSettlementAutocomplete)).toHaveBeenCalledWith(
      expect.objectContaining({ signalGroupMasterKey: 'group-1' }),
    );
  });
});
