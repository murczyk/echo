/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ELLIPSIS } from '../../../../utils/misc';

import type { InboxMessage, SignalGroupEntry } from '../../../../../../Bindings';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: forwardRef<
    HTMLDivElement,
    {
      children: ReactNode;
      component?: string;
      role?: string;
      'aria-label'?: string;
      'aria-live'?: string;
    }
  >(({ children, component, role, 'aria-label': ariaLabel, 'aria-live': ariaLive }, ref) =>
    component === 'ul' ? (
      <ul role={role} aria-label={ariaLabel} aria-live={ariaLive}>
        {children}
      </ul>
    ) : (
      <div ref={ref} role={role} aria-label={ariaLabel} aria-live={ariaLive}>
        {children}
      </div>
    ),
  ),
  Button: (props: {
    children: ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    startIcon?: ReactNode;
  }) => (
    <button type={props.type ?? 'button'} onClick={props.onClick}>
      {props.startIcon}
      {props.children}
    </button>
  ),
  CircularProgress: () => <div>loading</div>,
}));

vi.mock('../../../shared/message-card/MessageCard', () => ({
  AnalysisMessageCard: (props: {
    id: number;
    onCreateReport: () => void;
    onEditReport?: (id: number) => void;
    onDelete: () => void;
    onEditDetails: () => void;
    onCopyEtalon?: () => void;
    onCopyLocation?: () => void;
    messageComments?: Array<{ id: number; login: string; comment: string }>;
    senderName?: string | null;
    tagsLayout?: string;
    analysisCallsignActions?: { onAddCallsign: () => void; onRemoveCallsign: () => void };
  }) => (
    <div data-testid={`message-card-${props.id}`}>
      <span data-testid={`sender-${props.id}`}>{props.senderName ?? ''}</span>
      <span data-testid={`tags-layout-${props.id}`}>{props.tagsLayout ?? 'unset'}</span>
      <span data-testid={`comments-${props.id}`}>
        {(props.messageComments ?? [])
          .map((comment) => `${comment.login}:${comment.comment}`)
          .join('|')}
      </span>
      <button type="button" onClick={props.onCreateReport}>
        report-{props.id}
      </button>
      <button type="button" onClick={() => props.onEditReport?.(91)}>
        edit-report-{props.id}
      </button>
      <button type="button" onClick={props.onDelete}>
        delete-{props.id}
      </button>
      <button type="button" onClick={props.onEditDetails}>
        edit-{props.id}
      </button>
      {props.onCopyEtalon != null ? (
        <button type="button" onClick={props.onCopyEtalon}>
          copy-etalon-{props.id}
        </button>
      ) : null}
      {props.onCopyLocation != null ? (
        <button type="button" onClick={props.onCopyLocation}>
          copy-location-{props.id}
        </button>
      ) : null}
      {props.analysisCallsignActions != null ? <span>analysis-callsigns</span> : null}
      {props.analysisCallsignActions != null ? (
        <button
          type="button"
          onClick={() => props.analysisCallsignActions?.onRemoveCallsign('ALPHA')}
        >
          remove-callsign
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../../../rer-duty-neo/dialogs', () => ({
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

vi.mock('../../message-utils', async () => {
  const actual = await vi.importActual<typeof import('../../message-utils')>('../../message-utils');
  return {
    ...actual,
    copyMessageValue: vi.fn().mockResolvedValue(undefined),
  };
});

import { AnalysisMessagesPane } from '.././AnalysisMessagesPane';

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
    extendedForm: 'saved comment',
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [],
    tags: [],
    ...overrides,
  } as InboxMessage;
}

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisMessagesPane>> = {},
): ComponentProps<typeof AnalysisMessagesPane> {
  return {
    authUserName: 'tester',
    copiedFeedbackId: null,
    currentUser: {
      name: 'tester',
      roles: [],
      sigintZoneId: null,
      organismId: 1,
      deltaLogin: null,
      goiConfiguredForOrganism: false,
      goiFullAccessForOrganism: false,
      goiHost: null,
      goiIntegrations: [],
    },
    groupInfos: {},
    loading: false,
    paginationLoading: false,
    messageComments: {},
    messages: [],
    networkDisplayMap: {},
    pageIndex: 0,
    noMoreToLoad: false,
    onDeleteMessage: vi.fn(),
    onOpenEditor: vi.fn(),
    onCreateReport: vi.fn(),
    onEditReport: vi.fn(),
    onLoadMoreMessages: vi.fn().mockResolvedValue(true),
    onSaveMessageUpdate: vi.fn().mockResolvedValue(true),
    onToggleMessageBookmark: vi.fn(),
    onToggleMessageImportant: vi.fn(),
    onToggleMessageTag: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    profiles: {},
    tagsMap: {},
    tagsOrder: [],
    tagsLoading: false,
    tagsLayout: 'full',
    showCallsignAddForm: false,
    ...overrides,
  };
}

async function renderComponent(
  props: ComponentProps<typeof AnalysisMessagesPane>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisMessagesPane {...props} />);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// @test-scope safeguard: preserves analysis-message pagination, destructive actions, comments, and page transitions so stale or unintended message operations cannot be shown as current.
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

  it('shows the loading overlay instead of the empty state while messages refresh', async () => {
    const view = await renderComponent(buildProps({ loading: true }));
    rendered.push(view);

    expect(view.container.textContent).toContain('loading');
    expect(view.container.textContent).not.toContain('Немає жодного повідомлення для аналізу.');
  });

  it('shows an accessible narrow refresh indicator over loaded messages', async () => {
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], loading: true }),
    );
    rendered.push(view);

    expect(view.container.querySelector('[aria-label="Оновлення повідомлень"]')).not.toBeNull();
  });

  it('shows a distinct indicator while loading another page', async () => {
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], paginationLoading: true }),
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[aria-label="Завантаження ще повідомлень"]'),
    ).not.toBeNull();
  });

  it('passes the tags layout through to analysis message cards', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        tagsLayout: 'hidden',
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="tags-layout-7"]')?.textContent).toBe(
      'hidden',
    );
  });

  it('passes the formatted sender label through to analysis message cards', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage({ sender: 'sender-1' })]],
        profiles: {
          'sender-1': { givenName: 'BBC', familyName: 'SPORT' },
        },
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="sender-7"]')?.textContent).toBe('BBC SPORT');
  });

  it('shows the loading spinner while paginating', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        paginationLoading: true,
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('loading');
  });

  it('wires report creation and editing into the page callbacks', async () => {
    const onCreateReport = vi.fn();
    const onEditReport = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onCreateReport,
        onEditReport,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'report-7'));
    await click(getButton(view.container, 'edit-report-7'));

    expect(onCreateReport).toHaveBeenCalledWith(7);
    expect(onEditReport).toHaveBeenCalledWith(91);
  });

  it('forwards loaded message comments into the rendered message card', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        messageComments: {
          7: [
            {
              id: 19,
              messageId: 7,
              comment: 'other-organism comment',
              login: 'external-login',
              sigintPostName: null,
            },
            {
              id: 21,
              messageId: 7,
              comment: 'same-organism comment',
              login: 'peer-login',
              sigintPostName: null,
            },
            {
              id: 20,
              messageId: 7,
              comment: 'hidden self comment',
              login: 'tester',
              sigintPostName: null,
            },
            {
              id: 22,
              messageId: 7,
              comment: 'auto post comment',
              login: 'system',
              sigintPostName: 'Пост Альфа',
            },
          ],
        },
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="comments-7"]')?.textContent).toContain(
      'external-login:other-organism comment',
    );
    expect(view.container.querySelector('[data-testid="comments-7"]')?.textContent).toContain(
      'system:auto post comment',
    );
    expect(view.container.querySelector('[data-testid="comments-7"]')?.textContent).toContain(
      'peer-login:same-organism comment',
    );
    expect(view.container.querySelector('[data-testid="comments-7"]')?.textContent).not.toContain(
      'tester:hidden self comment',
    );
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

  it('passes analysis-only message update wiring into cards', async () => {
    const onSaveMessageUpdate = vi.fn().mockResolvedValue(true);
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onSaveMessageUpdate,
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('analysis-callsigns');
  });

  it('passes the copy menu etalon action into analysis message cards', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage({ unit: '1-й танк' })]],
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('button').textContent).toContain('report-7');
    expect(view.container.textContent).toContain('copy-etalon-7');
  });

  it('passes the copy menu location action into analysis message cards when no networks resolve', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage({ networkIds: [], location: 'ПІЩАНКА' })]],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('copy-location-7');
  });

  it('normalizes callsigns when removing them through the analysis card', async () => {
    const onSaveMessageUpdate = vi.fn(
      async (_messageId: number, updater: (message: InboxMessage) => InboxMessage) => {
        const updated = updater(buildMessage({ callsigns: ['Alpha'] }));
        expect(updated.callsigns).toEqual([]);
        return true;
      },
    );
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage({ callsigns: ['Alpha'] })]],
        onSaveMessageUpdate,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'remove-callsign'));

    expect(onSaveMessageUpdate).toHaveBeenCalled();
  });

  it('scrolls the message list to top when pageIndex changes', async () => {
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], pageIndex: 0 }),
    );
    rendered.push(view);

    const messageCard = view.container.querySelector('[data-testid="message-card-7"]');
    const scrollBox = messageCard?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox) {
      Object.defineProperty(scrollBox, 'scrollTop', { value: 500, writable: true });
    }

    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane {...buildProps({ messages: [[7, buildMessage()]], pageIndex: 1 })} />,
      );
    });

    expect(scrollBox?.scrollTop).toBe(0);
  });

  it('loads more messages from the button at the bottom of the list', async () => {
    const onLoadMoreMessages = vi.fn().mockResolvedValue(true);
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onLoadMoreMessages,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'Завантажити ще'));

    expect(onLoadMoreMessages).toHaveBeenCalledTimes(1);
  });
});
