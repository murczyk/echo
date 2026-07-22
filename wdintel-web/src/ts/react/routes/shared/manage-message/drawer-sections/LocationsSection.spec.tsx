/** @vitest-environment happy-dom */
import { act, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { FormProvider, useForm, type UseFormReturn } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettlementDetails } from '../../../../services/api/settlements';
import { EMPTY_FORM_VALUES, type MessageFormData } from '../manage-message-drawer.schema';
import { LocationsSection } from './LocationsSection';

const mocks = vi.hoisted(() => ({
  autocompleteProps: undefined as Record<string, any> | undefined,
  settlementOptions: [] as SettlementDetails[],
  onInputChange: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Autocomplete: (props: Record<string, any>) => {
    mocks.autocompleteProps = props;
    props.renderInput?.({});
    return null;
  },
  Box: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Stack: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextField: () => null,
  Typography: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('./useSettlementAutocomplete', () => ({
  useSettlementAutocomplete: vi.fn(() => ({
    settlementOptions: mocks.settlementOptions,
    loading: false,
    onInputChange: mocks.onInputChange,
  })),
}));

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

function Harness() {
  methods = useForm<MessageFormData>({ defaultValues: EMPTY_FORM_VALUES });
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

describe('LocationsSection', () => {
  beforeEach(() => {
    mocks.autocompleteProps = undefined;
    mocks.settlementOptions = settlements;
    mocks.onInputChange.mockReset();
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
});
