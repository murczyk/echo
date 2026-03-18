/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  EXPLICIT_SELECT_ALL_OPTION,
  buildExplicitSingleSelectColumnFilter,
  getSharedFilterTextFieldProps,
  resolveExplicitSelectFilterValue,
  withExplicitSelectAllOption,
} from './get-default-table-options';

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
    expect(getSharedFilterTextFieldProps('text')).toEqual({});
    expect(getSharedFilterTextFieldProps(undefined)).toEqual({});
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
