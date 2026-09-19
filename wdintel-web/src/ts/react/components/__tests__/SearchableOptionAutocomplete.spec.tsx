/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let latestAutocompleteProps: {
  onChange?: (_event: unknown, nextOption: { id: number } | null) => void;
  onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
} | null = null;

vi.mock('@mui/material', () => ({
  Autocomplete: ({
    onChange,
    onInputChange,
    renderInput,
  }: {
    onChange?: (_event: unknown, nextOption: { id: number } | null) => void;
    onInputChange?: (_event: unknown, nextValue: string, reason: string) => void;
    renderInput?: (params: unknown) => ReactNode;
  }) => (
    <div>
      {((latestAutocompleteProps = { onChange, onInputChange }), null)}
      {renderInput ? renderInput({} as never) : null}
    </div>
  ),
  TextField: ({
    label,
    helperText,
    onBlur,
  }: {
    label?: ReactNode;
    helperText?: ReactNode;
    onBlur?: () => void;
  }) => (
    <input
      aria-label={String(label)}
      data-helper={helperText ? String(helperText) : ''}
      onBlur={onBlur}
    />
  ),
}));

import { SearchableOptionAutocomplete } from '../SearchableOptionAutocomplete.tsx';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
  latestAutocompleteProps = null;
});

function renderHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [valueId, setValueId] = useState<number | null>(1);

    return (
      <div>
        <div data-testid="value-id">{valueId === null ? 'null' : String(valueId)}</div>
        <SearchableOptionAutocomplete
          label="Підрозділ"
          options={[
            { id: 1, label: 'Альфа' },
            { id: 3, label: 'Браво' },
          ]}
          valueId={valueId}
          onValueIdChange={setValueId}
          getOptionLabel={(option) => option.label}
        />
      </div>
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}
describe('SearchableOptionAutocomplete', () => {
  it('does not change the selected value while typing', () => {
    const view = renderHarness();
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '3', 'input');
    });

    expect(view.container.querySelector('[data-testid="value-id"]')?.textContent).toBe('1');
  });

  it('changes the selected value only on explicit select or clear', () => {
    const view = renderHarness();
    rendered.push(view);

    act(() => {
      latestAutocompleteProps?.onChange?.({} as never, { id: 3 });
    });

    expect(view.container.querySelector('[data-testid="value-id"]')?.textContent).toBe('3');

    act(() => {
      latestAutocompleteProps?.onInputChange?.({} as never, '', 'clear');
    });

    expect(view.container.querySelector('[data-testid="value-id"]')?.textContent).toBe('null');
  });
});
