/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const autocompleteSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Autocomplete: (props: unknown) => {
    autocompleteSpy(props);
    return <div data-testid="autocomplete" />;
  },
  TextField: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
}));

import { AnalysisFilterField } from './AnalysisFilterField';

describe('AnalysisFilterField', () => {
  function renderFilterField(props: Parameters<typeof AnalysisFilterField>[0]) {
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(<AnalysisFilterField {...props} />);
    });

    return { root };
  }

  function latestAutocompleteProps() {
    return autocompleteSpy.mock.calls.at(-1)?.[0] as {
      onChange: (_event: unknown, next: Array<{ value: string; label: string; values: string[] }>) => void;
      options: Array<{ value: string; label: string; values: string[] }>;
      value: Array<{ value: string; label: string; values: string[] }>;
    };
  }

  it('preserves caller-provided option order', () => {
    const { root } = renderFilterField({ label: 'Частоти', options: ['1.000', '2.000', '10.000'], value: [], onChange: vi.fn() });
    const props = latestAutocompleteProps();

    expect(props.options.map((option) => option.value)).toEqual(['1.000', '2.000', '10.000']);

    act(() => {
      root.unmount();
    });
  });

  it('expands grouped option values on change', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Позивні',
      options: [{ value: 'ALPHA', label: 'ALPHA', values: ['alpha', 'ALPHA'] }],
      value: ['ALPHA'],
      onChange,
    });
    const props = latestAutocompleteProps();

    expect(props.value.map(({ value, label, values }) => ({ value, label, values }))).toEqual([
      { value: 'ALPHA', label: 'ALPHA', values: ['alpha', 'ALPHA'] },
    ]);

    props.onChange(null, props.options);
    expect(onChange).toHaveBeenCalledWith(['alpha', 'ALPHA']);

    act(() => {
      root.unmount();
    });
  });
});
