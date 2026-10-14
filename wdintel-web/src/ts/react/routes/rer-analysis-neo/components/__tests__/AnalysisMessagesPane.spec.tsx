/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELLIPSIS } from '../../../../utils/misc';

import type { InboxMessage, SignalGroupEntry } from '../../../../../../Bindings';

const debugRuntime = vi.hoisted(() => {
  let recording = false;
  let recordingId: string | null = null;
  const aliases = new Map<string, string>();
  return {
    record: vi.fn(),
    alias: vi.fn((scope: string, value: string | number) => {
      const key = `${scope}:${value}`;
      if (!aliases.has(key)) aliases.set(key, `{${scope}_${aliases.size + 1}}`);
      return aliases.get(key)!;
    }),
    isRecording: vi.fn(() => recording),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({ state: recording ? 'recording' : 'idle', recordingId })),
    start() {
      recording = true;
      recordingId = 'recording-1';
    },
    reset() {
      recording = false;
      recordingId = null;
      aliases.clear();
      this.record.mockReset();
      this.alias.mockClear();
      this.isRecording.mockClear();
      this.subscribe.mockClear();
      this.snapshot.mockClear();
    },
  };
});

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
    } & Record<string, unknown>
  >(({ children, component, sx: _sx, ...props }, ref) =>
    component === 'ul' ? (
      <ul {...props}>{children}</ul>
    ) : (
      <div {...props} ref={ref}>
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
    onCreateReport: (etalonDisplayModel: unknown, focusTarget: HTMLElement) => void;
    onEditReport?: (id: number) => void;
    onDelete: () => void;
    onEditDetails: (focusTarget: HTMLElement) => void;
    onCopyEtalon?: () => void;
    onCopyLocation?: () => void;
    messageComments?: Array<{ id: number; login: string; comment: string }>;
    senderName?: string | null;
    tagsLayout?: string;
    hideBotTags?: boolean;
    analysisCallsignActions?: { onAddCallsign: () => void; onRemoveCallsign: () => void };
  }) => (
    <div data-testid={`message-card-${props.id}`} data-message-id={props.id}>
      <span data-testid={`sender-${props.id}`}>{props.senderName ?? ''}</span>
      <span data-testid={`tags-layout-${props.id}`}>{props.tagsLayout ?? 'unset'}</span>
      <span data-testid={`hide-bot-tags-${props.id}`}>{String(props.hideBotTags ?? false)}</span>
      <span data-testid={`comments-${props.id}`}>
        {(props.messageComments ?? [])
          .map((comment) => `${comment.login}:${comment.comment}`)
          .join('|')}
      </span>
      <button
        type="button"
        onClick={(event) =>
          props.onCreateReport(
            {
              primaryKind: 'network',
              displayValue: 'р/м Актуальна мережа',
              copyEtalonValue: 'р/м Актуальна мережа',
              copyLocationValue: null,
              renderedNetworks: [{ networkId: 3, label: 'р/м Актуальна мережа', badge: false }],
              showInlineLocationTooltip: false,
              locationDisplayValue: null,
            },
            event.currentTarget,
          )
        }
      >
        report-{props.id}
      </button>
      <button type="button" onClick={() => props.onEditReport?.(91)}>
        edit-report-{props.id}
      </button>
      <button type="button" onClick={props.onDelete}>
        delete-{props.id}
      </button>
      <button type="button" onClick={(event) => props.onEditDetails(event.currentTarget)}>
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

vi.mock('../../../../../debug-recorder', () => ({
  recordDebugEvent: debugRuntime.record,
  aliasDebugIdentifier: debugRuntime.alias,
  isBrowserDebugRecording: debugRuntime.isRecording,
  subscribeBrowserDebugRecorder: debugRuntime.subscribe,
  getBrowserDebugRecorderSnapshot: debugRuntime.snapshot,
}));

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
    hideBotTags: false,
    showCallsignAddForm: false,
    viewportPreservationKey: 0,
    onViewportCaptureChange: vi.fn(),
    onVisiblePageChange: vi.fn(),
    onPageNavigationHandled: vi.fn(),
    pageNavigationTarget: null,
    scrollResetKey: 'initial',
    directMessageNavigation: null,
    onOpenPointsOnMap: vi.fn(),
    onAddPointHighlightBlacklist: vi.fn().mockResolvedValue(undefined),
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
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(scrollBox, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(scrollBox, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight));
    },
  });
}

async function flushAnimationFrames(count = 4): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  }
}

