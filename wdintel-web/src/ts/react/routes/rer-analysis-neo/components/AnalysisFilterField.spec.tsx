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
  it('preserves caller-provided option order', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(<AnalysisFilterField label="Частоти" options={['1.000', '2.000', '10.000']} value={[]} onChange={vi.fn()} />);
    });

    const props = autocompleteSpy.mock.calls.at(-1)?.[0] as { options: Array<{ value: string; label: string }> };

    expect(props.options.map((option) => option.value)).toEqual(['1.000', '2.000', '10.000']);

    act(() => {
      root.unmount();
    });
  });
});
