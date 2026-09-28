/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const powerAutocompleteSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Chip: ({ label, title }: { label?: ReactNode; title?: string }) => (
    <div title={title}>{label}</div>
  ),
  TextField: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
  Typography: ({ children, title }: { children: ReactNode; title?: string }) => (
    <span title={title}>{children}</span>
  ),
}));

vi.mock('../../../../components/PowerAutocomplete', () => ({
  PowerAutocomplete: (props: unknown) => {
    powerAutocompleteSpy(props);
    return <div data-testid="power-autocomplete" />;
  },
}));

import { AnalysisFilterField } from '.././AnalysisFilterField';
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
    return powerAutocompleteSpy.mock.calls.at(-1)?.[0] as {
      disableCloseOnSelect?: boolean;
      getOptionKey?: (option: { key: string }) => string;
      onChange: (
        _event: unknown,
        next: Array<{ value: string; label: string; count: number; values: string[] }>,
        reason: 'createOption' | 'selectOption' | 'removeOption' | 'blur' | 'clear' | 'escape',
      ) => void;
      onBulkPasteChange?: (
        next: Array<{ value: string; label: string; count: number; values: string[] }>,
      ) => void;
      bulkPasteSeparators?: string[];
      bulkPasteMenuLabel?: string;
      bulkPasteDialogTitle?: string;
      bulkPasteInputLabel?: string;
      onInputChange: (
        _event: unknown,
        nextInputValue: string,
        reason: 'input' | 'reset' | 'clear' | 'selectOption' | 'removeOption',
      ) => void;
      onClose?: () => void;
      onOpen?: () => void;
      filterOptions?: (
        options: Array<{ value: string; label: string; count: number; values: string[] }>,
      ) => Array<{ value: string; label: string; count: number; values: string[] }>;
      renderOption: (
        props: { key: string; [key: string]: unknown },
        option: { key: string; value: string; label: string; count: number; values: string[] },
      ) => unknown;
      renderTags: (
        value: Array<{
          key: string;
          value: string;
          label: string;
          count: number;
          values: string[];
        }>,
        getTagProps: (_args: { index: number }) => { key: string; [key: string]: unknown },
      ) => Array<{ props: { title?: string; label?: unknown } }>;
      options: Array<{ value: string; label: string; count: number; values: string[] }>;
      value: Array<{ value: string; label: string; count: number; values: string[] }>;
      loading?: boolean;
      loadingText?: string;
      noOptionsText?: string;
      inputValue?: string;
      open?: boolean;
    };
  }

  it('preserves typed input across loading and option refreshes', () => {
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [{ value: 'u1', label: 'Unit 1', count: 1 }],
      value: [],
      loading: false,
      onChange: vi.fn(),
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onInputChange(null, 'черга', 'input');
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      root.render(
        <AnalysisFilterField
          label="Підрозділи"
          options={[
            { value: 'u1', label: 'Unit 1', count: 1 },
            { value: 'u2', label: 'Unit 2', count: 2 },
          ]}
          value={[]}
          loading
          onChange={vi.fn()}
        />,
      );
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      root.render(
        <AnalysisFilterField
          label="Підрозділи"
          options={[
            { value: 'u1', label: 'Unit 1', count: 1 },
            { value: 'u3', label: 'Unit 3', count: 3 },
          ]}
          value={[]}
          loading={false}
          onChange={vi.fn()}
        />,
      );
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      root.unmount();
    });
  });

  it('ignores reset events so typed input survives option reloads', () => {
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [{ value: 'u1', label: 'Unit 1', count: 1 }],
      value: [],
      onChange: vi.fn(),
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onInputChange(null, 'черга', 'input');
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      props.onInputChange(null, '', 'reset');
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      props.onChange(null, [], 'clear');
    });
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('clears typed input after an explicit selection or clear action', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: 'Unit 1', count: 1 },
        { value: 'u2', label: 'Unit 2', count: 2 },
      ],
      value: ['u1'],
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onInputChange(null, 'черга', 'input');
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      props.onChange(null, [props.options[1]], 'selectOption');
    });
    expect(onChange).toHaveBeenCalledWith(['u2']);
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      props.onInputChange(null, 'черга', 'input');
    });
    expect(latestAutocompleteProps().inputValue).toBe('черга');

    act(() => {
      props.onChange(null, [], 'clear');
    });
    expect(onChange).toHaveBeenCalledWith([]);
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('keeps the unit menu and search text across multiple selections until close', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: '2 мсб 136 омсбр 58 А', count: 1 },
        { value: 'u2', label: '3 мсб 136 омсбр 58 А', count: 2 },
        { value: 'u3', label: '136 омсбр 58 А', count: 3 },
        { value: 'other', label: 'Other unit', count: 4 },
      ],
      value: [],
      deferredCommit: true,
      preserveInputOnSelect: true,
      onChange,
    });

    act(() => {
      latestAutocompleteProps().onOpen?.();
    });
    act(() => {
      latestAutocompleteProps().onInputChange(null, '136 омсбр', 'input');
    });
    act(() => {
      const props = latestAutocompleteProps();
      props.onChange(null, [props.options[0]], 'selectOption');
      props.onInputChange(null, '', 'selectOption');
    });
    expect(latestAutocompleteProps().open).toBe(true);
    expect(latestAutocompleteProps().inputValue).toBe('136 омсбр');
    expect(
      latestAutocompleteProps()
        .filterOptions?.(latestAutocompleteProps().options)
        .map((option) => option.value),
    ).toEqual(['u1', 'u2', 'u3']);

    act(() => {
      const props = latestAutocompleteProps();
      props.onChange(null, props.options.slice(0, 3), 'selectOption');
      props.onInputChange(null, '', 'selectOption');
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(latestAutocompleteProps().open).toBe(true);
    expect(latestAutocompleteProps().inputValue).toBe('136 омсбр');

    act(() => {
      latestAutocompleteProps().onClose?.();
    });
    expect(onChange).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('keeps multi-select edits local until close when deferred commit is enabled', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: 'Unit 1', count: 1 },
        { value: 'u2', label: 'Unit 2', count: 2 },
        { value: 'u3', label: 'Unit 3', count: 3 },
      ],
      value: ['u1'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    const openedProps = latestAutocompleteProps();
    act(() => {
      openedProps.onChange(
        null,
        [openedProps.options[0], openedProps.options[1], openedProps.options[2]],
        'selectOption',
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(latestAutocompleteProps().value.map((option) => option.value)).toEqual([
      'u1',
      'u2',
      'u3',
    ]);

    act(() => {
      props.onClose?.();
    });
    expect(onChange).toHaveBeenCalledWith(['u1', 'u2', 'u3']);

    act(() => {
      root.unmount();
    });
  });

  it('commits bulk paste immediately even when deferred commit is enabled', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Частоти',
      options: [
        { value: '111.1111', label: '111.1111', count: 1 },
        { value: '222.2222', label: '222.2222', count: 2 },
      ],
      value: ['111.1111'],
      deferredCommit: true,
      bulkPaste: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    const openedProps = latestAutocompleteProps();
    act(() => {
      openedProps.onBulkPasteChange?.([openedProps.options[0], openedProps.options[1]]);
    });

    expect(onChange).toHaveBeenCalledWith(['111.1111', '222.2222']);
    expect(latestAutocompleteProps().inputValue).toBe('');

    act(() => {
      openedProps.onClose?.();
    });

    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it('defers clear until close when the popup is open', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [{ value: 'u1', label: 'Unit 1', count: 1 }],
      value: ['u1'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    const openedProps = latestAutocompleteProps();
    act(() => {
      openedProps.onChange(null, [], 'clear');
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      openedProps.onClose?.();
    });
    expect(onChange).toHaveBeenCalledWith([]);

    act(() => {
      root.unmount();
    });
  });

  it('commits chip removal immediately when the popup is closed', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: 'Unit 1', count: 1 },
        { value: 'u2', label: 'Unit 2', count: 2 },
      ],
      value: ['u1', 'u2'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onChange(null, [props.options[1]], 'removeOption');
    });

    expect(onChange).toHaveBeenCalledWith(['u2']);

    act(() => {
      root.unmount();
    });
  });

  it('defers chip removal until close when the popup is open', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: 'Unit 1', count: 1 },
        { value: 'u2', label: 'Unit 2', count: 2 },
      ],
      value: ['u1', 'u2'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    const openedProps = latestAutocompleteProps();
    act(() => {
      openedProps.onChange(null, [openedProps.options[1]], 'removeOption');
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      openedProps.onClose?.();
    });
    expect(onChange).toHaveBeenCalledWith(['u2']);

    act(() => {
      root.unmount();
    });
  });

  it('keeps a cleared deferred selection empty when the menu closes', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [{ value: 'u1', label: 'Unit 1', count: 1 }],
      value: ['u1'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    act(() => {
      props.onChange(null, [], 'clear');
    });
    act(() => {
      props.onClose?.();
    });

    expect(onChange).toHaveBeenCalledWith([]);
    expect(onChange).not.toHaveBeenCalledWith(['u1']);

    act(() => {
      root.unmount();
    });
  });

  it('does not replay an older draft after a deferred chip removal commits', () => {
    const onChange = vi.fn();
    const { root } = renderFilterField({
      label: 'Підрозділи',
      options: [
        { value: 'u1', label: 'Unit 1', count: 1 },
        { value: 'u2', label: 'Unit 2', count: 2 },
      ],
      value: ['u1', 'u2'],
      deferredCommit: true,
      onChange,
    });
    const props = latestAutocompleteProps();

    act(() => {
      props.onOpen?.();
    });
    act(() => {
      props.onChange(null, [props.options[1]], 'removeOption');
    });
    act(() => {
      props.onClose?.();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['u2']);

    act(() => {
      root.unmount();
    });
  });
});