describe('AnalysisMessagesPane', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => debugRuntime.reset());

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.useRealTimers();
  });

  it('records a trailing scroll snapshot during a debug session', async () => {
    vi.useFakeTimers();
    debugRuntime.start();
    const renderedPane = await renderComponent(
      buildProps({ messages: [[771111, buildMessage()]], pageIndex: 2 }),
    );
    rendered.push(renderedPane);
    const scrollBox = renderedPane.container.querySelector<HTMLElement>(
      '[data-analysis-message-scroller]',
    );
    const message = renderedPane.container.querySelector<HTMLElement>('[data-message-id="771111"]');
    if (scrollBox == null || message == null) throw new Error('Analysis scroll fixture is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 2_000, scrollTop: 400 });
    scrollBox.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    message.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect;

    await act(async () => {
      scrollBox.dispatchEvent(new Event('scroll', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(debugRuntime.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'analysis.scroll.snapshot',
        details: expect.objectContaining({
          scrollTop: 400,
          pageIndex: 2,
          visibleCount: 1,
          firstVisibleId: expect.stringMatching(/^\{message_/),
        }),
      }),
    );
    expect(JSON.stringify(debugRuntime.record.mock.calls)).not.toContain('771111');
  });

  it('highlights a direct-link target without scrolling the message viewport', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const renderedPane = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        directMessageNavigation: {
          targetMessageId: 7,
          targetMessageIndex: 0,
          totalCount: 1,
          focusActive: true,
          newestFirst: true,
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
    rendered.push(renderedPane);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      renderedPane.container
        .querySelector('[data-testid="message-card-7"] span')
        ?.getAttribute('style'),
    ).toContain('outline');
  });

  it('shows the empty state when there are no messages', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає жодного повідомлення для аналізу.');
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

  it('ECHO-3501 passes the bot tag setting through to analysis message cards', async () => {
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage()]],
        hideBotTags: true,
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="hide-bot-tags-7"]')?.textContent).toBe(
      'true',
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

  it('wires report creation and editing into the page callbacks', async () => {
    const onCreateReport = vi.fn();
    const onEditReport = vi.fn();
    const view = await renderComponent(
      buildProps({
        messages: [[7, buildMessage({ networkIds: [3], networkName: 'Застаріла мережа' })]],
        networkDisplayMap: { 3: 'р/м Актуальна мережа' },
        onCreateReport,
        onEditReport,
      }),
    );
    rendered.push(view);

    const createReportButton = getButton(view.container, 'report-7');
    await click(createReportButton);
    await click(getButton(view.container, 'edit-report-7'));

    expect(onCreateReport).toHaveBeenCalledWith(
      7,
      {
        primaryKind: 'network',
        displayValue: 'р/м Актуальна мережа',
        copyEtalonValue: 'р/м Актуальна мережа',
        copyLocationValue: null,
        renderedNetworks: [{ networkId: 3, label: 'р/м Актуальна мережа', badge: false }],
        showInlineLocationTooltip: false,
        locationDisplayValue: null,
      },
      createReportButton,
    );
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

    const editButton = getButton(view.container, 'edit-7');
    editButton.focus();
    await click(editButton);

    expect(onOpenEditor).toHaveBeenCalledWith(7, editButton);
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

  it('keeps a prepended newest message visible during leading-edge viewport preservation', async () => {
    let captureViewport: (() => void) | null = null;
    const initialProps = buildProps({
      messages: [[7, buildMessage({ text: 'previous newest' })]],
      noMoreToLoad: true,
      onViewportCaptureChange: (capture) => {
        captureViewport = capture;
      },
    });
    const view = await renderComponent(initialProps);
    rendered.push(view);

    const previousNewest = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = previousNewest?.closest('ul')?.parentElement as HTMLElement | null;
    if (previousNewest == null || scrollBox == null) {
      throw new Error('Message scroll box is missing');
    }
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 1200, scrollTop: 0 });
    scrollBox.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    let previousNewestLayoutTop = 0;
    previousNewest.getBoundingClientRect = () =>
      ({
        top: previousNewestLayoutTop - scrollBox.scrollTop,
        bottom: previousNewestLayoutTop - scrollBox.scrollTop + 100,
      }) as DOMRect;
    act(() => captureViewport?.());

    previousNewestLayoutTop = 100;
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...initialProps}
          viewportPreservationKey={1}
          messages={[
            [8, buildMessage({ text: 'new newest' })],
            [7, buildMessage({ text: 'previous newest' })],
          ]}
        />,
      );
    });

    expect(view.container.querySelector('[data-message-id="8"]')).not.toBeNull();
    expect(scrollBox.scrollTop).toBe(0);
  });

  it('keeps the viewport at the trailing edge when content appends during preservation', async () => {
    let captureViewport: (() => void) | null = null;
    const initialProps = buildProps({
      messages: [
        [8, buildMessage()],
        [7, buildMessage()],
      ],
      noMoreToLoad: true,
      onViewportCaptureChange: (capture) => {
        captureViewport = capture;
      },
    });
    const view = await renderComponent(initialProps);
    rendered.push(view);

    const messageElements = view.container.querySelectorAll<HTMLElement>('[data-message-id]');
    const scrollBox = messageElements[0]?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox == null) throw new Error('Message scroll box is missing');
    const scrollMetrics = { clientHeight: 600, scrollHeight: 1200, scrollTop: 600 };
    setScrollMetrics(scrollBox, scrollMetrics);
    scrollBox.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    messageElements.forEach((element, index) => {
      const layoutTop = index * 600;
      element.getBoundingClientRect = () =>
        ({
          top: layoutTop - scrollBox.scrollTop,
          bottom: layoutTop - scrollBox.scrollTop + 100,
        }) as DOMRect;
    });
    act(() => captureViewport?.());

    scrollMetrics.scrollHeight = 1400;
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...initialProps}
          viewportPreservationKey={1}
          messages={[
            [8, buildMessage()],
            [7, buildMessage()],
            [6, buildMessage()],
          ]}
        />,
      );
    });

    expect(scrollBox.scrollTop).toBe(800);
  });

  it('keeps the first visible message anchored during viewport preservation', async () => {
    let captureViewport: (() => void) | null = null;
    const initialProps = buildProps({
      messages: [[7, buildMessage({ text: 'before refresh' })]],
      onViewportCaptureChange: (capture) => {
        captureViewport = capture;
      },
    });
    const view = await renderComponent(initialProps);
    rendered.push(view);

    const anchor = view.container.querySelector<HTMLElement>('[data-message-id="7"]');
    const scrollBox = anchor?.closest('ul')?.parentElement as HTMLElement | null;
    if (anchor == null || scrollBox == null) throw new Error('Message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 3000, scrollTop: 700 });
    scrollBox.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    let anchorLayoutTop = 720;
    anchor.getBoundingClientRect = () =>
      ({
        top: anchorLayoutTop - scrollBox.scrollTop,
        bottom: anchorLayoutTop - scrollBox.scrollTop + 100,
      }) as DOMRect;
    act(() => captureViewport?.());

    anchorLayoutTop += 180;
    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...initialProps}
          viewportPreservationKey={1}
          messages={[[7, buildMessage({ text: 'after refresh' })]]}
        />,
      );
    });

    expect(scrollBox.scrollTop).toBe(880);
    expect(anchor.getBoundingClientRect().top).toBe(20);
  });

  it('keeps page navigation authoritative during viewport preservation', async () => {
    let captureViewport: (() => void) | null = null;
    const onPageNavigationHandled = vi.fn();
    const messages = Array.from(
      { length: 40 },
      (_, index) => [40 - index, buildMessage()] as [number, InboxMessage],
    );
    const props = buildProps({
      messages,
      onPageNavigationHandled,
      onViewportCaptureChange: (capture) => {
        captureViewport = capture;
      },
      pageIndex: 0,
    });
    const view = await renderComponent(props);
    rendered.push(view);

    const messageCard = view.container.querySelector('[data-testid="message-card-40"]');
    const scrollBox = messageCard?.closest('ul')?.parentElement as HTMLElement | null;
    if (scrollBox == null) throw new Error('Message scroll box is missing');
    setScrollMetrics(scrollBox, { clientHeight: 600, scrollHeight: 4000, scrollTop: 700 });
    scrollBox.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    scrollBox.querySelectorAll<HTMLElement>('[data-message-id]').forEach((element, index) => {
      element.getBoundingClientRect = () =>
        ({
          bottom: (index + 1) * 100 - scrollBox.scrollTop,
          top: index * 100 - scrollBox.scrollTop,
        }) as DOMRect;
    });
    act(() => captureViewport?.());

    await act(async () => {
      view.root.render(
        <AnalysisMessagesPane
          {...props}
          pageIndex={1}
          pageNavigationTarget={1}
          viewportPreservationKey={1}
        />,
      );
    });
    await flushAnimationFrames();

    expect(scrollBox.scrollTop).toBe(2000);
    expect(onPageNavigationHandled).toHaveBeenCalledOnce();
  });
});
