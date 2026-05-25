/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ELLIPSIS } from '../../../utils/misc';

const autocompleteSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Autocomplete: (props: unknown) => {
    autocompleteSpy(props);
    return <div data-testid="autocomplete" />;
  },
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Chip: ({ label, title }: { label?: ReactNode; title?: string }) => <div title={title}>{label}</div>,
  TextField: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
  Typography: ({ children, title }: { children: ReactNode; title?: string }) => <span title={title}>{children}</span>,
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
      disableCloseOnSelect?: boolean;
      onChange: (_event: unknown, next: Array<{ value: string; label: string; count: number; values: string[] }>) => void;
      renderOption: (props: { key: string; [key: string]: unknown }, option: { key: string; value: string; label: string; count: number; values: string[] }) => unknown;
      renderTags: (
        value: Array<{ key: string; value: string; label: string; count: number; values: string[] }>,
        getTagProps: (_args: { index: number }) => { key: string; [key: string]: unknown },
      ) => Array<{ props: { title?: string; label?: unknown } }>;
      options: Array<{ value: string; label: string; count: number; values: string[] }>;
      value: Array<{ value: string; label: string; count: number; values: string[] }>;
      loading?: boolean;
      loadingText?: string;
      noOptionsText?: string;
    };
  }

  it('preserves caller-provided option order', () => {
    const { root } = renderFilterField({
      label: 'Частоти',
      options: [
        { value: '1.000', label: '1.000', count: 1 },
        { value: '2.000', label: '2.000', count: 2 },
        { value: '10.000', label: '10.000', count: 10 },
      ],
      value: [],
      onChange: vi.fn(),
    });
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
      options: [{ value: 'ALPHA', label: 'ALPHA', count: 2, values: ['alpha', 'ALPHA'] }],
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

  it('keeps unknown selected values visible with a safe fallback label and zero count', () => {
    const { root } = renderFilterField({
      label: 'Мережі',
      options: [{ value: '12', label: 'Мережа 12', count: 4 }],
      value: ['99'],
      onChange: vi.fn(),
    });
    const props = latestAutocompleteProps();

    expect(props.value).toEqual([
      { key: '99', value: '99', label: '99', count: 0, values: ['99'] },
    ]);

    act(() => {
      root.unmount();
    });
  });

  it('shows loading state text while options are still loading', () => {
    const { root } = renderFilterField({
      label: 'Мережі',
      options: [],
      value: [],
      loading: true,
      onChange: vi.fn(),
    });
    const props = latestAutocompleteProps();

    expect(props.disableCloseOnSelect).toBe(true);
    expect(props.loading).toBe(true);
    expect(props.loadingText).toBe(`Завантаження${ELLIPSIS}`);
    expect(props.noOptionsText).toBe(`Завантаження${ELLIPSIS}`);

    act(() => {
      root.unmount();
    });
  });

  it('exposes full labels on hovered options and selected chips', () => {
    const { root } = renderFilterField({
      label: 'Мережі',
      options: [{ value: '12', label: 'р/м управління 1 гсад 60 сап 69 мсд 6 ЗА (KYIV)', count: 30 }],
      value: ['12'],
      onChange: vi.fn(),
    });
    const props = latestAutocompleteProps();

    const optionElement = props.renderOption({ key: 'opt-12' }, {
      key: '12',
      value: '12',
      label: 'р/м управління 1 гсад 60 сап 69 мсд 6 ЗА (KYIV)',
      count: 30,
      values: ['12'],
    }) as { props: { title?: string; children?: unknown } };
    expect(optionElement.props.title).toBe('р/м управління 1 гсад 60 сап 69 мсд 6 ЗА (KYIV)');

    const chipElements = props.renderTags(
      [{ key: '12', value: '12', label: 'р/м управління 1 гсад 60 сап 69 мсд 6 ЗА (KYIV)', count: 30, values: ['12'] }],
      ({ index }) => ({ key: `tag-${index}` }),
    ) as Array<{ props: { title?: string } }>;
    expect(chipElements[0]?.props.title).toBe('р/м управління 1 гсад 60 сап 69 мсд 6 ЗА (KYIV)');

    act(() => {
      root.unmount();
    });
  });
});
