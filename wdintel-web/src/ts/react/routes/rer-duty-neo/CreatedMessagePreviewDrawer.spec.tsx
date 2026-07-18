/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type {
  InboxMessage,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
  CallsignInfoRes,
} from '../../../../Bindings';
import { CreatedMessagePreviewDrawer } from './CreatedMessagePreviewDrawer';
import type { CreatedMessageResultState } from './useCreatedMessageResult';

const drawerPropsHistory = vi.hoisted(() => [] as Array<{ open?: boolean; onClose?: () => void }>);
const messageCardPropsHistory = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@mui/material', () => ({
  Box: ({
    children,
    component: Component = 'div',
    ...props
  }: { children?: ReactNode; component?: string } & Record<string, unknown>) => {
    const Element = Component as keyof HTMLElementTagNameMap;
    return <Element {...props}>{children}</Element>;
  },
  Button: ({
    children,
    onClick,
    ...props
  }: { children?: ReactNode; onClick?: () => void } & Record<string, unknown>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Drawer: ({
    children,
    open,
    onClose,
  }: {
    children?: ReactNode;
    open?: boolean;
    onClose?: () => void;
  }) => {
    drawerPropsHistory.push({ open, onClose });
    return open ? <div role="dialog">{children}</div> : null;
  },
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../shared/message-card/MessageCard', () => ({
  DutyMessageCard: (props: Record<string, unknown>) => {
    messageCardPropsHistory.push(props);
    const message = props.msg as InboxMessage;
    return (
      <div data-testid="message-card">
        <span data-testid="message-text">{message.text}</span>
        <span data-testid="message-id">{String(props.id)}</span>
      </div>
    );
  },
}));

function buildMessage(): InboxMessage {
  return {
    messageUid: 'm-1',
    text: 'preview body',
    freq: '149.500',
    bookmarked: false,
    important: false,
    extendedForm: 'note',
    sender: 'sender-a',
    groupMasterKey: 'g-1',
    networkIds: [7],
    tags: [3],
    inboxTags: null,
    metadata: [],
    textMarked: null,
    pointTokens: null,
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-07-17',
    time: '12:00',
    timestamp: null,
    post: 'post-a',
    unit: 'unit-a',
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    comment: null,
    location: null,
    coords: null,
    noHeadersBody: null,
    messageComments: [],
  } as InboxMessage;
}

function renderDrawer(
  result: CreatedMessageResultState,
  overrides?: Partial<{
    open: boolean;
    onClose: () => void;
  }>,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = overrides?.onClose ?? vi.fn();

  const props = {
    authUserName: 'tester',
    open: overrides?.open ?? true,
    result,
    onClose,
    groupInfos: {
      'g-1': { name: 'Group Alpha' } as SignalGroupEntry,
    },
    profiles: {
      'sender-a': { givenName: 'Sender', familyName: 'Alpha' } as SignalProfileEntry,
    },
    networkDisplayMap: { 7: 'Network 7' },
    networkMap: { 7: { id: 7, name: 'Network 7' } as Network },
    unitsMap: { 1: { id: 1, name: 'Unit 1' } as Unit },
    callsignInfoMap: { A1: { callsign: 'A1' } as CallsignInfoRes },
    tagsMap: {
      3: { id: 3, label: 'tag-3', isPalitra: false } as Tag,
    },
    tagsOrder: [3],
    featureStrictNetworks: false,
  };

  return { container, root, onClose, props };
}

function assertSharedShell(container: HTMLElement, messageId: number) {
  const header = container.querySelector('header');
  const content = container.querySelector('main');
  const footer = container.querySelector('footer');

  expect(header?.textContent).toContain('Додане повідомлення');
  expect(header?.textContent).toContain(String(messageId));
  expect(header?.querySelector('button[aria-label="Закрити"]')).not.toBeNull();
  expect(content).not.toBeNull();
  expect(footer).not.toBeNull();

  const footerButtons = footer?.querySelectorAll('button');
  expect(footerButtons).toHaveLength(1);
  expect(footerButtons?.[0]?.textContent).toBe('Закрити');
  expect(footerButtons?.[0]?.getAttribute('variant')).not.toBe('contained');
  expect(footerButtons?.[0]?.getAttribute('fullWidth')).toBeNull();
  expect(content?.textContent).not.toContain('Закрити');

  return { content, footer, header, footerButton: footerButtons?.[0] as HTMLButtonElement };
}

describe('CreatedMessagePreviewDrawer', () => {
  beforeEach(() => {
    drawerPropsHistory.splice(0);
    messageCardPropsHistory.splice(0);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a full message preview with a fixed header and footer close control', async () => {
    const message = buildMessage();
    const { container, root, onClose, props } = renderDrawer({
      kind: 'message',
      messageId: 77,
      message,
    });

    await act(async () => {
      root.render(<CreatedMessagePreviewDrawer {...props} />);
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const { footer, header } = assertSharedShell(container, 77);
    expect(container.querySelector('[data-testid="message-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="message-text"]')?.textContent).toBe(
      'preview body',
    );

    const cardProps = messageCardPropsHistory.at(-1) as Record<string, unknown>;
    expect(cardProps?.readOnly).toBe(true);
    expect(cardProps?.groupName).toBe('Group Alpha');
    expect(cardProps?.senderName).toBe('Sender Alpha');
    expect(cardProps?.networkDisplayMap).toBe(props.networkDisplayMap);
    expect(cardProps?.networkMap).toBe(props.networkMap);
    expect(cardProps?.unitsMap).toBe(props.unitsMap);
    expect(cardProps?.callsignInfoMap).toBe(props.callsignInfoMap);
    expect(cardProps?.tagsMap).toBe(props.tagsMap);
    expect(cardProps?.tagsOrder).toBe(props.tagsOrder);
    expect(cardProps?.onBookmark).toBeUndefined();
    expect(cardProps?.onImportant).toBeUndefined();
    expect(cardProps?.onComment).toBeUndefined();
    expect(cardProps?.onDelete).toBeUndefined();
    expect(cardProps?.onToggleTag).toBeUndefined();

    await act(async () => {
      footer?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      header
        ?.querySelector('button[aria-label="Закрити"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const drawerProps = drawerPropsHistory.at(-1);
    drawerProps?.onClose?.();
    drawerProps?.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(4);

    await act(async () => {
      root.unmount();
    });
  });

  it('opens a receipt preview without mounting the message card', async () => {
    const { container, root, onClose, props } = renderDrawer({
      kind: 'receipt',
      messageId: 88,
      warning: 'fallback failed',
    });

    await act(async () => {
      root.render(<CreatedMessagePreviewDrawer {...props} />);
    });

    const { footer, header } = assertSharedShell(container, 88);
    expect(container.textContent).toContain('Повідомлення створено.');
    expect(container.textContent).toContain('ID повідомлення: 88');
    expect(container.textContent).toContain('fallback failed');
    expect(container.querySelector('[data-testid="message-card"]')).toBeNull();

    await act(async () => {
      footer?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      header
        ?.querySelector('button[aria-label="Закрити"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const drawerProps = drawerPropsHistory.at(-1);
    drawerProps?.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(3);

    await act(async () => {
      root.unmount();
    });
  });

  it('renders nothing for closed state', async () => {
    const { container, root, props } = renderDrawer({ kind: 'closed' }, { open: false });

    await act(async () => {
      root.render(<CreatedMessagePreviewDrawer {...props} />);
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
