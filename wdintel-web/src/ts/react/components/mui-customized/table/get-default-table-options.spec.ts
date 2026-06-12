/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  EXPLICIT_SELECT_ALL_OPTION,
  buildExplicitSingleSelectColumnFilter,
  getDefaultMRTOptions,
  getSharedFilterTextFieldProps,
  getSharedSelectAllCheckboxProps,
  resolveExplicitSelectFilterValue,
  renderDefaultMrtEmptyRowsFallback,
  withExplicitSelectAllOption,
} from './get-default-table-options';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../../routes/shared/empty-state-text';

describe('getSharedFilterTextFieldProps', () => {
  it('returns select-specific props for select filters', () => {
    const props = getSharedFilterTextFieldProps('select');

    expect(props.sx).toMatchObject({
      '& .MuiInputBase-root': {
        cursor: 'pointer',
      },
      '& .MuiInputAdornment-positionEnd': {
        cursor: 'pointer',
        pointerEvents: 'none',
      },
      '& .MuiInputAdornment-positionEnd .MuiIconButton-root': {
        pointerEvents: 'auto',
      },
      '& .MuiSelect-select': {
        cursor: 'pointer',
        width: '100%',
      },
    });
    expect(props.slotProps).toMatchObject({
      input: {
        onMouseDown: expect.any(Function),
      },
      select: {
        SelectDisplayProps: {
          style: {
            cursor: 'pointer',
            width: '100%',
          },
        },
      },
    });
  });

  it('returns the same props for multi-select filters', () => {
    expect(getSharedFilterTextFieldProps('multi-select')).toEqual(getSharedFilterTextFieldProps('select'));
  });

  it('returns empty props for non-select filters', () => {
    expect(getSharedFilterTextFieldProps('text')).toMatchObject({
      sx: {
        '& .MuiInput-root': {
          pb: 0.75,
        },
        '& .MuiFormHelperText-root': {
          mt: 1,
        },
      },
      placeholder: 'Пошук',
      slotProps: {
        formHelperText: {
          sx: {
            mt: 0.25,
          },
        },
      },
    });
    expect(getSharedFilterTextFieldProps(undefined)).toMatchObject({
      sx: {
        '& .MuiInput-root': {
          pb: 0.75,
        },
        '& .MuiFormHelperText-root': {
          mt: 1,
        },
      },
      placeholder: 'Пошук',
      slotProps: {
        formHelperText: {
          sx: {
            mt: 0.25,
          },
        },
      },
    });
  });
});

describe('resolveExplicitSelectFilterValue', () => {
  it('returns the current string value when allowed', () => {
    expect(resolveExplicitSelectFilterValue('Усі', ['Усі', 'так', 'ні'], 'Усі')).toBe('Усі');
  });

  it('unwraps MRT array values and returns the first allowed value', () => {
    expect(resolveExplicitSelectFilterValue(['Відомий'], ['Відомий', 'В дорозвідці', 'Усі'], 'Відомий')).toBe('Відомий');
  });

  it('falls back when value is missing or unsupported', () => {
    expect(resolveExplicitSelectFilterValue(undefined, ['так', 'ні'], 'Усі')).toBe('Усі');
    expect(resolveExplicitSelectFilterValue('maybe', ['так', 'ні'], 'Усі')).toBe('Усі');
  });
});

describe('withExplicitSelectAllOption', () => {
  it('prepends the shared Усі option', () => {
    expect(withExplicitSelectAllOption([{ text: 'так', value: 'так' }])).toEqual([
      EXPLICIT_SELECT_ALL_OPTION,
      { text: 'так', value: 'так' },
    ]);
  });
});

describe('buildExplicitSingleSelectColumnFilter', () => {
  it('uses the fallback value when the column filter is empty', () => {
    const Filter = buildExplicitSingleSelectColumnFilter({
      options: withExplicitSelectAllOption([{ text: 'так', value: 'так' }]),
      fallbackValue: 'Усі',
      onChange: () => {},
    });

    const element = Filter({
      column: { getFilterValue: () => undefined } as any,
      header: {} as any,
      table: {} as any,
    });

    expect(element.props.value).toBe('Усі');
  });

  it('forwards the selected value to the provided callback', () => {
    const calls: string[] = [];
    const column = { getFilterValue: () => undefined } as any;
    const Filter = buildExplicitSingleSelectColumnFilter({
      options: withExplicitSelectAllOption([{ text: 'так', value: 'так' }]),
      fallbackValue: 'Усі',
      onChange: (_column, nextValue) => {
        calls.push(nextValue);
      },
    });

    const element = Filter({
      column,
      header: {} as any,
      table: {} as any,
    });

    element.props.onChange({ target: { value: 'так' } });

    expect(calls).toEqual(['так']);
  });
});

describe('getSharedSelectAllCheckboxProps', () => {
  it('disables select-all when the current row model has no selectable rows', () => {
    const props = getSharedSelectAllCheckboxProps({
      table: {
        getRowModel: () => ({
          rows: [
            { getCanSelect: () => false },
            { getCanSelect: () => false },
          ],
        }),
      } as any,
    });

    expect(props.disabled).toBe(true);
  });

  it('keeps select-all interactive when at least one row is selectable', () => {
    const props = getSharedSelectAllCheckboxProps({
      table: {
        getRowModel: () => ({
          rows: [
            { getCanSelect: () => false },
            { getCanSelect: () => true },
          ],
        }),
      } as any,
    });

    expect(props.disabled).toBe(false);
  });
});

describe('getDefaultMRTOptions', () => {
  it('wires the shared select-all checkbox props into MRT defaults', () => {
    const options = getDefaultMRTOptions<{ id: string }>();

    expect(options.muiSelectAllCheckboxProps).toBe(getSharedSelectAllCheckboxProps);
  });
});

describe('renderDefaultMrtEmptyRowsFallback', () => {
  it('shows the generic no-data message when no filters are active', () => {
    const element = renderDefaultMrtEmptyRowsFallback({
      table: {
        getState: () => ({ globalFilter: '', columnFilters: [] }),
        setColumnFilters: () => {},
        setGlobalFilter: () => {},
      } as any,
    });

    expect(element.props.children.props.message).toBe('Немає даних');
  });

  it('shows the filtered-empty message when filters are active', () => {
    const element = renderDefaultMrtEmptyRowsFallback({
      table: {
        getState: () => ({ globalFilter: 'abc', columnFilters: [] }),
        setColumnFilters: () => {},
        setGlobalFilter: () => {},
      } as any,
    });

    expect(element.props.children.props.message).toBe(EMPTY_STATE_NO_RESULTS_TEXT);
  });

  it('keeps the empty-state wrapper stretchable inside the table body', () => {
    const element = renderDefaultMrtEmptyRowsFallback({
      table: {
        getState: () => ({ globalFilter: '', columnFilters: [] }),
        setColumnFilters: () => {},
        setGlobalFilter: () => {},
      } as any,
    });

    expect(element.props.sx).toMatchObject({
      py: 6,
      minHeight: '100%',
      display: 'flex',
      flex: 1,
    });
  });

  it('honors an explicit external hasFilters override', () => {
    const element = renderDefaultMrtEmptyRowsFallback({
      table: {
        getState: () => ({ globalFilter: '', columnFilters: [] }),
        setColumnFilters: () => {},
        setGlobalFilter: () => {},
      } as any,
      hasFilters: true,
      filteredMessage: 'Filtered empty',
      clearFiltersLabel: 'Reset',
    });

    expect(element.props.children.props.message).toBe('Filtered empty');
    expect(element.props.children.props.actionLabel).toBe('Reset');
  });
});
