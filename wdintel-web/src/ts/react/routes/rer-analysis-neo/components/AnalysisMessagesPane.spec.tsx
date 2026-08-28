/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { ELLIPSIS } from '../../../utils/misc';

import type { InboxMessage, SignalGroupEntry } from '../../../../../Bindings';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { component?: string }>(
    ({ children, component, ...props }, ref) => {
      if (component === 'ul') {
        return (
          <ul role={props.role} aria-label={props['aria-label']} aria-live={props['aria-live']}>
            {children}
          </ul>
        );
      }
      if (component === 'li') {
        return (
          <li role={props.role} aria-label={props['aria-label']} data-testid={props['data-testid']}>
            {children}
          </li>
        );
      }
      return (
        <div ref={ref} {...props}>
          {children}
        </div>
      );
    },
  ),
  CircularProgress: () => <div>loading</div>,
  Skeleton: () => <span data-skeleton="true" />,
}));

vi.mock('../../shared/message-card/MessageCard', () => ({
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
    <div
      data-testid={`message-card-${props.id}`}
      data-message-id={props.id}
      data-message-card-root="true"
    >
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

vi.mock('../../rer-duty-neo/dialogs', () => ({
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

vi.mock('../message-utils', async () => {
  const actual = await vi.importActual<typeof import('../message-utils')>('../message-utils');
  return {
    ...actual,
    copyMessageValue: vi.fn().mockResolvedValue(undefined),
  };
});

import { AnalysisMessagesPane, getAnalysisMessagesScrollSx } from './AnalysisMessagesPane';

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
    scrollResetKey: 'initial',
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
    directMessageNavigation: null,
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

function setScrollMetrics(
  scrollBox: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(scrollBox, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(scrollBox, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(scrollBox, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight));
    },
  });
}

async function scroll(scrollBox: HTMLElement): Promise<void> {
  await act(async () => {
    scrollBox.dispatchEvent(new Event('scroll', { bubbles: true }));
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it('shows message skeletons while loading another page', async () => {
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], paginationLoading: true }),
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[aria-label="Завантаження ще повідомлень"]'),
    ).not.toBeNull();
    expect(view.container.querySelectorAll('[data-skeleton="true"]')).toHaveLength(10);
  });

  it('shows direct-link skeletons on both edges while both sides load', async () => {
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: false,
      canLoadLater: false,
      loadingEarlier: true,
      loadingLater: true,
      onClearFocus: vi.fn(),
      onLoadEarlier: vi.fn().mockResolvedValue(true),
      onLoadLater: vi.fn().mockResolvedValue(false),
    };
    const messages: Array<[number, InboxMessage]> = [[7, buildMessage()]];
    const view = await renderComponent(
      buildProps({ messages, paginationLoading: true, directMessageNavigation }),
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="message-loading-skeletons-above"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="message-loading-skeletons-below"]'),
    ).not.toBeNull();

    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...buildProps({
            messages,
            paginationLoading: true,
            directMessageNavigation: { ...directMessageNavigation, newestFirst: true },
          })}
        />,
      );
    });

    expect(
      view.container.querySelector('[data-testid="message-loading-skeletons-below"]'),
    ).not.toBeNull();
    expect(view.container.textContent).not.toContain('loading');
  });

  it('uses a theme-aware scrollbar thumb in the messages pane', () => {
    const lightTheme = createTheme({ palette: { mode: 'light' } });
    const darkTheme = createTheme({ palette: { mode: 'dark' } });

    const lightSx = getAnalysisMessagesScrollSx(lightTheme);
    const darkSx = getAnalysisMessagesScrollSx(darkTheme);

    expect(lightSx.scrollbarColor).toContain('rgba(');
    expect(lightSx.scrollbarColor).not.toContain('rgba(255, 255, 255, 0.38)');
    expect(darkSx.scrollbarColor).toBe('rgba(255, 255, 255, 0.38) transparent');
    expect(lightSx['&::-webkit-scrollbar-thumb']).toMatchObject({
      borderRadius: 999,
      border: '3px solid transparent',
      backgroundClip: 'content-box',
    });
  });

  it('uses the narrow message list as its scroll container', () => {
    const sx = getAnalysisMessagesScrollSx(createTheme());

    expect(sx.height).toBe('100%');
    expect(sx.minHeight).toBe(0);
    expect(sx.overflowY).toBe('auto');
    expect(sx.overflowX).toBe('hidden');
    expect(sx.WebkitOverflowScrolling).toBe('touch');
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

  it('does not show the global spinner while paginating', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        paginationLoading: true,
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).not.toContain('loading');
    expect(
      view.container.querySelector('[data-testid="message-loading-skeletons-below"]'),
    ).not.toBeNull();
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

  it('scrolls the message list to top when the date range changes', async () => {
    const messages: Array<[number, InboxMessage]> = [[7, buildMessage()]];
    const view = await renderComponent(buildProps({ messages, scrollResetKey: 'range-1' }));
    rendered.push(view);

    const messageCard = view.container.querySelector('[data-testid="message-card-7"]');
    const scrollBox = messageCard?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox) Object.defineProperty(scrollBox, 'scrollTop', { value: 500, writable: true });

    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane {...buildProps({ messages, scrollResetKey: 'range-2' })} />,
      );
    });

    expect(scrollBox?.scrollTop).toBe(0);
  });

  it('loads more messages shortly before reaching the bottom without a button', async () => {
    const onLoadMoreMessages = vi.fn(() => new Promise<boolean>(() => {}));
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        onLoadMoreMessages,
      }),
    );
    rendered.push(view);

    const messageCard = view.container.querySelector('[data-testid="message-card-7"]');
    const scrollBox = messageCard?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox == null) throw new Error('Message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1600, scrollTop: 500 });

    await scroll(scrollBox);
    expect(onLoadMoreMessages).not.toHaveBeenCalled();

    scrollBox.scrollTop = 640;
    await scroll(scrollBox);
    await scroll(scrollBox);

    expect(onLoadMoreMessages).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).not.toContain('Завантажити ще');
  });

  it('uses the initial direct-link window without loading extra pages', async () => {
    const onClearFocus = vi.fn();
    const onLoadEarlier = vi.fn();
    const onLoadLater = vi.fn();
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: true,
      canLoadLater: true,
      loadingEarlier: false,
      loadingLater: false,
      onClearFocus,
      onLoadEarlier,
      onLoadLater,
    };
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], directMessageNavigation }),
    );
    rendered.push(view);

    const target = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = target?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox == null) throw new Error('Target message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1600, scrollTop: 0 });

    expect(onLoadEarlier).not.toHaveBeenCalled();
    expect(onLoadLater).not.toHaveBeenCalled();
    expect(scrollBox.hasAttribute('aria-busy')).toBe(false);

    await act(async () => {
      scrollBox.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
    expect(onClearFocus).toHaveBeenCalledTimes(1);
  });

  it('centers the direct-link target in the visible message area', async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        directMessageNavigation: {
          targetMessageId: 7,
          focusActive: true,
          newestFirst: false,
          canLoadEarlier: false,
          canLoadLater: false,
          loadingEarlier: false,
          loadingLater: false,
          onClearFocus: vi.fn(),
          onLoadEarlier: vi.fn().mockResolvedValue(false),
          onLoadLater: vi.fn().mockResolvedValue(false),
        },
      }),
    );
    rendered.push(view);

    const target = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = target?.closest('ul')?.parentElement as HTMLElement | null;
    if (target == null || scrollBox == null)
      throw new Error('Target message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1600, scrollTop: 0 });
    scrollBox.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const targetLayoutTop = 500;
    let targetHeight = 100;
    target.getBoundingClientRect = () =>
      ({ top: targetLayoutTop - scrollBox.scrollTop, height: targetHeight }) as DOMRect;

    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(scrollBox.scrollTop).toBe(150);
    expect(target.getBoundingClientRect().top).toBe(350);

    targetHeight = 140;
    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(scrollBox.scrollTop).toBe(170);
    expect(target.getBoundingClientRect().top + targetHeight / 2).toBe(400);
  });

  it('keeps the target anchored when messages loaded above change their height', async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: true,
      canLoadLater: true,
      loadingEarlier: false,
      loadingLater: false,
      onClearFocus: vi.fn(),
      onLoadEarlier: vi.fn(() => new Promise<boolean>(() => {})),
      onLoadLater: vi.fn().mockResolvedValue(true),
    };
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], directMessageNavigation }),
    );
    rendered.push(view);

    const target = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = target?.closest('ul')?.parentElement as HTMLElement | null;
    if (target == null || scrollBox == null)
      throw new Error('Target message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1600, scrollTop: 0 });
    let targetLayoutTop = 300;
    target.getBoundingClientRect = () =>
      ({ top: targetLayoutTop - scrollBox.scrollTop }) as DOMRect;

    await scroll(scrollBox);

    targetLayoutTop += 60;
    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(scrollBox.scrollTop).toBe(60);
    expect(target.getBoundingClientRect().top).toBe(300);
  });

  it('keeps the target anchored when loading above finishes', async () => {
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: true,
      canLoadLater: true,
      loadingEarlier: false,
      loadingLater: false,
      onClearFocus: vi.fn(),
      onLoadEarlier: vi.fn(() => new Promise<boolean>(() => {})),
      onLoadLater: vi.fn().mockResolvedValue(true),
    };
    const messages: Array<[number, InboxMessage]> = [[7, buildMessage()]];
    const view = await renderComponent(buildProps({ messages, directMessageNavigation }));
    rendered.push(view);

    const target = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = target?.closest('ul')?.parentElement as HTMLElement | null;
    if (target == null || scrollBox == null)
      throw new Error('Target message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1600, scrollTop: 100 });
    let targetLayoutTop = 300;
    target.getBoundingClientRect = () =>
      ({ top: targetLayoutTop - scrollBox.scrollTop }) as DOMRect;

    await scroll(scrollBox);

    targetLayoutTop += 40;
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...buildProps({
            messages,
            directMessageNavigation: { ...directMessageNavigation, canLoadEarlier: false },
          })}
        />,
      );
    });

    expect(scrollBox.scrollTop).toBe(40);
    expect(target.getBoundingClientRect().top).toBe(300);
  });

  it('adds only the missing bottom scroll space before loading above a short list', async () => {
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: false,
      canLoadLater: false,
      loadingEarlier: false,
      loadingLater: false,
      onClearFocus: vi.fn(),
      onLoadEarlier: vi.fn(() => new Promise<boolean>(() => {})),
      onLoadLater: vi.fn().mockResolvedValue(false),
    };
    const view = await renderComponent(
      buildProps({ messages: [[7, buildMessage()]], directMessageNavigation }),
    );
    rendered.push(view);

    const target = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = target?.closest('ul')?.parentElement as HTMLElement | null;
    if (target == null || scrollBox == null)
      throw new Error('Target message scroll box is missing');
    let baseContentHeight = 300;
    let scrollTop = 0;
    let targetLayoutTop = 200;
    Object.defineProperty(scrollBox, 'clientHeight', { value: 600 });
    Object.defineProperty(scrollBox, 'scrollHeight', {
      get: () => {
        const spacer = view.container.querySelector<HTMLElement>(
          '[data-direct-message-anchor-spacer="true"]',
        );
        return Math.max(
          scrollBox.clientHeight,
          baseContentHeight + Number.parseFloat(spacer?.style.height ?? '0'),
        );
      },
    });
    Object.defineProperty(scrollBox, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollBox.scrollHeight - scrollBox.clientHeight));
      },
    });
    target.getBoundingClientRect = () => ({ top: targetLayoutTop - scrollTop }) as DOMRect;
    scrollBox.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    const bottomContent = scrollBox.lastElementChild;
    if (!(bottomContent instanceof HTMLElement)) throw new Error('Bottom content is missing');
    bottomContent.getBoundingClientRect = () => ({ bottom: 300 }) as DOMRect;

    const loadingNavigation = { ...directMessageNavigation, canLoadEarlier: true };
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...buildProps({
            messages: [[7, buildMessage()]],
            directMessageNavigation: loadingNavigation,
          })}
        />,
      );
    });

    expect(
      view.container.querySelector<HTMLElement>('[data-direct-message-anchor-spacer="true"]')?.style
        .height,
    ).toBe('300px');

    baseContentHeight += 200;
    targetLayoutTop += 200;
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...buildProps({
            messages: [
              [6, buildMessage()],
              [7, buildMessage()],
            ],
            directMessageNavigation: loadingNavigation,
          })}
        />,
      );
    });

    expect(scrollTop).toBe(100);
    expect(target.getBoundingClientRect().top).toBe(300);
  });

  it('does not render direct-link load controls for exhausted directions', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        directMessageNavigation: {
          targetMessageId: 7,
          focusActive: true,
          newestFirst: false,
          canLoadEarlier: false,
          canLoadLater: false,
          loadingEarlier: false,
          loadingLater: false,
          onClearFocus: vi.fn(),
          onLoadEarlier: vi.fn().mockResolvedValue(false),
          onLoadLater: vi.fn().mockResolvedValue(false),
        },
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).not.toContain('Показати ще');
  });

  it('does not render a direct-link filter action and clears URL focus on user scroll', async () => {
    const onClearFocus = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        directMessageNavigation: {
          targetMessageId: 7,
          focusActive: true,
          newestFirst: false,
          canLoadEarlier: true,
          canLoadLater: true,
          loadingEarlier: false,
          loadingLater: false,
          onClearFocus,
          onLoadEarlier: vi.fn().mockResolvedValue(true),
          onLoadLater: vi.fn().mockResolvedValue(true),
        },
      }),
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[aria-label="Опції фільтра для показу повідомлень"]'),
    ).toBeNull();

    const messageCard = view.container.querySelector('[data-testid="message-card-7"]');
    const scrollBox = messageCard?.closest('ul')?.parentElement;
    scrollBox?.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(onClearFocus).toHaveBeenCalledTimes(1);
  });

  it('keeps the direct-link highlight until scrolling clears the URL focus', async () => {
    vi.useFakeTimers();
    const onClearFocus = vi.fn();
    const directMessageNavigation = {
      targetMessageId: 7,
      focusActive: true,
      newestFirst: false,
      canLoadEarlier: false,
      canLoadLater: false,
      loadingEarlier: false,
      loadingLater: false,
      onClearFocus,
      onLoadEarlier: vi.fn().mockResolvedValue(false),
      onLoadLater: vi.fn().mockResolvedValue(false),
    };
    const messages: Array<[number, InboxMessage]> = [[7, buildMessage()]];
    const view = await renderComponent(buildProps({ messages, directMessageNavigation }));
    rendered.push(view);

    const messageCard = view.container.querySelector<HTMLElement>('[data-testid="message-card-7"]');
    if (messageCard == null) throw new Error('Target message card is missing');
    expect(messageCard.style.outlineOffset).toBe('-2px');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(messageCard.style.outlineOffset).toBe('-2px');

    messageCard.parentElement?.parentElement?.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true }),
    );
    expect(onClearFocus).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...buildProps({
            messages,
            directMessageNavigation: { ...directMessageNavigation, focusActive: false },
          })}
        />,
      );
    });
    expect(messageCard.style.outlineOffset).toBe('');
  });
});
