/**
 * @vitest-environment happy-dom
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const autocompleteSpy = vi.fn();
let toggleGroupOnChange: ((event: unknown, value: string | null) => void) | undefined;
let bulkDialogInputOnChange: ((value: string) => void) | undefined;

vi.mock('@mui/material', () => ({
  Autocomplete: (props: {
    value?: string[];
    renderInput?: (params: { InputProps: { endAdornment: ReactNode } }) => ReactNode;
  }) => {
    autocompleteSpy(props);
    return (
      <div>
        <div data-testid="frequency-chips">{props.value?.join(',')}</div>
        {props.renderInput?.({ InputProps: { endAdornment: null } })}
      </div>
    );
  },
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="bulk-dialog">{children}</div> : null,
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  TextField: ({
    InputProps,
    fullWidth: _fullWidth,
    label: _label,
    minRows: _minRows,
    multiline,
    onChange,
    ...props
  }: {
    InputProps?: { endAdornment?: ReactNode };
    fullWidth?: boolean;
    label?: string;
    minRows?: number;
    multiline?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
  }) => {
    if (multiline) {
      bulkDialogInputOnChange = (value) => onChange?.({ target: { value } });
    }
    return (
      <div>
        <input {...props} onChange={onChange} />
        {InputProps?.endAdornment}
      </div>
    );
  },
  ToggleButton: ({ children, selected }: { children: ReactNode; selected?: boolean }) => (
    <button data-selected={selected}>{children}</button>
  ),
  ToggleButtonGroup: ({
    children,
    value,
    onChange,
  }: {
    children: ReactNode;
    value: string;
    onChange: (event: unknown, value: string | null) => void;
  }) => {
    toggleGroupOnChange = onChange;
    return (
      <div>
        {Children.map(children, (child) =>
          cloneElement(child as ReactElement<{ value?: string }>, {
            selected: isValidElement(child) && child.props.value === value,
          }),
        )}
      </div>
    );
  },
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../components/PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../../../components/PowerButton', () => ({
  PowerButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock('../../../components/PowerIconButton', () => ({
  PowerIconButton: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode;
    onClick: () => void;
  }) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@mui/icons-material/MoreVert', () => ({ default: () => <span /> }));

import { FeedFilterSelectionSection } from '.././FeedFilterSelectionSection';
import { useFeedFilterSelectionState } from '.././useFeedFilterSelectionState';

function DutyFrequencyHarness({
  initialInclude,
  initialExclude,
}: {
  initialInclude: string[];
  initialExclude: string[];
}) {
  const [freqsSelected, setFreqsSelected] = useState(initialInclude);
  const [freqsDenied, setFreqsDenied] = useState(initialExclude);
  const state = useFeedFilterSelectionState({
    includeValues: freqsSelected,
    excludeValues: freqsDenied,
    onIncludeChange: setFreqsSelected,
    onExcludeChange: setFreqsDenied,
    onModeTransfer: ({ includeValues, excludeValues }) => {
      setFreqsSelected(includeValues);
      setFreqsDenied(excludeValues);
    },
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });

  return (
    <>
      <output data-testid="frequency-mode">{state.mode}</output>
      <output data-testid="frequency-selected">{freqsSelected.join(',')}</output>
      <output data-testid="frequency-denied">{freqsDenied.join(',')}</output>
      <FeedFilterSelectionSection
        title="Частота"
        mode={state.mode}
        onModeChange={state.setMode}
        value={state.localValue}
        onValueChange={state.setLocalValue}
        options={['153.6250', '154.0000', '155.3750']}
        getOptionLabel={(option) => option}
      />
    </>
  );
}

function DutyFrequencyColumnsHarness() {
  const columnAFrequencies = ['153.6250', '154.0000'];
  const [columnBInclude, setColumnBInclude] = useState<string[]>([]);
  const [columnBExclude, setColumnBExclude] = useState<string[]>([]);
  const columnBState = useFeedFilterSelectionState({
    includeValues: columnBInclude,
    excludeValues: columnBExclude,
    onIncludeChange: setColumnBInclude,
    onExcludeChange: setColumnBExclude,
    onModeTransfer: ({ includeValues, excludeValues }) => {
      setColumnBInclude(includeValues);
      setColumnBExclude(excludeValues);
    },
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });

  return (
    <>
      <output data-testid="column-a-frequencies">{columnAFrequencies.join(',')}</output>
      <output data-testid="column-b-frequencies">{columnBInclude.join(',')}</output>
      <FeedFilterSelectionSection
        title="Частота A"
        mode="include"
        onModeChange={() => {}}
        value={columnAFrequencies}
        onValueChange={() => {}}
        options={['153.6250', '154.0000', '155.3750']}
        getOptionLabel={(option) => option}
      />
      <FeedFilterSelectionSection
        title="Частота B"
        mode={columnBState.mode}
        onModeChange={columnBState.setMode}
        value={columnBState.localValue}
        onValueChange={columnBState.setLocalValue}
        options={['153.6250', '154.0000', '155.3750']}
        getOptionLabel={(option) => option}
        bulkPaste
        bulkPasteSeparators={[',', '\n']}
      />
    </>
  );
}
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
    const onInputChange = vi.fn();
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
          onInputChange={onInputChange}
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
    expect(onInputChange).not.toHaveBeenCalledWith('');

    act(() => {
      latestAutocompleteProps().onClose();
    });
    expect(latestAutocompleteProps().inputValue).toBe('');
    expect(onInputChange).toHaveBeenLastCalledWith('');
    expect(onInputChange.mock.calls.filter(([value]) => value === '')).toHaveLength(1);

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

  it('propagates one empty query after a clear-on-select selection', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onInputChange = vi.fn();
    act(() => {
      root.render(
        <FeedFilterSelectionSection
          title="Пристрої"
          mode="include"
          onModeChange={vi.fn()}
          value={[]}
          onValueChange={vi.fn()}
          options={['A']}
          getOptionLabel={(option) => option}
          keepOpenOnSelect
          onInputChange={onInputChange}
        />,
      );
    });
    act(() => {
      const props = latestAutocompleteProps();
      props.onInputChange(null, 'A', 'input');
      props.onChange(null, ['A'], 'selectOption');
      props.onInputChange(null, '', 'selectOption');
      props.onInputChange(null, '', 'reset');
    });
    expect(onInputChange.mock.calls.map(([value]) => value)).toEqual(['A', '']);
    act(() => root.unmount());
  });

  it('transfers frequency chips through the real mode toggle handler', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onModeChange = vi.fn();
    const onValueChange = vi.fn();
    const frequencies = ['153.6250', '154.0000'];

    act(() => {
      root.render(
        <FeedFilterSelectionSection
          title="Частота"
          mode="include"
          onModeChange={onModeChange}
          value={frequencies}
          onValueChange={onValueChange}
          options={frequencies}
          getOptionLabel={(option) => option}
        />,
      );
    });

    expect(container.querySelector('[data-selected="true"]')?.textContent).toBe('лише');
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      frequencies.join(','),
    );

    act(() => toggleGroupOnChange?.(null, 'exclude'));

    expect(onModeChange).toHaveBeenCalledWith('exclude');
    act(() => {
      root.render(
        <FeedFilterSelectionSection
          title="Частота"
          mode="exclude"
          onModeChange={onModeChange}
          value={frequencies}
          onValueChange={onValueChange}
          options={frequencies}
          getOptionLabel={(option) => option}
        />,
      );
    });
    expect(container.querySelector('[data-selected="true"]')?.textContent).toBe('окрім');
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      frequencies.join(','),
    );
    act(() => root.unmount());
  });

  it('transfers Duty frequency state in both directions without clearing chips', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const frequencies = ['153.6250', '154.0000'];

    act(() =>
      root.render(<DutyFrequencyHarness initialInclude={frequencies} initialExclude={[]} />),
    );
    expect(container.querySelector('[data-testid="frequency-mode"]')?.textContent).toBe('include');
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      frequencies.join(','),
    );
    act(() => toggleGroupOnChange?.(null, 'exclude'));
    expect(container.querySelector('[data-testid="frequency-mode"]')?.textContent).toBe('exclude');
    expect(container.querySelector('[data-testid="frequency-selected"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="frequency-denied"]')?.textContent).toBe(
      frequencies.join(','),
    );
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      frequencies.join(','),
    );

    act(() =>
      root.render(<DutyFrequencyHarness initialInclude={[]} initialExclude={frequencies} />),
    );
    act(() => toggleGroupOnChange?.(null, 'include'));
    expect(container.querySelector('[data-testid="frequency-mode"]')?.textContent).toBe('include');
    expect(container.querySelector('[data-testid="frequency-selected"]')?.textContent).toBe(
      frequencies.join(','),
    );
    expect(container.querySelector('[data-testid="frequency-denied"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      frequencies.join(','),
    );
    act(() => root.unmount());
  });

  it('routes Duty bulk confirmation values to only the active exclude list', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initialExclude = ['153.6250'];
    const pastedValues = ['153.6250', '154.0000', '155.3750'];

    act(() =>
      root.render(<DutyFrequencyHarness initialInclude={[]} initialExclude={initialExclude} />),
    );
    act(() => {
      latestAutocompleteProps().onChange(null, pastedValues, 'selectOption');
    });

    expect(container.querySelector('[data-testid="frequency-mode"]')?.textContent).toBe('exclude');
    expect(container.querySelector('[data-testid="frequency-selected"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="frequency-denied"]')?.textContent).toBe(
      pastedValues.join(','),
    );
    expect(container.querySelector('[data-testid="frequency-chips"]')?.textContent).toBe(
      pastedValues.join(','),
    );
    act(() => root.unmount());
  });

  it('adds copied newline frequencies to a second Duty column through PowerAutocomplete', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const copiedPayload = '153.6250\n154.0000';

    act(() => root.render(<DutyFrequencyColumnsHarness />));
    const bulkMenuButton = container.querySelector('button[aria-label="Додати кілька значень"]');
    if (!bulkMenuButton) throw new Error('Bulk paste menu button not found');
    act(() => {
      bulkMenuButton.click();
    });
    const bulkMenuItem = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати кілька значень',
    );
    if (!bulkMenuItem) throw new Error('Bulk paste menu item not found');
    act(() => {
      bulkMenuItem.click();
    });
    if (!bulkDialogInputOnChange) throw new Error('Bulk paste input handler not found');
    act(() => {
      bulkDialogInputOnChange(copiedPayload);
    });
    const submitButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати',
    );
    if (!submitButton) throw new Error('Bulk paste submit button not found');
    act(() => {
      submitButton.click();
    });

    expect(container.querySelector('[data-testid="column-a-frequencies"]')?.textContent).toBe(
      '153.6250,154.0000',
    );
    expect(container.querySelector('[data-testid="column-b-frequencies"]')?.textContent).toBe(
      '153.6250,154.0000',
    );
    act(() => root.unmount());
  });
});
