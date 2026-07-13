/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';

const drawerProps: Array<{ ModalProps?: { disableRestoreFocus?: boolean } }> = [];
type TextFieldMockProps = {
  label?: string;
  multiline?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  placeholder?: string;
  value?: string;
  fullWidth?: boolean;
};
const textFieldPropsByLabel = new Map<string | undefined, TextFieldMockProps>();

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
  Chip: ({
    label,
    children,
    onDelete,
  }: {
    label?: ReactNode;
    children?: ReactNode;
    onDelete?: () => void;
  }) => (
    <span>
      {label ?? children}
      {onDelete ? (
        <button type="button" onClick={onDelete}>
          delete
        </button>
      ) : null}
    </span>
  ),
  Drawer: ({
    children,
    open,
    ModalProps,
  }: {
    children?: ReactNode;
    open?: boolean;
    ModalProps?: { disableRestoreFocus?: boolean };
  }) => {
    if (open) drawerProps.push({ ModalProps });
    return open ? <div role="dialog">{children}</div> : null;
  },
  IconButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    multiline,
    onChange,
    onKeyDown,
    placeholder,
    value,
    fullWidth,
  }: TextFieldMockProps) => {
    textFieldPropsByLabel.set(label, {
      label,
      multiline,
      onChange,
      onKeyDown,
      placeholder,
      value,
      fullWidth,
    });

    return multiline ? (
      <textarea
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown}
      />
    ) : (
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown}
      />
    );
  },
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { AnalysisMessageEditDrawer } from './AnalysisMessageEditDrawer';

function buildMessage(): InboxMessage {
  return {
    messageUid: 'message-1',
    text: '',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: ['ab123'],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    post: null,
    postId: null,
    unit: null,
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: null,
    tags: null,
    networkIds: null,
    inboxTags: null,
    metadata: [],
  };
}

function renderDrawer({
  message,
  saveInFlight,
  onSave = vi.fn(),
}: {
  message: { id: number; message: InboxMessage } | null;
  saveInFlight: boolean;
  onSave?: (message: InboxMessage) => void;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <AnalysisMessageEditDrawer
        message={message}
        open
        saveInFlight={saveInFlight}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
  });

  const form = container.querySelector('form');
  if (form) {
    wireFormRequestSubmit(form as HTMLFormElement);
  }

  return { container, onSave, root };
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}

function changeTextField(label: string, value: string) {
  textFieldPropsByLabel.get(label)?.onChange?.({ target: { value } });
}

describe('AnalysisMessageEditDrawer', () => {
  afterEach(() => {
    drawerProps.splice(0);
    textFieldPropsByLabel.clear();
    document.body.innerHTML = '';
  });

  it('disables restore focus on the edit drawer modal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AnalysisMessageEditDrawer
          message={null}
          open
          saveInFlight={false}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(drawerProps.at(-1)?.ModalProps).toEqual({ disableRestoreFocus: true });
    root.unmount();
  });

  it('submits multiple location changes from the save button', async () => {
    const message = { ...buildMessage(), location: 'Київ, Харків' };
    const { container, onSave, root } = renderDrawer({
      message: { id: 1, message },
      saveInFlight: false,
    });

    const locationInput = container.querySelector(
      'input[aria-label="Локація"]',
    ) as HTMLInputElement;
    expect(locationInput).toBeTruthy();
    expect(container.textContent).toContain('Київ');
    expect(container.textContent).toContain('Харків');

    act(() => {
      changeTextField('Локація', 'Одеса, Львів');
    });

    await act(async () => {
      textFieldPropsByLabel.get('Локація')?.onKeyDown?.({
        key: 'Enter',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as never);
    });

    expect(onSave).not.toHaveBeenCalled();

    const saveButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        location: 'Київ, Харків, Одеса, Львів',
      }),
    );
    root.unmount();
  });

  it('does not submit location changes while save is in flight', async () => {
    const { container, onSave, root } = renderDrawer({
      message: { id: 1, message: buildMessage() },
      saveInFlight: true,
    });

    const locationInput = container.querySelector(
      'input[aria-label="Локація"]',
    ) as HTMLInputElement;
    expect(locationInput).toBeTruthy();

    await act(async () => {
      locationInput.dispatchEvent(
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

  it('does not submit location changes without a current message', async () => {
    const { container, onSave, root } = renderDrawer({
      message: null,
      saveInFlight: false,
    });

    const locationInput = container.querySelector(
      'input[aria-label="Локація"]',
    ) as HTMLInputElement;
    expect(locationInput).toBeTruthy();

    await act(async () => {
      locationInput.dispatchEvent(
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

  it('keeps callsign enter local to the drawer', async () => {
    const { container, onSave, root } = renderDrawer({
      message: { id: 1, message: buildMessage() },
      saveInFlight: false,
    });

    const callsignInput = container.querySelector(
      'input[aria-label="Позивний"]',
    ) as HTMLInputElement;
    expect(callsignInput).toBeTruthy();

    act(() => {
      changeTextField('Позивний', 'ab123');
    });

    await act(async () => {
      textFieldPropsByLabel.get('Позивний')?.onKeyDown?.({
        key: 'Enter',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as never);
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('AB123');
    root.unmount();
  });

  it('submits the drawer from the save button', async () => {
    const { container, onSave, root } = renderDrawer({
      message: { id: 1, message: buildMessage() },
      saveInFlight: false,
    });

    const saveButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
