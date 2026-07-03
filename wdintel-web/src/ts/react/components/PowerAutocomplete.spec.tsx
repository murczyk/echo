/**
 * @vitest-environment happy-dom
 */
import { act, createElement, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TextFieldProps = {
  label?: ReactNode;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  onPaste?: (event: {
    clipboardData: { getData: (type: string) => string };
    preventDefault: () => void;
  }) => void;
  onChange?: (event: { target: { value: string } }) => void;
  inputProps?: {
    onPaste?: (event: {
      clipboardData: { getData: (type: string) => string };
      preventDefault: () => void;
    }) => void;
  };
};

type PaperComponent = (props: { children?: ReactNode }) => ReactNode;
type BoxProps = {
  onMouseDown?: (event: { preventDefault: () => void }) => void;
  children?: ReactNode;
  'data-bulk-paste-container'?: string;
};

let latestAutocompleteProps: {
  PaperComponent?: PaperComponent;
  renderInput?: (params: unknown) => ReactNode;
  value?: unknown;
  loading?: boolean;
  getOptionLabel?: (option: unknown) => string;
  isOptionEqualToValue?: (option: unknown, value: unknown) => boolean;
  onChange?: (...args: unknown[]) => void;
  onClose?: (event: unknown, reason: string) => void;
} | null = null;
let latestRenderInputParams: { inputProps?: { onPaste?: (event: unknown) => void } } | null = null;
let textFieldProps: TextFieldProps[] = [];
let boxProps: BoxProps[] = [];

vi.mock('@mui/material', () => ({
  Autocomplete: (props: {
    PaperComponent?: PaperComponent;
    renderInput?: (params: unknown) => ReactNode;
    value?: unknown;
    loading?: boolean;
    getOptionLabel?: (option: unknown) => string;
    isOptionEqualToValue?: (option: unknown, value: unknown) => boolean;
    onChange?: (...args: unknown[]) => void;
    onClose?: (event: unknown, reason: string) => void;
  }) => {
    latestAutocompleteProps = props;
    latestRenderInputParams = { inputProps: {} };
    return <div>{props.renderInput?.(latestRenderInputParams as never)}</div>;
  },
  Box: forwardRef<HTMLDivElement, BoxProps>((props, ref) => {
    boxProps.push(props);
    return (
      <div ref={ref} data-bulk-paste-container={props['data-bulk-paste-container']}>
        {props.children}
      </div>
    );
  }),
  Paper: forwardRef<HTMLDivElement, { children: ReactNode }>((props, ref) => (
    <div ref={ref}>{props.children}</div>
  )),
  TextField: (props: TextFieldProps) => {
    textFieldProps.push(props);
    return (
      <input
        aria-label={String(props.label ?? props.placeholder ?? 'input')}
        placeholder={props.placeholder}
        disabled={props.disabled}
        value={props.value ?? ''}
        onPaste={props.onPaste as never}
        onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
      />
    );
  },
}));

import { PowerAutocomplete } from './PowerAutocomplete';

type Option = {
  id: string;
  label: string;
};

type Rendered = {
  root: Root;
  container: HTMLDivElement;
};

const options: Option[] = [
  { id: '111.1111', label: '111.1111' },
  { id: '222.2222', label: '222.2222' },
];

const rendered: Rendered[] = [];

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
  latestAutocompleteProps = null;
  latestRenderInputParams = null;
  textFieldProps = [];
  boxProps = [];
  vi.clearAllMocks();
});

function renderAutocomplete(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onBulkPasteChange = vi.fn();
  const onBulkPasteResolved = vi.fn();
  const onClose = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <PowerAutocomplete<Option>
        options={options}
        value={[]}
        onChange={onChange}
        onClose={onClose}
        onBulkPasteChange={onBulkPasteChange}
        onBulkPasteResolved={onBulkPasteResolved}
        getOptionLabel={(option) => option.label}
        renderInput={(params) => <input data-testid="main-input" {...(params as never)} />}
        {...(overrides as never)}
      />,
    );
  });

  rendered.push({ root, container });
  return { onChange, onBulkPasteChange, onBulkPasteResolved, onClose };
}

function renderPopup(children: ReactNode = <ul data-testid="options" />) {
  const PaperComponent = latestAutocompleteProps?.PaperComponent;
  if (!PaperComponent) throw new Error('PaperComponent not available');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(createElement(PaperComponent, null, children));
  });

  rendered.push({ root, container });
}

function getBulkTextField(): TextFieldProps {
  const bulkTextField = [...textFieldProps]
    .reverse()
    .find((props) => props.placeholder?.includes('Вставте'));
  if (!bulkTextField) throw new Error('Bulk text field not found');
  return bulkTextField;
}

