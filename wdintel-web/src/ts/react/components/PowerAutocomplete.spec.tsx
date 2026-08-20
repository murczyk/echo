/**
 * @vitest-environment happy-dom
 */
import { act, type ReactElement, type ReactNode } from 'react';
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
  getOptionKey?: (option: unknown) => string;
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

type DialogPropsCapture = {
  disableRestoreFocus?: boolean;
  onClose?: (event: unknown, reason: string) => void;
};

let latestAutocompleteProps: AutocompletePropsCapture | null = null;
let latestRenderInputParams: {
  InputProps?: { endAdornment?: ReactNode };
  inputProps?: { onPaste?: () => void };
} | null = null;
let latestComposedEndAdornment: ReactNode | null = null;
let dialogContentProps: { sx?: unknown }[] = [];
let dialogProps: DialogPropsCapture[] = [];
let textFieldProps: TextFieldProps[] = [];
let powerMenuProps: PowerMenuProps[] = [];
let lastPowerIconButtonTrigger: { focus: ReturnType<typeof vi.fn> } | null = null;

vi.mock('@mui/material', () => ({
  Autocomplete: (props: AutocompletePropsCapture) => {
    latestAutocompleteProps = props;
    const params = {
      InputProps: {
        endAdornment: (
          <div data-testid="mui-end-adornment">
            <button type="button" data-testid="mui-clear-indicator" key="clear" />
            <button type="button" data-testid="mui-popup-indicator" key="popup" />
          </div>
        ),
      },
      inputProps: {},
    };
    latestRenderInputParams = params;
    return <div>{props.renderInput?.(params)}</div>;
  },
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dialog: (props: {
    children: ReactNode;
    open: boolean;
    disableRestoreFocus?: boolean;
    onClose?: (event: unknown, reason: string) => void;
  }) => {
    dialogProps.push({
      disableRestoreFocus: props.disableRestoreFocus,
      onClose: props.onClose,
    });
    return props.open ? <div data-testid="dialog">{props.children}</div> : null;
  },
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, sx }: { children: ReactNode; sx?: unknown }) => {
    dialogContentProps.push({ sx });
    return <div>{children}</div>;
  },
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  InputAdornment: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
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

vi.mock('@mui/icons-material/ContentPaste', () => ({
  default: () => <span data-testid="playlist-add-icon" />,
}));

vi.mock('@mui/icons-material/ContentCopy', () => ({
  default: () => <span data-testid="content-copy-icon" />,
}));

vi.mock('./PowerIconButton', () => ({
  PowerIconButton: (props: PowerIconButtonProps) => {
    if (!lastPowerIconButtonTrigger) {
      lastPowerIconButtonTrigger = { focus: vi.fn() };
    }
    const trigger = lastPowerIconButtonTrigger;
    return (
      <button
        type="button"
        aria-label={props['aria-label']}
        disabled={props.disabled}
        onMouseDown={props.onMouseDown as never}
        onClick={() =>
          props.onClick?.({
            currentTarget: trigger as never,
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
  latestComposedEndAdornment = null;
  dialogContentProps = [];
  dialogProps = [];
  textFieldProps = [];
  powerMenuProps = [];
  lastPowerIconButtonTrigger = null;
  vi.clearAllMocks();
});

function renderAutocomplete(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onBulkPasteChange = vi.fn();
  const onBulkPasteResolved = vi.fn();
  const onClose = vi.fn();
  const getOptionLabel =
    (overrides.getOptionLabel as ((option: Option) => string) | undefined) ??
    ((option: Option) => option.label);
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
        getOptionLabel={getOptionLabel}
        getOptionKey={(option) => option.key}
        renderInput={(params) => (
          <div data-testid="input-root">
            <input data-testid="main-input" />
            <span data-testid="end-adornment">
              {(() => {
                latestComposedEndAdornment =
                  (params as { InputProps?: { endAdornment?: ReactNode } }).InputProps
                    ?.endAdornment ?? null;
                return latestComposedEndAdornment;
              })()}
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

function openBulkMenu(container: HTMLElement, label?: string) {
  const menuButton = getBulkMenuButton(container, label);
  if (!menuButton) throw new Error('Bulk menu button not found');

  act(() => {
    menuButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    menuButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openBulkDialog(container: HTMLElement, label?: string) {
  openBulkMenu(container, label);
  const menuItem = container.querySelector('[data-testid="bulk-menu"] button');
  if (!menuItem) throw new Error('Bulk menu item not found');

  act(() => {
    menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function composedEndAdornmentChildren(): ReactNode[] {
  const endAdornment = latestComposedEndAdornment as ReactElement<{ children?: ReactNode }> | null;
  const children = endAdornment?.props.children;
  return Array.isArray(children) ? children : children ? [children] : [];
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

  it('disables the copy action when there are no selected values', () => {
    const { container } = renderAutocomplete({ bulkPaste: true, bulkCopy: true });
    openBulkMenu(container);

    const copyItem = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Копіювати обрані значення'),
    );
    expect(copyItem?.disabled).toBe(true);
  });

  it('copies the current values through the opt-in callback', () => {
    const onBulkCopy = vi.fn();
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkCopy: true,
      value: [options[0], options[1]],
      onBulkCopy,
    });
    openBulkMenu(container);

    const copyItem = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Копіювати обрані значення'),
    );
    if (!copyItem) throw new Error('Copy menu item not found');
    act(() => copyItem.click());

    expect(onBulkCopy).toHaveBeenCalledWith([options[0], options[1]], '111.1111\n222.2222');
  });

  it('passes a copied newline list from one frequency column into another bulk flow', () => {
    const copiedValues: string[] = [];
    const onBulkPasteChange = vi.fn();
    const first = renderAutocomplete({
      bulkPaste: true,
      bulkCopy: true,
      value: [options[0], options[1]],
      onBulkCopy: (selected: readonly Option[]) =>
        copiedValues.push(...selected.map((option) => option.label)),
    });

    openBulkMenu(first.container);
    const copyItem = [...first.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Копіювати обрані значення'),
    );
    if (!copyItem) throw new Error('Copy menu item not found');
    act(() => copyItem.click());

    const second = renderAutocomplete({
      bulkPaste: true,
      bulkPasteSeparators: [',', '\n'],
      onBulkPasteChange,
    });
    openBulkDialog(second.container);
    typeDialogValue(second.container, copiedValues.join('\n'));
    const submitButton = [...second.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати',
    );
    if (!submitButton) throw new Error('Submit button not found');
    act(() => submitButton.click());

    expect(copiedValues).toEqual(['111.1111', '222.2222']);
    expect(onBulkPasteChange).toHaveBeenCalledWith([options[0], options[1]]);
  });

  it('keeps commas inside one newline-delimited free-form value', () => {
    const postOption = { id: 'post-1', label: 'HQ, East' };
    const onBulkPasteResolved = vi.fn();
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteSeparators: ['\n'],
      options: [postOption],
      onBulkPasteResolved,
    });

    openBulkDialog(container);
    typeDialogValue(container, 'HQ, East');

    expect(onBulkPasteResolved).toHaveBeenCalledWith({
      tokens: ['HQ, East'],
      found: [postOption],
      missing: [],
      added: [postOption],
      alreadySelected: [],
      finalValue: [postOption],
    });
  });

  it('resolves an inactive unit through bulk options without adding it to the dropdown', () => {
    const selectableUnit = { id: 'unit-1', label: 'Active unit' };
    const historicUnit = { id: 'historic-unit', label: 'Historic unit' };
    const { onBulkPasteChange, container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteOptions: [selectableUnit, historicUnit],
      bulkPasteSeparators: ['\n'],
      options: [selectableUnit],
    });

    expect(latestAutocompleteProps?.options).toEqual([selectableUnit]);
    openBulkDialog(container);
    typeDialogValue(container, 'Historic unit');

    const submitButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Додати',
    );
    if (!submitButton) throw new Error('Submit button not found');
    act(() => submitButton.click());

    expect(onBulkPasteChange).toHaveBeenCalledWith([historicUnit]);
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
          gap: 0.5,
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

  it('injects the menu button as a keyed adornment child before the popup indicator', () => {
    renderAutocomplete({ bulkPaste: true });

    const children = composedEndAdornmentChildren();
    const keys = children.map((child) =>
      typeof child === 'object' && child != null && 'key' in child
        ? (child as { key?: string }).key
        : null,
    );

    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key != null)).toBe(true);
    expect(keys[1]).toBe('bulk-paste-menu');
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

  it('uses the tighter bulk dialog content padding', () => {
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Частоти',
    });

    openBulkDialog(container);

    expect(dialogContentProps.at(-1)?.sx).toEqual(
      expect.objectContaining({
        pt: 2.5,
        pb: 0,
        overflow: 'visible',
      }),
    );
  });

  it('does not scan bulk options until the dialog is open', () => {
    const getOptionLabel = vi.fn((option: Option) => option.label);

    renderAutocomplete({
      bulkPaste: false,
      getOptionLabel,
    });

    expect(getOptionLabel).not.toHaveBeenCalled();

    const closedBulkLabel = vi.fn((option: Option) => option.label);
    renderAutocomplete({
      bulkPaste: true,
      getOptionLabel: closedBulkLabel,
    });

    expect(closedBulkLabel).not.toHaveBeenCalled();
  });

  it('scans bulk options once the dialog is opened and input is entered', () => {
    const getOptionLabel = vi.fn((option: Option) => option.label);
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Частоти',
      getOptionLabel,
    });

    expect(getOptionLabel).not.toHaveBeenCalled();

    openBulkDialog(container);
    expect(getOptionLabel).toHaveBeenCalled();
    const callsAfterOpen = getOptionLabel.mock.calls.length;

    typeDialogValue(container, '111.1111');
    expect(getOptionLabel.mock.calls.length).toBeGreaterThan(callsAfterOpen);
  });

  it('restores focus to the bulk menu trigger after closing the dialog', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderAutocomplete({
        bulkPaste: true,
        bulkPasteInputLabel: 'Частоти',
      });

      openBulkDialog(container);
      const callsAfterOpen = lastPowerIconButtonTrigger?.focus.mock.calls.length ?? 0;

      const cancelButton = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Скасувати',
      );
      if (!cancelButton) throw new Error('Cancel button not found');

      act(() => {
        cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        vi.runAllTimers();
      });

      expect(lastPowerIconButtonTrigger).not.toBeNull();
      expect(lastPowerIconButtonTrigger?.focus).toHaveBeenCalled();
      expect(lastPowerIconButtonTrigger?.focus.mock.calls.length).toBeGreaterThan(callsAfterOpen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables dialog restore focus for the bulk dialog', () => {
    renderAutocomplete({ bulkPaste: true });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    expect(dialogProps.at(-1)?.onClose).toEqual(expect.any(Function));
  });

  it('passes a stable key for the bulk menu composed adornment child', () => {
    renderAutocomplete({ bulkPaste: true });

    const children = composedEndAdornmentChildren();
    const bulkMenu = children.find(
      (child) =>
        typeof child === 'object' &&
        child != null &&
        'props' in child &&
        (child as { props?: { 'aria-label'?: string } }).props?.['aria-label'] ===
          'Додати кілька значень',
    ) as ReactElement | undefined;

    expect(bulkMenu?.key).toBe('bulk-paste-menu');
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

  it('rejects ambiguous aliases instead of choosing an arbitrary option', () => {
    const ambiguousOptions = [
      { id: 'sender-a', label: 'Same label' },
      { id: 'sender-b', label: 'Same label' },
    ];
    const onBulkPasteResolved = vi.fn();
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkPasteInputLabel: 'Відправники',
      options: ambiguousOptions,
      getBulkPasteToken: (option: Option) => option.id,
      getBulkPasteAliases: (option: Option) => [option.label],
      onBulkPasteResolved,
    });

    openBulkDialog(container);
    typeDialogValue(container, 'Same label');

    expect(onBulkPasteResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        found: [],
        missing: ['Same label'],
        added: [],
      }),
    );
    expect(container.textContent).toContain('Same label');
  });

  it('round-trips canonical object tokens when display labels collide', () => {
    const senderOptions = [
      { id: 'sender-a', label: 'Same label' },
      { id: 'sender-b', label: 'Same label' },
    ];
    const onBulkCopy = vi.fn();
    const onBulkPasteResolved = vi.fn();
    const { container } = renderAutocomplete({
      bulkPaste: true,
      bulkCopy: true,
      value: [senderOptions[0]],
      options: senderOptions,
      getBulkPasteToken: (option: Option) => option.id,
      getBulkPasteAliases: (option: Option) => [option.label],
      onBulkCopy,
      onBulkPasteResolved,
    });

    openBulkMenu(container);
    const copyItem = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Копіювати обрані значення'),
    );
    if (!copyItem) throw new Error('Copy menu item not found');
    act(() => copyItem.click());
    expect(onBulkCopy).toHaveBeenCalledWith([senderOptions[0]], 'sender-a');

    openBulkDialog(container);
    typeDialogValue(container, 'sender-a');
    expect(onBulkPasteResolved).toHaveBeenCalledWith(
      expect.objectContaining({ found: [senderOptions[0]], missing: [] }),
    );
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
