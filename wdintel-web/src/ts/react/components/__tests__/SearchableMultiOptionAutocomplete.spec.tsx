/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Option = { id: number; label: string };

let latestAutocompleteProps: {
  filterOptions?: (options: Option[]) => Option[];
  inputValue?: string;
  onChange?: (_event: unknown, nextOptions: Option[], reason: 'selectOption') => void;
  onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
} | null = null;

vi.mock('@mui/material', () => ({
  Autocomplete: ({
    filterOptions,
    inputValue,
    onChange,
    onInputChange,
    renderInput,
  }: {
    filterOptions?: (options: Option[]) => Option[];
    inputValue?: string;
    onChange?: (_event: unknown, nextOptions: Option[]) => void;
    onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
    renderInput?: (params: unknown) => ReactNode;
  }) => (
    <div>
      {((latestAutocompleteProps = { filterOptions, inputValue, onChange, onInputChange }), null)}
      {renderInput?.({} as never)}
    </div>
  ),
  TextField: () => <input />,
}));

import { SearchableMultiOptionAutocomplete } from '../SearchableMultiOptionAutocomplete';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latestAutocompleteProps = null;
});

describe('SearchableMultiOptionAutocomplete', () => {
  it('clears server search after selection and ignores the following MUI reset', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onInputChange = vi.fn();
    const options = [
      { id: 1, label: 'АЛЬФА' },
      { id: 2, label: 'БРАВО' },
    ];

    act(() => {
      root?.render(
        <SearchableMultiOptionAutocomplete
          label="Позивні"
          options={options}
          valueIds={[]}
          getOptionLabel={(option) => option.label}
          onInputChange={onInputChange}
          onValueIdsChange={vi.fn()}
          serverSearch
        />,
      );
    });
    act(() => latestAutocompleteProps?.onInputChange?.({} as never, 'АЛЬФА', 'input'));
    act(() => latestAutocompleteProps?.onChange?.({} as never, [options[0]], 'selectOption'));
    act(() => latestAutocompleteProps?.onInputChange?.({} as never, 'АЛЬФА', 'reset'));

    expect(onInputChange).toHaveBeenLastCalledWith('');
    expect(latestAutocompleteProps?.inputValue).toBe('');
    expect(latestAutocompleteProps?.filterOptions?.(options)).toEqual(options);

    act(() => latestAutocompleteProps?.onInputChange?.({} as never, '', 'clear'));
    expect(onInputChange).toHaveBeenLastCalledWith('');
  });
});
