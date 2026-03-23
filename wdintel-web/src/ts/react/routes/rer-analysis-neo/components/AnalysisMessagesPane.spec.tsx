/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: { children: ReactNode; onClick?: () => void; type?: 'button' | 'submit' | 'reset' }) => (
    <button type={props.type ?? 'button'} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  FormControlLabel: (props: { control: ReactNode; label: ReactNode }) => (
    <label>
      {props.control}
      <span>{props.label}</span>
    </label>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: (props: { checked?: boolean; onChange?: (_event: Event, checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.nativeEvent, event.currentTarget.checked)}
    />
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../rer-duty-neo/MessageCard', () => ({
  MessageCard: (props: {
    id: number;
    onComment: () => void;
    onDelete: () => void;
    onEditDetails: () => void;
  }) => (
    <div data-testid={`message-card-${props.id}`}>
      <button type="button" onClick={props.onComment}>
        comment-{props.id}
      </button>
      <button type="button" onClick={props.onDelete}>
        delete-{props.id}
      </button>
      <button type="button" onClick={props.onEditDetails}>
        edit-{props.id}
      </button>
    </div>
  ),
}));

vi.mock('../../rer-duty-neo/dialogs', () => ({
  CommentDialog: (props: { open: boolean; onSave: () => void; onClose: () => void }) =>
    props.open ? (
      <div data-testid="comment-dialog">
        <button type="button" onClick={props.onSave}>
          save-comment
        </button>
        <button type="button" onClick={props.onClose}>
          close-comment
        </button>
      </div>
    ) : null,
  DeleteConfirmDialog: (props: { open: boolean; onConfirm: () => void; onClose: () => void }) =>
    props.open ? (
      <div data-testid="delete-dialog">
        <button type="button" onClick={props.onConfirm}>
          confirm-delete
        </button>
        <button type="button" onClick={props.onClose}>
          close-delete
        </button>
      </div>
    ) : null,
}));

vi.mock('./AnalysisMessageEditDrawer', () => ({
  AnalysisMessageEditDrawer: (props: { open: boolean; message: { id: number } | null }) =>
    props.open ? <div data-testid={`editor-drawer-${props.message?.id ?? 'none'}`} /> : null,
}));

vi.mock('../message-utils', () => ({
  buildSenderLabel: () => 'Sender',
  copyMessageValue: vi.fn().mockResolvedValue(undefined),
}));

import { AnalysisMessagesPane } from './AnalysisMessagesPane';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: 'hello',
    freq: '100.000',
    bookmarked: false,
    important: false,
    extendedForm: 'saved note',
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [],
    tags: [],
    ...overrides,
  } as InboxMessage;
}

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisMessagesPane>> = {}): ComponentProps<typeof AnalysisMessagesPane> {
  return {
    authUserName: 'tester',
    copiedFeedbackId: null,
    groupInfos: {},
    loading: false,
    messages: [],
    networkDisplayMap: {},
    noMoreToLoad: true,
    nolimitShown: true,
    newestFirst: false,
    editorMessage: null,
    editorSaveInFlight: false,
    onCloseEditor: vi.fn(),
    onDeleteMessage: vi.fn(),
    onLoadAllMessages: vi.fn(),
    onLoadMoreMessages: vi.fn(),
    onOpenEditor: vi.fn(),
    onSaveEditor: vi.fn(),
    onSaveMessageComment: vi.fn(),
    onSetNewestFirst: vi.fn(),
    onToggleMessageBookmark: vi.fn(),
    onToggleMessageImportant: vi.fn(),
    onToggleMessageTag: vi.fn(),
    onUpdateEditorField: vi.fn(),
    profiles: {},
    tagsMap: {},
    ...overrides,
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisMessagesPane>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisMessagesPane {...props} />);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(labelText));
  if (!label) throw new Error(`Label not found: ${labelText}`);
  const input = label.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found for label: ${labelText}`);
  return input;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setChecked(input: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (input.checked !== checked) {
      input.click();
    }
  });
}

describe('AnalysisMessagesPane', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows the empty state when there are no messages', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає жодного повідомлення для аналізу.');
  });

  it('wires list controls into the page callbacks', async () => {
    const onLoadAllMessages = vi.fn();
    const onLoadMoreMessages = vi.fn();
    const onSetNewestFirst = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        noMoreToLoad: false,
        nolimitShown: false,
        onLoadAllMessages,
        onLoadMoreMessages,
        onSetNewestFirst,
      }),
    );
    rendered.push(view);

    await setChecked(getInputByLabel(view.container, 'спочатку нові'), true);
    await click(getButton(view.container, 'Показати всі'));
    await click(getButton(view.container, 'Завантажити ще'));

    expect(onSetNewestFirst).toHaveBeenCalledWith(true);
    expect(onLoadAllMessages).toHaveBeenCalledTimes(1);
    expect(onLoadMoreMessages).toHaveBeenCalledTimes(1);
  });

  it('wires comment save into the page callback', async () => {
    const onSaveMessageComment = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onSaveMessageComment,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'comment-7'));
    await click(getButton(view.container, 'save-comment'));

    expect(onSaveMessageComment).toHaveBeenCalledWith(7, 'saved note');
  });

  it('wires delete confirmation into the page callback', async () => {
    const onDeleteMessage = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onDeleteMessage,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'delete-7'));
    await click(getButton(view.container, 'confirm-delete'));

    expect(onDeleteMessage).toHaveBeenCalledWith(7);
  });

  it('wires edit action into the page callback', async () => {
    const onOpenEditor = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onOpenEditor,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'edit-7'));

    expect(onOpenEditor).toHaveBeenCalledWith(7);
  });
});
