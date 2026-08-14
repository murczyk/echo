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
    return <div />;
  },
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: () => <input />,
  ToggleButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  ToggleButtonGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';

describe('FeedFilterSelectionSection', () => {
  function latestAutocompleteProps() {
    return autocompleteSpy.mock.calls.at(-1)?.[0] as {
      disableCloseOnSelect?: boolean;
      inputValue?: string;
      onChange: (
        event: unknown,
        value: string[],
        reason: 'selectOption' | 'removeOption' | 'clear',
      ) => void;
      onInputChange: (
        event: unknown,
        value: string,
        reason: 'input' | 'reset' | 'clear' | 'selectOption' | 'removeOption',
      ) => void;
      onClose: () => void;
      filterOptions?: (options: string[]) => string[];
    };
  }

  it('keeps the unit menu and search text across multiple selections until close or clear', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onValueChange = vi.fn();
    act(() => {
      root.render(
        <FeedFilterSelectionSection
          title="Підрозділи"
          mode="include"
          onModeChange={vi.fn()}
          value={[]}
          onValueChange={onValueChange}
          options={['2 мсб 136 омсбр 58 А', '3 мсб 136 омсбр 58 А', '136 омсбр 58 А', '58 А']}
          getOptionLabel={(option) => option}
          rankedSearch
          keepOpenAndPreserveInputOnSelect
        />,
      );
    });

    act(() => {
      latestAutocompleteProps().onInputChange(null, '136 омсбр', 'input');
    });
    act(() => {
      const props = latestAutocompleteProps();
      props.onChange(null, ['2 мсб 136 омсбр 58 А'], 'selectOption');
      props.onInputChange(null, '', 'selectOption');
    });
    expect(
      latestAutocompleteProps().filterOptions?.(['3 мсб 136 омсбр 58 А', '136 омсбр 58 А', '58 А']),
    ).toEqual(['136 омсбр 58 А', '3 мсб 136 омсбр 58 А']);
    act(() => {
      const props = latestAutocompleteProps();
      props.onChange(null, ['2 мсб 136 омсбр 58 А', '3 мсб 136 омсбр 58 А'], 'selectOption');
      props.onInputChange(null, '', 'selectOption');
    });

    expect(onValueChange).toHaveBeenLastCalledWith([
      '2 мсб 136 омсбр 58 А',
      '3 мсб 136 омсбр 58 А',
    ]);
    expect(latestAutocompleteProps().disableCloseOnSelect).toBe(true);
    expect(latestAutocompleteProps().inputValue).toBe('136 омсбр');

    act(() => {
      latestAutocompleteProps().onClose();
    });
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      latestAutocompleteProps().onInputChange(null, '58', 'input');
      latestAutocompleteProps().onInputChange(null, '', 'clear');
    });
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('keeps the groups menu open and clears its query after each selection', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onValueChange = vi.fn();
    act(() => {
      root.render(
        <FeedFilterSelectionSection
          title="Групи"
          mode="include"
          onModeChange={vi.fn()}
          value={[]}
          onValueChange={onValueChange}
          options={['A', 'B', 'C']}
          getOptionLabel={(option) => option}
          keepOpenOnSelect
        />,
      );
    });

    act(() => {
      const props = latestAutocompleteProps();
      props.onInputChange(null, 'A', 'input');
      props.onChange(null, ['A'], 'selectOption');
    });

    expect(onValueChange).toHaveBeenCalledWith(['A']);
    expect(latestAutocompleteProps().disableCloseOnSelect).toBe(true);
    expect(latestAutocompleteProps().inputValue).toBe('');
    act(() => root.unmount());
  });
});
