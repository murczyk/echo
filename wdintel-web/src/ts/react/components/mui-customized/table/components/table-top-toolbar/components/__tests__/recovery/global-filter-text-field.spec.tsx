/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { KeyboardEvent, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TextFieldProps = {
  slotProps?: {
    input?: {
      startAdornment?: ReactNode;
      endAdornment?: ReactNode;
      readOnly?: boolean;
      autoComplete?: string;
    };
  };
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

type PowerIconButtonProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
};

let lastTextFieldProps: TextFieldProps | undefined;
let lastPowerIconButtonProps: PowerIconButtonProps | undefined;

vi.mock('@mui/icons-material/Clear', () => ({ default: () => <span data-testid="clear-icon" /> }));
vi.mock('@mui/icons-material/Search', () => ({
  default: () => <span data-testid="search-icon" />,
}));

vi.mock('@mui/material', () => ({
  InputAdornment: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: (props: TextFieldProps) => {
    lastTextFieldProps = props;

    return (
      <div
        data-testid="text-field"
        data-placeholder={props.placeholder ?? ''}
        data-disabled={props.disabled ? 'true' : 'false'}
      >
        <div>{props.slotProps?.input?.startAdornment}</div>
        <div>{props.slotProps?.input?.endAdornment}</div>
      </div>
    );
  },
}));

vi.mock('../../../../../../../PowerIconButton', () => ({
  PowerIconButton: (props: PowerIconButtonProps) => {
    lastPowerIconButtonProps = props;

    return (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </button>
    );
  },
}));

import { GlobalFilterTextField } from '../../global-filter-text-field';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(props?: {
  globalFilter?: string;
  disabled?: boolean;
  setGlobalFilter?: (value: string) => void;
}): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const setGlobalFilter = props?.setGlobalFilter || vi.fn();

  await act(async () => {
    root.render(
      <GlobalFilterTextField
        globalFilter={props?.globalFilter ?? 'abc'}
        setGlobalFilter={setGlobalFilter}
        disabled={props?.disabled}
      />,
    );
  });

  return { container, root };
}

function createKeyboardEvent(
  overrides: Partial<KeyboardEvent<HTMLInputElement>> = {},
): KeyboardEvent<HTMLInputElement> {
  return {
    key: 'Escape',
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: {
      readOnly: false,
    } as HTMLInputElement,
    ...overrides,
  } as KeyboardEvent<HTMLInputElement>;
}

// @test-scope safeguard: prevents keyboard filter clearing from mutating disabled, read-only, or empty table search state
describe('GlobalFilterTextField', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    lastTextFieldProps = undefined;
    lastPowerIconButtonProps = undefined;
    vi.clearAllMocks();
  });

  it('uses the search icon for the leading adornment', async () => {
    const view = await renderComponent();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="search-icon"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="clear-icon"]')).toBeTruthy();
  });

  it('clears the filter on Escape when the field has a value', async () => {
    const setGlobalFilter = vi.fn();
    const view = await renderComponent({ globalFilter: 'abc', setGlobalFilter });
    rendered.push(view);

    const event = createKeyboardEvent();

    lastTextFieldProps?.onKeyDown?.(event);

    expect(setGlobalFilter).toHaveBeenCalledWith('');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Escape when the field is empty', async () => {
    const setGlobalFilter = vi.fn();
    const view = await renderComponent({ globalFilter: '', setGlobalFilter });
    rendered.push(view);

    const event = createKeyboardEvent();

    lastTextFieldProps?.onKeyDown?.(event);

    expect(setGlobalFilter).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('does nothing on Escape when the field is disabled', async () => {
    const setGlobalFilter = vi.fn();
    const view = await renderComponent({ globalFilter: 'abc', disabled: true, setGlobalFilter });
    rendered.push(view);

    const event = createKeyboardEvent();

    lastTextFieldProps?.onKeyDown?.(event);

    expect(setGlobalFilter).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('does nothing on Escape when the field is read-only', async () => {
    const setGlobalFilter = vi.fn();
    const view = await renderComponent({ globalFilter: 'abc', setGlobalFilter });
    rendered.push(view);

    const event = createKeyboardEvent({
      currentTarget: {
        readOnly: true,
      } as HTMLInputElement,
    });

    lastTextFieldProps?.onKeyDown?.(event);

    expect(setGlobalFilter).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('keeps the clear button working', async () => {
    const setGlobalFilter = vi.fn();
    const view = await renderComponent({ globalFilter: 'abc', setGlobalFilter });
    rendered.push(view);

    lastPowerIconButtonProps?.onClick?.();

    expect(setGlobalFilter).toHaveBeenCalledWith('');
  });
});
