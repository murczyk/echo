/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TextFieldProps = {
  label?: ReactNode;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  multiline?: boolean;
  minRows?: number;
  onChange?: (event: { target: { value: string } }) => void;
  onPaste?: (event: {
    clipboardData: { getData: (type: string) => string };
    preventDefault: () => void;
  }) => void;
  inputProps?: {
    onPaste?: (event: {
      clipboardData: { getData: (type: string) => string };
      preventDefault: () => void;
    }) => void;
  };
};

type PaperComponent = (props: { children?: ReactNode }) => ReactNode;
type PopperComponent = (props: { children?: ReactNode }) => ReactNode;

type AutocompletePropsCapture = {
  PaperComponent?: PaperComponent;
  PopperComponent?: PopperComponent;
  renderInput?: (params: unknown) => ReactNode;
  sx?: unknown;
  value?: unknown;
  loading?: boolean;
  getOptionLabel?: (option: unknown) => string;
  isOptionEqualToValue?: (option: unknown, value: unknown) => boolean;
  onChange?: (...args: unknown[]) => void;
  onClose?: (event: unknown, reason: string) => void;
};

type PowerIconButtonProps = {
  'aria-label'?: string;
  children?: ReactNode;
  disabled?: boolean;
  onClick?: (event: {
    currentTarget: HTMLButtonElement;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void;
  onMouseDown?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  size?: string;
};

type PowerMenuProps = {
  anchorEl?: HTMLElement | null;
  children?: ReactNode;
  open?: boolean;
  onClose?: () => void;
};

type PowerButtonProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
};

let latestAutocompleteProps: AutocompletePropsCapture | null = null;
let latestRenderInputParams: {
  InputProps?: { endAdornment?: ReactNode };
  inputProps?: { onPaste?: () => void };
} | null = null;
let textFieldProps: TextFieldProps[] = [];
let powerMenuProps: PowerMenuProps[] = [];

vi.mock('@mui/material', () => ({
  Autocomplete: (props: AutocompletePropsCapture) => {
    latestAutocompleteProps = props;
    const params = { InputProps: { endAdornment: <span /> }, inputProps: {} };
    latestRenderInputParams = params;
    return <div>{props.renderInput?.(params)}</div>;
  },
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  InputAdornment: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  TextField: (props: TextFieldProps) => {
    textFieldProps.push(props);
    const fieldProps = {
      'aria-label': String(props.label ?? props.placeholder ?? 'input'),
      placeholder: props.placeholder,
      disabled: props.disabled,
      value: props.value ?? '',
      onChange: (event: { currentTarget: { value: string } }) =>
        props.onChange?.({ target: { value: event.currentTarget.value } }),
      onPaste: props.onPaste as never,
    };

    return (
      <label>
        <span>{props.label}</span>
        {props.multiline ? <textarea {...fieldProps} /> : <input {...fieldProps} />}
      </label>
    );
  },
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/MoreVert', () => ({
  default: () => <span data-testid="more-vert-icon" />,
}));

vi.mock('./PowerIconButton', () => ({
  PowerIconButton: (props: PowerIconButtonProps) => {
    return (
      <button
        type="button"
        aria-label={props['aria-label']}
        disabled={props.disabled}
        onMouseDown={props.onMouseDown as never}
        onClick={() =>
          props.onClick?.({
            currentTarget: document.createElement('button'),
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
          })
        }
      >
        {props.children}
      </button>
    );
  },
}));

vi.mock('./PowerMenu', () => ({
  PowerMenu: (props: PowerMenuProps) => {
    powerMenuProps.push(props);
    return props.open ? <div data-testid="bulk-menu">{props.children}</div> : null;
  },
}));

vi.mock('./PowerButton', () => ({
  PowerButton: (props: PowerButtonProps) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
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
  powerMenuProps = [];
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
        renderInput={(params) => (
          <div data-testid="input-root">
            <input data-testid="main-input" />
            <span data-testid="end-adornment">
              {(params as { InputProps?: { endAdornment?: ReactNode } }).InputProps?.endAdornment}
            </span>
          </div>
        )}
        {...(overrides as never)}
      />,
    );
  });

  rendered.push({ root, container });
  return { onChange, onBulkPasteChange, onBulkPasteResolved, onClose, container };
}

