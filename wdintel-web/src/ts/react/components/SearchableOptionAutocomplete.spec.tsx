/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockOption = { id: number; label: string };

let latestAutocompleteProps: {
  multiple?: boolean;
  inputValue?: string;
  onChange?: (_event: unknown, nextOption: MockOption | MockOption[] | null) => void;
  onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
} | null = null;

vi.mock('@mui/material', () => ({
  Autocomplete: ({
    multiple,
    inputValue,
    onChange,
    onInputChange,
    renderInput,
  }: {
    multiple?: boolean;
    inputValue?: string;
    onChange?: (_event: unknown, nextOption: MockOption | MockOption[] | null) => void;
    onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
    renderInput?: (params: unknown) => ReactNode;
  }) => (
    <div>
      {((latestAutocompleteProps = { multiple, inputValue, onChange, onInputChange }), null)}
      {renderInput ? renderInput({} as never) : null}
    </div>
  ),
  TextField: ({ label, helperText, onBlur }: { label?: ReactNode; helperText?: ReactNode; onBlur?: () => void }) => (
    <input aria-label={String(label)} data-helper={helperText ? String(helperText) : ''} onBlur={onBlur} />
  ),
}));

import { SearchableOptionAutocomplete } from './SearchableOptionAutocomplete';
import type { SearchableOptionSelection } from './searchable-option.types';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];
const options: MockOption[] = [
  { id: 1, label: 'Альфа' },
  { id: 3, label: 'Браво' },
];

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
  latestAutocompleteProps = null;
});

function renderSingleHarness(
  initialValue: SearchableOptionSelection | null = { id: 1, value: 'Альфа' },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [value, setValue] = useState<SearchableOptionSelection | null>(initialValue);

    return (
      <div>
        <div data-testid="value">{value === null ? 'null' : JSON.stringify(value)}</div>
        <SearchableOptionAutocomplete
          label="Підрозділ"
          options={options}
          value={value}
          onChange={setValue}
          getOptionLabel={(option) => option.label}
          getStoredValue={(option) => option.label}
        />
      </div>
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

function renderMultiHarness(
  initialValue: SearchableOptionSelection[] = [{ id: 1, value: 'Альфа' }],
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [value, setValue] = useState<SearchableOptionSelection[]>(initialValue);

    return (
      <div>
        <div data-testid="value">{JSON.stringify(value)}</div>
        <SearchableOptionAutocomplete
          multiple
          options={options}
          value={value}
          onChange={setValue}
          getOptionLabel={(option) => option.label}
          getStoredValue={(option) => option.label}
        />
      </div>
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

function readValue(container: HTMLDivElement): string {
  return container.querySelector('[data-testid="value"]')?.textContent ?? '';
}

describe('SearchableOptionAutocomplete', () => {
  it('does not change the selected value while typing in single mode', () => {
    const view = renderSingleHarness();
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '3', 'input');
    });

    expect(readValue(view.container)).toBe(JSON.stringify({ id: 1, value: 'Альфа' }));
  });

  it('returns a selection on explicit single select', () => {
    const view = renderSingleHarness();
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onChange?.({} as never, { id: 3, label: 'Браво' });
    });

    expect(readValue(view.container)).toBe(JSON.stringify({ id: 3, value: 'Браво' }));
  });

  it('returns null on single clear', () => {
    const view = renderSingleHarness();
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '', 'clear');
    });

    expect(readValue(view.container)).toBe('null');
  });

  it('returns an array of selections on multi select', () => {
    const view = renderMultiHarness([]);
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onChange?.({} as never, [
        { id: 1, label: 'Альфа' },
        { id: 3, label: 'Браво' },
      ]);
    });

    expect(readValue(view.container)).toBe(
      JSON.stringify([
        { id: 1, value: 'Альфа' },
        { id: 3, value: 'Браво' },
      ]),
    );
  });

  it('returns a shorter array when a multi chip is removed', () => {
    const view = renderMultiHarness([
      { id: 1, value: 'Альфа' },
      { id: 3, value: 'Браво' },
    ]);
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onChange?.({} as never, [{ id: 3, label: 'Браво' }]);
    });

    expect(readValue(view.container)).toBe(JSON.stringify([{ id: 3, value: 'Браво' }]));
  });

  it('preserves typed input on spurious reset without selection change', () => {
    const view = renderMultiHarness([]);
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '3 мсб', 'input');
    });

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '', 'reset');
    });

    expect(latestAutocompleteProps?.inputValue).toBe('3 мсб');
  });

  it('clears typed input after multi selection', () => {
    const view = renderMultiHarness([]);
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, 'Бра', 'input');
    });

    act(() => {
      latestAutocompleteProps?.onChange?.({} as never, [{ id: 3, label: 'Браво' }]);
    });

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '', 'reset');
    });

    expect(latestAutocompleteProps?.inputValue).toBe('');
    expect(readValue(view.container)).toBe(JSON.stringify([{ id: 3, value: 'Браво' }]));
  });
});