function pasteBulkValue(
  value: string,
  options: { route?: 'onPaste' | 'inputProps' | 'both' } = {},
) {
  const bulkTextField = getBulkTextField();
  const event = {
    defaultPrevented: false,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
    clipboardData: {
      getData: () => value,
    },
  };

  act(() => {
    if (options.route === 'onPaste' || options.route === 'both' || options.route === undefined) {
      bulkTextField.onPaste?.(event);
    }
    if (options.route === 'inputProps' || options.route === 'both' || options.route === undefined) {
      bulkTextField.inputProps?.onPaste?.(event);
    }
  });

  return event;
}

describe('PowerAutocomplete', () => {
  it('does not intercept native input paste', () => {
    renderAutocomplete({ bulkPaste: true });

    expect(latestRenderInputParams?.inputProps?.onPaste).toBeUndefined();
    expect(textFieldProps).toHaveLength(0);
  });

  it('renders the bulk field only inside the popup paper', () => {
    renderAutocomplete({ bulkPaste: true });
    expect(textFieldProps).toHaveLength(0);

    renderPopup();
    expect(boxProps.some((props) => props['data-bulk-paste-container'] === 'true')).toBe(true);
    expect(textFieldProps).toHaveLength(1);
    expect(getBulkTextField().placeholder).toBe('Вставте значення через ","');
  });

  it('forwards a caller paper component when bulk paste is disabled', () => {
    const callerPaperComponent = vi.fn(({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ));

    renderAutocomplete({ bulkPaste: false, PaperComponent: callerPaperComponent });

    expect(latestAutocompleteProps?.PaperComponent).toBe(callerPaperComponent);
  });

  it('uses the bulk paste paper when bulk paste is enabled', () => {
    const callerPaperComponent = vi.fn(({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ));

    renderAutocomplete({ bulkPaste: true, PaperComponent: callerPaperComponent });

    expect(latestAutocompleteProps?.PaperComponent).not.toBe(callerPaperComponent);
  });

  it('forwards controlled autocomplete props to MUI', () => {
    const isOptionEqualToValue = vi.fn();
    const getOptionLabel = vi.fn((option: Option) => option.label);
    const onChange = vi.fn();

    renderAutocomplete({
      bulkPaste: true,
      value: [options[0]],
      loading: true,
      getOptionLabel,
      isOptionEqualToValue,
      onChange,
    });

    expect(latestAutocompleteProps?.value).toEqual([options[0]]);
    expect(latestAutocompleteProps?.loading).toBe(true);
    expect(latestAutocompleteProps?.getOptionLabel).toBe(getOptionLabel);
    expect(latestAutocompleteProps?.isOptionEqualToValue).toBe(isOptionEqualToValue);
    expect(latestAutocompleteProps?.onChange).toBe(onChange);
  });

  it('does not block mousedown on the bulk field wrapper', () => {
    renderAutocomplete({ bulkPaste: true });
    renderPopup();

    const bulkBox = boxProps.find((props) => props['data-bulk-paste-container'] === 'true');
    expect(bulkBox?.onMouseDown).toBeUndefined();
  });

  it('keeps the popup open for blur into the bulk field', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true });
    renderPopup();

    const popupContainer = rendered.at(-1)?.container;
    const bulkInput = popupContainer?.querySelector('input');
    const bulkWrapper = bulkInput?.parentElement;
    if (!bulkWrapper) throw new Error('Bulk wrapper not found');

    act(() => {
      latestAutocompleteProps?.onClose?.({ relatedTarget: bulkWrapper } as never, 'blur');
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('forwards blur close events outside the bulk field', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true });
    renderPopup();

    act(() => {
      latestAutocompleteProps?.onClose?.(
        { relatedTarget: document.createElement('button') } as never,
        'blur',
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('forwards non-blur close events', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true });
    renderPopup();

    act(() => {
      latestAutocompleteProps?.onClose?.({} as never, 'escape');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on outside pointer down while controlled open', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true, open: true });
    renderPopup();
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);

    act(() => {
      outsideButton.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on pointer down inside the autocomplete root', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true, open: true });
    const mainInput = rendered.at(-1)?.container.querySelector('input');
    if (!mainInput) throw new Error('Main input not found');

    act(() => {
      mainInput.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on pointer down inside the popup paper', () => {
    const { onClose } = renderAutocomplete({ bulkPaste: true, open: true });
    renderPopup();
    const bulkInput = rendered.at(-1)?.container.querySelector('input');
    if (!bulkInput) throw new Error('Bulk input not found');

    act(() => {
      bulkInput.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('formats the placeholder by separators', () => {
    renderAutocomplete({ bulkPaste: true, bulkPasteSeparators: [',', ';'] });
    renderPopup();

    expect(getBulkTextField().placeholder).toBe('Вставте значення через "," або ";"');
  });

  it('uses the newline-aware placeholder when separators include line breaks', () => {
    renderAutocomplete({ bulkPaste: true, bulkPasteSeparators: [',', '\n'] });
    renderPopup();

    expect(getBulkTextField().placeholder).toBe('Вставте CSV або список з нового рядка');
  });

  it('processes newline-separated paste from the popup bulk field', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteSeparators: [',', '\n'],
    });
    renderPopup();
    const event = pasteBulkValue('111.1111\n222.2222', { route: 'both' });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.1111', '222.2222'],
      found: [options[0], options[1]],
      missing: [],
      added: [options[0], options[1]],
      alreadySelected: [],
      finalValue: [options[0], options[1]],
    });
    expect(onBulkPasteChange).toHaveBeenCalledWith([options[0], options[1]]);
  });

  it('processes CSV paste from the popup bulk field', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('111.1111,222.2222');
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.1111', '222.2222'],
      found: [options[0], options[1]],
      missing: [],
      added: [options[0], options[1]],
      alreadySelected: [],
      finalValue: [options[0], options[1]],
    });
    expect(onBulkPasteChange).toHaveBeenCalledWith([options[0], options[1]]);
    expect(getBulkTextField().value).toBe('');
  });

  it('keeps missing tokens visible after a mixed paste', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('111.1111,BAD');
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.1111', 'BAD'],
      found: [options[0]],
      missing: ['BAD'],
      added: [options[0]],
      alreadySelected: [],
      finalValue: [options[0]],
    });
    expect(onBulkPasteChange).toHaveBeenCalledWith([options[0]]);
    expect(getBulkTextField().value).toBe('BAD');
  });

  it('keeps all-missing paste visible without changing selection', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('BAD,UGLY');
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['BAD', 'UGLY'],
      found: [],
      missing: ['BAD', 'UGLY'],
      added: [],
      alreadySelected: [],
      finalValue: [],
    });
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(getBulkTextField().value).toBe('BAD,UGLY');
  });

  it('keeps single-token paste visible in the bulk field', () => {
    const { onBulkPasteChange } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('111.1111', { route: 'both' });
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(getBulkTextField().value).toBe('111.1111');
  });

  it('keeps wrong-separator paste visible in the bulk field', () => {
    const { onBulkPasteChange } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('111.1111;222.2222', { route: 'both' });
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(getBulkTextField().value).toBe('111.1111;222.2222');
  });

  it('keeps loading paste visible without selecting options', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({
      bulkPaste: true,
      loading: true,
    });
    renderPopup();
    const event = pasteBulkValue('111.1111,222.2222', { route: 'both' });
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(onBulkPasteResolved).not.toHaveBeenCalled();
    expect(getBulkTextField().value).toBe('111.1111,222.2222');
  });

  it('does not duplicate bulk paste handling when both handlers are wired', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    const event = pasteBulkValue('111.1111,222.2222', { route: 'both' });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteResolved).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).toHaveBeenCalledTimes(1);
    expect(getBulkTextField().value).toBe('');
  });

  it('preserves existing selections and leaves missing tokens visible', () => {
    const { onBulkPasteChange } = renderAutocomplete({
      bulkPaste: true,
      value: [options[0]],
    });
    renderPopup();
    const event = pasteBulkValue('111.1111,111.1111,BAD');
    renderPopup();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(getBulkTextField().value).toBe('BAD');
  });

  it('does not select fuzzy matches', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({ bulkPaste: true });
    renderPopup();
    pasteBulkValue('111.111,222.2222');

    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.111', '222.2222'],
      found: [options[1]],
      missing: ['111.111'],
      added: [options[1]],
      alreadySelected: [],
      finalValue: [options[1]],
    });
    expect(onBulkPasteChange).toHaveBeenCalledWith([options[1]]);
  });

  it('keeps native search behavior untouched', () => {
    renderAutocomplete({ bulkPaste: true });

    expect(latestRenderInputParams?.inputProps?.onPaste).toBeUndefined();
  });

  it('disables bulk resolution while loading', () => {
    const { onBulkPasteChange, onBulkPasteResolved } = renderAutocomplete({
      bulkPaste: true,
      loading: true,
    });
    renderPopup();
    const event = pasteBulkValue('111.1111,222.2222');

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
    expect(onBulkPasteResolved).not.toHaveBeenCalled();
  });
});
