/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];

vi.mock('@mui/material', () => ({
  Box: ({
    children,
    component = 'div',
    sx,
    ...props
  }: {
    children?: ReactNode;
    component?: string;
  } & Record<string, unknown>) => {
    const Component = component as keyof HTMLElementTagNameMap;
    return <Component {...props}>{children}</Component>;
  },
  Button: ({
    children,
    type = 'button',
    onClick,
    variant,
    color,
    size,
    ...props
  }: {
    children?: ReactNode;
    type?: 'button' | 'submit' | 'reset';
    onClick?: () => void;
  } & Record<string, unknown>) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Dialog: ({
    children,
    open,
    disableRestoreFocus,
  }: {
    children?: ReactNode;
    open?: boolean;
    disableRestoreFocus?: boolean;
  }) => {
    if (open) dialogProps.push({ disableRestoreFocus });
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    multiline,
    onChange,
    onKeyDown,
    placeholder,
    value,
    autoFocus,
    fullWidth,
    minRows,
  }: {
    label?: string;
    multiline?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    placeholder?: string;
    value?: string;
    autoFocus?: boolean;
  }) =>
    multiline ? (
      <textarea
        aria-label={label}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown}
      />
    ) : (
      <input
        aria-label={label}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown}
      />
    ),
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { DeleteConfirmDialog } from './dialogs';

describe('message card dialogs', () => {
  afterEach(() => {
    dialogProps.splice(0);
    document.body.innerHTML = '';
  });

  it('disables restore focus on the shared delete confirm dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DeleteConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} />);
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    root.unmount();
  });
});
