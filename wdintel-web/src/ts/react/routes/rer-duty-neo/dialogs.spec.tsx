/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];

function wireFormRequestSubmit(form: HTMLFormElement) {
  Object.defineProperty(form, 'requestSubmit', {
    configurable: true,
    value: vi.fn(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }),
  });
}

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

import { CommentDialog, DeleteConfirmDialog } from './dialogs';

describe('message card dialogs', () => {
  afterEach(() => {
    dialogProps.splice(0);
    document.body.innerHTML = '';
  });

  it('disables restore focus on the shared comment dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CommentDialog
          open
          messagePreview={null}
          commentText=""
          onCommentTextChange={vi.fn()}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    root.unmount();
  });

  it('submits the shared comment dialog from cmd+enter and ctrl+enter', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSave = vi.fn();

    await act(async () => {
      root.render(
        <CommentDialog
          open
          messagePreview={null}
          commentText="Коментар"
          onCommentTextChange={vi.fn()}
          onClose={vi.fn()}
          onSave={onSave}
        />,
      );
    });

    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    wireFormRequestSubmit(form as HTMLFormElement);

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
    });

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      );
    });

    expect(onSave).toHaveBeenCalledTimes(2);
    root.unmount();
  });

  it('does not submit the shared comment dialog on plain enter', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSave = vi.fn();

    await act(async () => {
      root.render(
        <CommentDialog
          open
          messagePreview={null}
          commentText="Коментар"
          onCommentTextChange={vi.fn()}
          onClose={vi.fn()}
          onSave={onSave}
        />,
      );
    });

    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    wireFormRequestSubmit(form as HTMLFormElement);

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onSave).not.toHaveBeenCalled();
    root.unmount();
  });

  it('submits the shared comment dialog from the save button', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSave = vi.fn();

    await act(async () => {
      root.render(
        <CommentDialog
          open
          messagePreview={null}
          commentText="Коментар"
          onCommentTextChange={vi.fn()}
          onClose={vi.fn()}
          onSave={onSave}
        />,
      );
    });

    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    wireFormRequestSubmit(form as HTMLFormElement);

    const saveButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    root.unmount();
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