function getBulkMenuButton(
  container: HTMLElement,
  label: string = 'Додати кілька значень',
): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`);
}

function getBulkDialogInput(container: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const input = container.querySelector(
    'input[aria-label="Частоти"], textarea[aria-label="Частоти"]',
  );
  if (!input) throw new Error('Dialog input not found');
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function openBulkDialog(container: HTMLElement, label?: string) {
  const menuButton = getBulkMenuButton(container, label);
  if (!menuButton) throw new Error('Bulk menu button not found');

  act(() => {
    menuButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    menuButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  const menuItem = container.querySelector('[data-testid="bulk-menu"] button');
  if (!menuItem) throw new Error('Bulk menu item not found');

  act(() => {
    menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeDialogValue(container: HTMLElement, value: string) {
  const dialogTextField = textFieldProps.at(-1);
  if (!dialogTextField?.onChange) {
    throw new Error('Dialog onChange not found');
  }
  act(() => {
    dialogTextField.onChange?.({ target: { value } });
  });
}

describe('PowerAutocomplete', () => {
  it('does not add the bulk menu when disabled', () => {
    const { container } = renderAutocomplete({ bulkPaste: false });

    expect(getBulkMenuButton(container)).toBeNull();
  });

  it('adds the bulk menu button inside the input adornment when enabled', () => {
    const { container } = renderAutocomplete({ bulkPaste: true });

    expect(getBulkMenuButton(container)).not.toBeNull();
  });

  it('adds bulk adornment styles while preserving caller sx', () => {
    const callerSx = { minWidth: 240 };

    renderAutocomplete({ bulkPaste: true, sx: callerSx });

    expect(latestAutocompleteProps?.sx).toEqual([
      expect.objectContaining({
        '& .MuiAutocomplete-endAdornment': expect.objectContaining({
          display: 'flex',
          alignItems: 'center',
        }),
        '& .MuiAutocomplete-clearIndicator': expect.objectContaining({
          display: 'none',
        }),
        '&:hover .MuiAutocomplete-clearIndicator, &.Mui-focused .MuiAutocomplete-clearIndicator':
          expect.objectContaining({
            display: 'inline-flex',
          }),
      }),
      callerSx,
    ]);
  });

  it('does not add bulk adornment styles when disabled', () => {
    const callerSx = { minWidth: 240 };

    renderAutocomplete({ bulkPaste: false, sx: callerSx });

    expect(latestAutocompleteProps?.sx).toBe(callerSx);
  });

  it('uses generic default labels for the bulk flow', () => {
    const { container } = renderAutocomplete({ bulkPaste: true });

    openBulkDialog(container);

    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Додати кілька значень');
    expect(container.textContent).toContain('Додати');
  });

  it('forwards caller paper and popper components unchanged', () => {
    const callerPaperComponent = vi.fn(({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ));
    const callerPopperComponent = vi.fn(({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ));

    renderAutocomplete({
      bulkPaste: true,
      PaperComponent: callerPaperComponent,
      PopperComponent: callerPopperComponent,
    });

    expect(latestAutocompleteProps?.PaperComponent).toBe(callerPaperComponent);
    expect(latestAutocompleteProps?.PopperComponent).toBe(callerPopperComponent);
  });

  it('keeps native autocomplete paste untouched', () => {
    renderAutocomplete({ bulkPaste: true });

    expect(latestRenderInputParams?.inputProps?.onPaste).toBeUndefined();
  });

  it('opens the bulk dialog from the input menu', () => {
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Частоти',
    });

    openBulkDialog(container);

    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(getBulkDialogInput(container)).not.toBeNull();
    expect(powerMenuProps.at(-1)?.open).toBe(false);
  });

  it('shows already selected values when the dialog opens', () => {
    const { container } = renderAutocomplete({
      bulkPaste: true,
      value: [options[0]],
      bulkPasteInputLabel: 'Частоти',
    });

    openBulkDialog(container);

    expect(container.textContent).toContain('Вже у фільтрі');
    expect(container.textContent).toContain('111.1111');
  });

  it('shows preview for existing selections and missing tokens', () => {
    const { onBulkPasteResolved, container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteSeparators: [',', '\n'],
      bulkPasteInputLabel: 'Частоти',
      value: [options[0]],
    });

    openBulkDialog(container);
    typeDialogValue(container, '111.1111\nBAD');

    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.1111', 'BAD'],
      found: [options[0]],
      missing: ['BAD'],
      added: [],
      alreadySelected: [options[0]],
      finalValue: [options[0]],
    });
    expect(container.textContent).toContain('Вже у фільтрі');
    expect(container.textContent).toContain('111.1111');
    expect(container.textContent).toContain('Не знайдено');
    expect(container.textContent).toContain('BAD');
  });

  it('hides empty preview sections before input', () => {
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Частоти',
    });

    openBulkDialog(container);

    expect(container.textContent).not.toContain('Буде додано');
    expect(container.textContent).not.toContain('Вже обрано');
    expect(container.textContent).not.toContain('Не знайдено');
  });

  it('keeps pasted duplicates in the already-selected preview without duplicating values', () => {
    const { onBulkPasteResolved, onBulkPasteChange, container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Частоти',
      value: [options[0]],
    });

    openBulkDialog(container);
    typeDialogValue(container, '111.1111');

    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['111.1111'],
      found: [options[0]],
      missing: [],
      added: [],
      alreadySelected: [options[0]],
      finalValue: [options[0]],
    });
    expect(container.textContent).toContain('Вже у фільтрі');
    expect(container.textContent).toContain('111.1111');
    expect(onBulkPasteChange).not.toHaveBeenCalled();
  });

  it('submits merged values without duplicates', () => {
    const { onBulkPasteChange, container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteSeparators: [',', '\n'],
      bulkPasteInputLabel: 'Частоти',
    });

    openBulkDialog(container);
    typeDialogValue(container, '111.1111,111.1111,BAD');

    const submitButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати',
    );
    if (!submitButton) throw new Error('Submit button not found');

    act(() => {
      submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onBulkPasteChange).toHaveBeenCalledWith([options[0]]);
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it('keeps input visible for an all-missing preview and does not submit', () => {
    const { onBulkPasteChange, container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Значення',
    });

    openBulkDialog(container);
    typeDialogValue(container, 'BAD,UGLY');

    const submitButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати',
    );
    if (!submitButton) throw new Error('Submit button not found');

    expect(submitButton.disabled).toBe(true);
    expect(onBulkPasteChange).not.toHaveBeenCalled();
  });
});
