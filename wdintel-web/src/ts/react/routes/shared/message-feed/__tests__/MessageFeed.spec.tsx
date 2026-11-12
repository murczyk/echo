/** @vitest-environment happy-dom */
import { act, createRef, startTransition, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageFeed,
  MessageFeedItem,
  ScrollNavigationIntent,
  type MessageFeedHandle,
  type MessageFeedPolicy,
  type UseWindowedFeedScrollOptions,
  type WindowedFeedScrollHandle,
} from '..';
import { useWindowedFeedScroll } from '../useWindowedFeedScroll';
import { MessageFeedViewport } from '../MessageFeedViewport';

let scroll: WindowedFeedScrollHandle;
let itemHeight = 50;
let width = 200;
let viewportHeight = 100;
let clampScrollHeightToViewport = false;
let resize: () => void;
const getId = (id: number) => id;
const renderMessage = (id: number) => <div data-message-id={id}>message {id}</div>;

const historyPolicy: MessageFeedPolicy = {
  initialPosition: 'start',
  followAtBottom: false,
  aboveLoadBufferPx: 480,
  belowLoadBufferPx: 480,
  atBottomThresholdPx: 25,
  underfilledEdgeLoading: false,
  deferResizeWhileLoadingBelow: false,
};

function TestFeed({
  ids,
  resetKey = 'one',
  options,
  suspend,
  aboveSkeleton = false,
}: {
  ids: number[];
  resetKey?: string;
  options?: Partial<UseWindowedFeedScrollOptions>;
  suspend?: Promise<never>;
  aboveSkeleton?: boolean;
}) {
  scroll = useWindowedFeedScroll({
    itemIds: ids,
    loadingOlder: false,
    hasReachedStart: !aboveSkeleton,
    onLoadOlder: () => undefined,
    autoScrollAllowed: false,
    resetKey,
    ...options,
  });
  if (suspend) throw suspend;
  if (ids.length === 0) return <div>No messages</div>;
  return (
    <MessageFeedViewport
      scroll={scroll}
      items={ids}
      getMessageId={getId}
      renderMessage={renderMessage}
      beforeMessages={aboveSkeleton ? <div data-test-skeleton /> : null}
    />
  );
}

function bounds(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    width,
    left: 0,
    right: width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('MessageFeed integration — https://github.com/echoua/echo/issues/3689', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    itemHeight = 50;
    width = 200;
    viewportHeight = 100;
    clampScrollHeightToViewport = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const callbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {
          callbacks.add(callback);
        }
        observe() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
      },
    );
    resize = () => callbacks.forEach((callback) => callback([], {} as ResizeObserver));
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const spacer = this.querySelector<HTMLElement>('[data-direct-message-anchor-spacer]');
      const contentHeight =
        this.querySelectorAll('[data-message-id]').length * itemHeight +
        (this.querySelector('[data-test-skeleton]') ? 10 : 0) +
        Number.parseFloat(spacer?.style.height ?? '0');
      return clampScrollHeightToViewport ? Math.max(viewportHeight, contentHeight) : contentHeight;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const scroller = this.closest<HTMLElement>('[data-message-feed-scroller]');
      if (!scroller || this === scroller) return bounds(0, viewportHeight);
      const items = Array.from(scroller.querySelectorAll('[data-message-id]'));
      if (this.classList.contains('message-feed-list')) {
        return bounds(
          -scroller.scrollTop,
          items.length * itemHeight + (scroller.querySelector('[data-test-skeleton]') ? 10 : 0),
        );
      }
      const index = items.indexOf(this);
      return bounds(
        index < 0
          ? 0
          : index * itemHeight +
              (scroller.querySelector('[data-test-skeleton]') ? 10 : 0) -
              scroller.scrollTop,
        itemHeight,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers component-owned navigation through the public MessageFeed API', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[1, 2]}
          getMessageId={getId}
          scrollOptions={{
            hasReachedStart: true,
            onLoadOlder: () => undefined,
            autoScrollAllowed: false,
          }}
        >
          <div data-message-id="1">first</div>
          <div data-message-id="2">second</div>
        </MessageFeed>,
      ),
    );
    expect(feedRef.current?.scrollToMessage(2)).toBe(
      container.querySelector('[data-message-id="2"]'),
    );
  });

  it('keeps a linked card highlighted through scrolling until a new chunk commits', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const scrollOptions = {
      hasReachedStart: false,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    const renderFeed = (ids: number[], loadingAbove: boolean) => (
      <MessageFeed
        ref={feedRef}
        items={ids}
        getMessageId={getId}
        scrollOptions={scrollOptions}
        loadingAbove={loadingAbove}
        hasMoreAbove
        renderMessage={(id) => (
          <div data-message-id={id}>
            <div data-message-card-root>message {id}</div>
          </div>
        )}
      />
    );
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(renderFeed([1, 2], false)));
    await act(async () => feedRef.current?.highlightLinkedMessage(2));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');

    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 })));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');

    await act(async () => root.render(renderFeed([1, 2], true)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');
    await act(async () => root.render(renderFeed([0, 1, 2], false)));
    expect(highlighted()).toBeNull();
  });

  it('clears a linked highlight when a buffered newer chunk reaches the visible feed', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const initialItems = [1, 2];
    const renderFeed = (
      items: number[],
      loadingBelow: boolean,
      pendingNewerFlushNeeded: boolean,
    ) => (
      <MessageFeed
        ref={feedRef}
        items={items}
        getMessageId={getId}
        scrollOptions={{
          hasReachedStart: true,
          onLoadOlder: () => undefined,
          autoScrollAllowed: false,
          pendingNewerFlushNeeded,
        }}
        loadingBelow={loadingBelow}
        hasMoreBelow
        renderMessage={renderMessage}
      />
    );
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(renderFeed(initialItems, false, false)));
    await act(async () => feedRef.current?.highlightLinkedMessage(1));
    await act(async () => root.render(renderFeed(initialItems, true, false)));
    await act(async () => root.render(renderFeed(initialItems, false, true)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('1');

    await act(async () => root.render(renderFeed([1, 2, 3], false, false)));
    expect(highlighted()).toBeNull();
  });

  it('clears a linked highlight when live messages arrive without a loading phase', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const renderFeed = (items: number[]) => (
      <MessageFeed
        ref={feedRef}
        items={items}
        getMessageId={getId}
        scrollOptions={{ hasReachedStart: true, onLoadOlder: () => undefined }}
        renderMessage={renderMessage}
      />
    );
    await act(async () => root.render(renderFeed([1, 2])));
    await act(async () => feedRef.current?.highlightLinkedMessage(2));
    expect(container.querySelector('[data-message-feed-highlighted]')).not.toBeNull();
    await act(async () => root.render(renderFeed([1, 2, 3])));
    expect(container.querySelector('[data-message-feed-highlighted]')).toBeNull();
  });

  it('clears a linked highlight when an already-buffered newer chunk is flushed', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const renderFeed = (items: number[], pendingNewerFlushNeeded: boolean) => (
      <MessageFeed
        ref={feedRef}
        items={items}
        getMessageId={getId}
        scrollOptions={{
          hasReachedStart: true,
          onLoadOlder: () => undefined,
          autoScrollAllowed: false,
          pendingNewerFlushNeeded,
        }}
        hasMoreBelow
        renderMessage={renderMessage}
      />
    );
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(renderFeed([1, 2], true)));
    await act(async () => feedRef.current?.highlightLinkedMessage(1));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('1');

    await act(async () => root.render(renderFeed([1, 2, 3], false)));
    expect(highlighted()).toBeNull();
  });

  it('keeps an editor source highlighted through content refresh and clears it on close', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const scrollOptions = {
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    const renderFeed = (
      ids: number[],
      editorHighlightedMessageId: number | null,
      isLoading = false,
    ) => (
      <MessageFeed
        ref={feedRef}
        items={ids}
        getMessageId={getId}
        scrollOptions={scrollOptions}
        editorHighlightedMessageId={editorHighlightedMessageId}
        isLoading={isLoading}
        renderMessage={(id) => (
          <div data-message-id={id}>
            <div data-message-card-root>message {id}</div>
          </div>
        )}
      />
    );
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(renderFeed([1, 2], null)));
    await act(async () => feedRef.current?.highlightLinkedMessage(1));
    await act(async () => root.render(renderFeed([1, 2], 2)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');
    await act(async () => root.render(renderFeed([1, 2], null)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('1');
    await act(async () => root.render(renderFeed([1, 2], 2)));

    await act(async () => root.render(renderFeed([1, 2], 2, true)));
    await act(async () => root.render(renderFeed([1, 2], 2)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');
    await act(async () => root.render(renderFeed([1, 2], null)));
    expect(highlighted()).toBeNull();
  });

  it('preserves a linked highlight on failed load and clears it on a successful reload', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const scrollOptions = {
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    const messages = [1, 2];
    const renderFeed = (items: number[], isLoading: boolean) => (
      <MessageFeed
        ref={feedRef}
        items={items}
        getMessageId={getId}
        scrollOptions={scrollOptions}
        isLoading={isLoading}
        renderMessage={(id) => <div data-message-id={id}>message {id}</div>}
      />
    );
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(renderFeed(messages, false)));
    await act(async () => feedRef.current?.highlightLinkedMessage(2));
    await act(async () => root.render(renderFeed(messages, true)));
    await act(async () => root.render(renderFeed(messages, false)));
    expect(highlighted()?.getAttribute('data-message-id')).toBe('2');

    await act(async () => root.render(renderFeed(messages, true)));
    await act(async () => root.render(renderFeed([...messages], false)));
    expect(highlighted()).toBeNull();
  });

  it('reports the newest edge through optional navigation for both list directions', async () => {
    const scrollOptions = {
      policy: historyPolicy,
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    const renderControl = (atNewestEdge: boolean) => (
      <button data-newest-navigation data-at-newest-edge={String(atNewestEdge)} />
    );
    const renderFeed = (edge: 'top' | 'bottom') => (
      <MessageFeed
        items={[1, 2, 3, 4, 5]}
        getMessageId={getId}
        scrollOptions={scrollOptions}
        newestNavigation={{ edge, renderControl }}
        renderMessage={renderMessage}
      />
    );

    await act(async () => root.render(renderFeed('top')));
    const control = container.querySelector<HTMLElement>('[data-newest-navigation]');
    expect(control?.dataset.atNewestEdge).toBe('true');

    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () => {
      scroller.scrollTop = 150;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(control?.dataset.atNewestEdge).toBe('false');

    await act(async () => root.render(renderFeed('bottom')));
    expect(control?.dataset.atNewestEdge).toBe('true');
  });

  it('navigates to a composed child without a host-owned scroll hook', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[1, 2]}
          getMessageId={getId}
          scrollOptions={{
            hasReachedStart: true,
            onLoadOlder: () => undefined,
            autoScrollAllowed: false,
          }}
        >
          <div data-message-id="1">message 1</div>
          <div data-message-id="2">message 2</div>
        </MessageFeed>,
      ),
    );
    const target = container.querySelector<HTMLElement>('[data-message-id="2"]');
    expect(feedRef.current?.scrollToMessage(2)).toBe(target);
  });

  it('keeps native registered rows and scroll state separate across feed instances', async () => {
    const firstRef = createRef<MessageFeedHandle>();
    const secondRef = createRef<MessageFeedHandle>();
    const scrollOptions = {
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    await act(async () =>
      root.render(
        <>
          <MessageFeed
            ref={firstRef}
            items={[11]}
            getMessageId={getId}
            itemSelector="[data-duty-message-id]"
            scrollOptions={scrollOptions}
          >
            <MessageFeedItem id={11} data-duty-message-id="11">
              <span>first card</span>
            </MessageFeedItem>
          </MessageFeed>
          <MessageFeed
            ref={secondRef}
            items={[22]}
            getMessageId={getId}
            itemSelector="[data-duty-message-id]"
            scrollOptions={scrollOptions}
          >
            <MessageFeedItem id={22} data-duty-message-id="22">
              <span>second card</span>
            </MessageFeedItem>
          </MessageFeed>
        </>,
      ),
    );
    const firstRow = container.querySelector<HTMLElement>('[data-duty-message-id="11"]');
    const secondRow = container.querySelector<HTMLElement>('[data-duty-message-id="22"]');
    expect(firstRow?.firstElementChild?.textContent).toBe('first card');
    expect(secondRow?.firstElementChild?.textContent).toBe('second card');
    expect(firstRef.current?.getItemElement(11)).toBe(firstRow);
    expect(firstRef.current?.getItemElement(22)).toBeNull();
    expect(secondRef.current?.getItemElement(22)).toBe(secondRow);
    expect(secondRef.current?.getItemElement(11)).toBeNull();
    expect(firstRef.current?.getScrollerElement()).not.toBe(
      secondRef.current?.getScrollerElement(),
    );
  });

  it('shows an initial feed skeleton without registering placeholder cards as messages', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[] as number[]}
          getMessageId={getId}
          scrollOptions={{
            hasReachedStart: true,
            onLoadOlder: () => undefined,
            enabled: false,
          }}
          isLoading
          skeletonCount={3}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-message-feed-skeleton-card]')).toHaveLength(3);
    expect(
      container.querySelector(
        '[data-message-feed-skeleton-card] button, [data-message-feed-skeleton-card] a',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-message-feed-skeleton="initial"]')?.getAttribute('role'),
    ).toBe('status');
    expect(container.querySelector('[data-message-feed-scroller]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(feedRef.current?.getItemElement(1)).toBeNull();
    expect(container.querySelector('[data-message-id]')).toBeNull();
  });

  it('lands on a focused card after the initial skeleton is replaced', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const options = {
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
      focus: { messageId: 2, active: true },
    };
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[]}
          getMessageId={getId}
          scrollOptions={options}
          isLoading
        />,
      ),
    );
    expect(feedRef.current?.getItemElement(2)).toBeNull();
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[1, 2, 3, 4]}
          getMessageId={getId}
          scrollOptions={options}
          renderMessage={renderMessage}
        />,
      ),
    );
    expect(feedRef.current?.getItemElement(2)).toBe(
      container.querySelector('[data-message-id="2"]'),
    );
    expect(container.querySelector('[data-message-feed-skeleton]')).toBeNull();
  });

  it('keeps refresh skeletons inside the list without replacing cards or moving scroll', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    const scrollOptions = {
      hasReachedStart: true,
      onLoadOlder: () => undefined,
      autoScrollAllowed: false,
    };
    const render = (isLoading: boolean) => (
      <MessageFeed
        ref={feedRef}
        items={[1, 2, 3, 4]}
        getMessageId={getId}
        scrollOptions={scrollOptions}
        isLoading={isLoading}
        renderMessage={renderMessage}
      />
    );
    await act(async () => root.render(render(false)));
    const scroller = feedRef.current!.getScrollerElement()!;
    const card = feedRef.current!.getItemElement(2);
    await act(async () => {
      scroller.scrollTop = 48;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => root.render(render(true)));
    expect(feedRef.current?.getItemElement(2)).toBe(card);
    expect(scroller.scrollTop).toBe(48);
    expect(container.querySelector('[data-message-feed-skeleton="refresh"]')).not.toBeNull();
    expect(container.querySelector('.message-feed-refresh-overlay')?.parentElement).toBe(
      container.querySelector('.message-feed-list'),
    );
    expect(scroller.getAttribute('data-message-feed-refreshing')).toBe('true');
    await act(async () => root.render(render(false)));
    expect(feedRef.current?.getItemElement(2)).toBe(card);
    expect(scroller.scrollTop).toBe(48);
  });

  it('keeps available edge skeletons in list order and out of the item registry', async () => {
    const feedRef = createRef<MessageFeedHandle>();
    await act(async () =>
      root.render(
        <MessageFeed
          ref={feedRef}
          items={[1]}
          getMessageId={getId}
          scrollOptions={{
            hasReachedStart: false,
            onLoadOlder: () => undefined,
            onLoadNewer: () => undefined,
            unreadPrefetchNeeded: true,
            autoScrollAllowed: false,
            enabled: false,
          }}
          hasMoreAbove
          hasMoreBelow
          listTag="ul"
          renderMessage={(id) => <li data-message-id={id}>message {id}</li>}
        />,
      ),
    );
    expect(container.querySelectorAll('ul.message-feed-list > li')).toHaveLength(3);
    expect(container.querySelectorAll('[data-message-feed-skeleton-card]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-message-feed-skeleton]')).toHaveLength(2);
    for (const edge of ['above', 'below']) {
      const skeleton = container.querySelector(`[data-message-feed-skeleton="${edge}"]`);
      const placeholders = skeleton?.querySelectorAll('.MuiSkeleton-root');
      expect(placeholders?.length).toBeGreaterThan(0);
      expect(skeleton?.querySelectorAll('.MuiSkeleton-pulse')).toHaveLength(placeholders?.length);
      expect(skeleton?.getAttribute('role')).toBeNull();
    }
    expect(
      container
        .querySelector('ul.message-feed-list > li:first-child')
        ?.getAttribute('data-message-feed-skeleton'),
    ).toBe('above');
    expect(
      container
        .querySelector('ul.message-feed-list > li:last-child')
        ?.getAttribute('data-message-feed-skeleton'),
    ).toBe('below');
    expect(feedRef.current?.getItemElement(1)).toBe(
      container.querySelector('[data-message-id="1"]'),
    );
    expect(feedRef.current?.getItemElement(2)).toBeNull();
  });

  it('does not add an edge skeleton for background loading without an available page', async () => {
    await act(async () =>
      root.render(
        <MessageFeed
          items={[1]}
          getMessageId={getId}
          scrollOptions={{
            hasReachedStart: true,
            onLoadOlder: () => undefined,
            onLoadNewer: () => undefined,
            enabled: false,
          }}
          loadingBelow
          renderMessage={renderMessage}
        />,
      ),
    );
    expect(container.querySelector('[data-message-feed-skeleton="below"]')).toBeNull();
    expect(container.querySelector('[data-message-feed-scroller]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  it('preserves the reading card through prepend and viewport resize', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => root.render(<TestFeed ids={[-1, 0, 1, 2, 3, 4]} />));
    const anchor = container.querySelector<HTMLElement>('[data-message-id="2"]')!;
    expect(anchor.getBoundingClientRect().top).toBe(-1);
    await act(async () => {
      width = 100;
      itemHeight = 100;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      resize();
    });
    expect(anchor.getBoundingClientRect().top).toBe(-1);
  });

  it('preserves the reading card through a bounded prepend and later resize', async () => {
    await act(async () =>
      root.render(
        <TestFeed ids={[1, 2, 3, 4]} aboveSkeleton options={{ policy: historyPolicy }} />,
      ),
    );
    const scroller = scroll.scrollerRef.current!;
    expect(container.querySelector('[data-message-id="1"]')!.getBoundingClientRect().top).toBe(10);

    await act(async () =>
      root.render(<TestFeed ids={[-1, 0, 1, 2]} options={{ policy: historyPolicy }} />),
    );
    const anchor = container.querySelector<HTMLElement>('[data-message-id="1"]')!;
    expect(anchor.getBoundingClientRect().top).toBe(10);

    await act(async () => {
      itemHeight = 100;
      resize();
    });
    expect(anchor.getBoundingClientRect().top).toBe(10);
    expect(scroller.scrollTop).toBe(190);
  });

  it.each(['above', 'below'] as const)(
    'keeps the %s edge skeleton and old window until wheel input settles after a fast load',
    async (edge) => {
      const renderFeed = (loading: boolean, ids: number[]) => (
        <MessageFeed
          items={ids}
          getMessageId={getId}
          renderMessage={renderMessage}
          scrollOptions={{
            policy: historyPolicy,
            hasReachedStart: edge !== 'above',
            onLoadOlder: () => undefined,
            onLoadNewer: edge === 'below' ? () => undefined : undefined,
            autoScrollAllowed: false,
          }}
          loadingAbove={edge === 'above' && loading}
          loadingBelow={edge === 'below' && loading}
          hasMoreAbove={edge === 'above' && loading}
          hasMoreBelow={edge === 'below' && loading}
        />
      );
      await act(async () => root.render(renderFeed(true, [1, 2, 3, 4])));
      const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
      const direction = edge === 'above' ? -1 : 1;
      const wheel = (deltaY: number) => {
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
        scroller.dispatchEvent(event);
        return event.defaultPrevented;
      };

      expect(wheel(direction * 40)).toBe(false);
      await act(async () => root.render(renderFeed(false, [2, 3, 4, 5])));
      expect(container.querySelector('[data-message-id="1"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="5"]')).toBeNull();
      expect(container.querySelector(`[data-message-feed-skeleton="${edge}"]`)).not.toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(wheel(direction * 30)).toBe(false);
      });
      expect(container.querySelector('[data-message-id="5"]')).toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 180));
      });
      expect(container.querySelector('[data-message-id="1"]')).toBeNull();
      expect(container.querySelector('[data-message-id="5"]')).not.toBeNull();
    },
  );

  it('keeps pre-rendered Duty cards paired with the visible item window while input continues', async () => {
    const renderFeed = (ids: number[], loading: boolean) => (
      <MessageFeed
        items={ids}
        getMessageId={getId}
        scrollOptions={{
          policy: historyPolicy,
          hasReachedStart: false,
          onLoadOlder: () => undefined,
          autoScrollAllowed: false,
        }}
        loadingAbove={loading}
        hasMoreAbove={loading}
      >
        {ids.map((id) => (
          <div data-message-id={id} key={id}>
            Duty card {id}
          </div>
        ))}
      </MessageFeed>
    );
    await act(async () => root.render(renderFeed([1, 2, 3, 4], true)));
    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 }));
      root.render(renderFeed([0, 1, 2, 3], false));
    });
    expect(container.querySelector('[data-message-id="4"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="0"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(container.querySelector('[data-message-id="4"]')).toBeNull();
    expect(container.querySelector('[data-message-id="0"]')).not.toBeNull();
  });

  it('waits for inertial scroll events after the final wheel event before committing a page', async () => {
    const renderFeed = (ids: number[], loading: boolean) => (
      <MessageFeed
        items={ids}
        getMessageId={getId}
        renderMessage={renderMessage}
        scrollOptions={{
          policy: historyPolicy,
          hasReachedStart: true,
          onLoadOlder: () => undefined,
          onLoadNewer: () => undefined,
          autoScrollAllowed: false,
        }}
        loadingBelow={loading}
        hasMoreBelow={loading}
      />
    );
    await act(async () => root.render(renderFeed([1, 2, 3, 4], true)));
    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
      root.render(renderFeed([2, 3, 4, 5], false));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
    expect(container.querySelector('[data-message-id="1"]')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(container.querySelector('[data-message-id="5"]')).not.toBeNull();
  });

  it('does not treat a later unrelated scroll as the same wheel gesture', async () => {
    const renderFeed = (ids: number[]) => (
      <MessageFeed
        items={ids}
        getMessageId={getId}
        renderMessage={renderMessage}
        scrollOptions={{
          policy: historyPolicy,
          hasReachedStart: true,
          onLoadOlder: () => undefined,
          autoScrollAllowed: false,
        }}
      />
    );
    await act(async () => root.render(renderFeed([1, 2, 3, 4])));
    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      root.render(renderFeed([2, 3, 4, 5]));
    });
    expect(container.querySelector('[data-message-id="5"]')).not.toBeNull();
  });

  it('cancels a deferred navigation when the feed is replaced', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const onLanded = vi.fn();
    let current = true;
    await act(async () => {
      scroll.scrollToBottom('smooth', ScrollNavigationIntent.Explicit, {
        feedId: 'one',
        generation: 1,
        targetId: 4,
        isCurrent: () => current,
        onLanded,
        onUnavailable: vi.fn(),
      });
      current = false;
      root.render(<TestFeed ids={[5, 6, 7, 8]} resetKey="two" />);
    });
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 27;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(scroller.scrollTop).toBe(27);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('verifies nonanimated explicit landing only after pending window layout settles', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const onLanded = vi.fn();
    await act(async () => {
      scroll.scrollToBottom('auto', ScrollNavigationIntent.Explicit, {
        feedId: 'one',
        generation: 1,
        targetId: 4,
        isCurrent: () => true,
        onLanded,
        onUnavailable: vi.fn(),
      });
      expect(onLanded).not.toHaveBeenCalled();
      root.render(<TestFeed ids={[2, 3, 4, 5]} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(scroll.scrollerRef.current!.scrollTop).toBe(200);
  });

  it('measures committed message ids while a replacement render is suspended', async () => {
    const onAnchorSnapshotChange = vi.fn();
    const options = { onAnchorSnapshotChange };
    await act(async () =>
      root.render(
        <Suspense fallback={<div>Loading</div>}>
          <TestFeed ids={[1, 2, 3, 4]} options={options} />
        </Suspense>,
      ),
    );
    const committedScroll = scroll;
    await act(async () => {
      startTransition(() =>
        root.render(
          <Suspense fallback={<div>Loading</div>}>
            <TestFeed ids={[2, 3, 4, 5]} options={options} suspend={new Promise(() => {})} />
          </Suspense>,
        ),
      );
    });
    expect(container.querySelector('[data-message-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="5"]')).toBeNull();
    await act(async () => committedScroll.scrollToBottom('auto', ScrollNavigationIntent.Explicit));
    expect(onAnchorSnapshotChange.mock.lastCall?.[0]?.itemIds).toEqual([1, 2, 3, 4]);
  });

  it('starts at the leading edge and does not follow an appended history page', async () => {
    const options = { policy: historyPolicy };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4, 5, 6]} options={options} />));
    expect(scroller.scrollTop).toBe(51);
  });

  it('binds underfilled history input when the first response mounts the viewport', async () => {
    const onLoadOlder = vi.fn();
    const options = {
      policy: { ...historyPolicy, underfilledEdgeLoading: true },
      hasReachedStart: false,
      onLoadOlder,
    };
    await act(async () => root.render(<TestFeed ids={[]} options={options} />));
    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    onLoadOlder.mockClear();
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a page when a hidden tab becomes eligible for prefetch', async () => {
    const onLoadNewer = vi.fn();
    const options = {
      policy: { ...historyPolicy, belowLoadStrategy: 'immediate' as const },
      loadEdgesOnLayout: true,
      onLoadNewer,
      unreadPrefetchNeeded: false,
    };
    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    await act(async () => {
      viewportHeight = 0;
      width = 0;
      root.render(<TestFeed ids={[1]} options={{ ...options, unreadPrefetchNeeded: true }} />);
    });
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('rechecks the opposite edge after one visible-edge load completes', async () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    const options = {
      policy: {
        ...historyPolicy,
        belowLoadStrategy: 'immediate' as const,
        serializeEdgeLoads: true,
      },
      loadEdgesOnLayout: true,
      hasReachedStart: false,
      unreadPrefetchNeeded: true,
      onLoadOlder,
      onLoadNewer,
    };

    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    await act(async () => root.render(<TestFeed ids={ids} options={options} />));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).not.toHaveBeenCalled();

    await act(async () =>
      root.render(<TestFeed ids={ids} options={{ ...options, loadingOlder: true }} />),
    );
    expect(onLoadNewer).not.toHaveBeenCalled();

    await act(async () =>
      root.render(<TestFeed ids={[0, 1]} options={{ ...options, hasReachedStart: true }} />),
    );
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed Analysis edge load without a new boundary', async () => {
    const onLoadOlder = vi.fn();
    const options = {
      policy: { ...historyPolicy, serializeEdgeLoads: true },
      loadEdgesOnLayout: true,
      hasReachedStart: false,
      onLoadOlder,
    };

    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(<TestFeed ids={[1]} options={{ ...options, loadingOlder: true }} />),
    );
    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('retries a latched Analysis edge after an explicit refresh', async () => {
    const onLoadOlder = vi.fn();
    const options = {
      policy: { ...historyPolicy, serializeEdgeLoads: true },
      loadEdgesOnLayout: true,
      hasReachedStart: false,
      onLoadOlder,
    };
    const ids = Array.from({ length: 10 }, (_, index) => index + 1);

    await act(async () => root.render(<TestFeed ids={ids} options={options} />));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(<TestFeed ids={ids} options={{ ...options, edgeLoadRetryKey: 1 }} />),
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it('does not alternate bounded Analysis edges without another reader scroll', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(true);
    const onLoadNewer = vi.fn().mockResolvedValue(true);
    const options = {
      policy: {
        ...historyPolicy,
        belowLoadStrategy: 'immediate' as const,
        serializeEdgeLoads: true,
        underfilledEdgeLoading: true,
      },
      loadEdgesOnLayout: true,
      hasReachedStart: false,
      unreadPrefetchNeeded: true,
      onLoadOlder,
      onLoadNewer,
    };
    viewportHeight = 1000;

    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    await act(async () =>
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 })),
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<TestFeed ids={[0, 1]} options={options} />));
    expect(onLoadNewer).not.toHaveBeenCalled();

    await act(async () =>
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 })),
    );
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<TestFeed ids={[1, 2]} options={options} />));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('loads the requested edge when a short scrollable Analysis feed is at a hard boundary', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(true);
    const onLoadNewer = vi.fn().mockResolvedValue(true);
    const options = {
      policy: {
        ...historyPolicy,
        serializeEdgeLoads: true,
        underfilledEdgeLoading: true,
      },
      loadEdgesOnLayout: true,
      hasReachedStart: false,
      unreadPrefetchNeeded: true,
      onLoadOlder,
      onLoadNewer,
    };
    const ids = Array.from({ length: 10 }, (_, index) => index + 1);

    await act(async () => root.render(<TestFeed ids={ids} options={options} />));
    const scroller = container.querySelector<HTMLElement>('[data-message-feed-scroller]')!;
    expect(onLoadOlder).not.toHaveBeenCalled();
    await act(async () =>
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 })),
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    scroller.scrollTop = 400;
    await act(async () =>
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 })),
    );
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('preserves the leading edge on refresh, but a message anchor while reading history', async () => {
    let capture: (() => void) | null = null;
    const options = {
      policy: historyPolicy,
      onViewportCaptureChange: (callback: (() => void) | null) => {
        capture = callback;
      },
    };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(capture).not.toBeNull();
    capture!();
    await act(async () =>
      root.render(
        <TestFeed ids={[-1, 0, 1, 2, 3, 4]} options={{ ...options, viewportPreservationKey: 1 }} />,
      ),
    );
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 }));
      scroller.scrollTop = 151;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    capture!();
    await act(async () =>
      root.render(
        <TestFeed
          ids={[-3, -2, -1, 0, 1, 2, 3, 4]}
          options={{ ...options, viewportPreservationKey: 2 }}
        />,
      ),
    );
    expect(container.querySelector('[data-message-id="2"]')!.getBoundingClientRect().top).toBe(-1);
  });

  it('centers a boundary target with a spacer and releases retention on wheel input', async () => {
    const release = vi.fn();
    const focus = { messageId: 4, active: true, onRelease: release };
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ policy: historyPolicy, focus }} />),
    );
    const target = container.querySelector('[data-message-id="4"]')!;
    expect(target.getBoundingClientRect().top).toBe(25);
    expect(
      container.querySelector<HTMLElement>('[data-direct-message-anchor-spacer]')?.style.height,
    ).toBe('25px');
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
      scroll.scrollerRef.current!.scrollTop = 25;
      scroll.scrollerRef.current!.dispatchEvent(new Event('scroll', { bubbles: true }));
      resize();
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(scroll.scrollerRef.current!.scrollTop).toBe(25);
    expect(scroll.bottomSpacerPx).toBe(0);
  });

  it.each([349.8, 347.8])(
    'centers an underfilled focused feed without recursive updates at viewport height %s',
    async (height) => {
      viewportHeight = height;
      clampScrollHeightToViewport = true;
      await act(async () =>
        root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ policy: historyPolicy }} />),
      );
      const scroller = scroll.scrollerRef.current!;
      let scrollTop = 0;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight));
        },
      });
      await act(async () =>
        root.render(
          <TestFeed
            ids={[1, 2, 3, 4]}
            options={{ policy: historyPolicy, focus: { messageId: 4, active: true } }}
          />,
        ),
      );
      expect(scroll.bottomSpacerPx).toBe(Math.ceil(175 + height / 2 - 200));
      expect(scroller.scrollTop).toBeCloseTo(175 - height / 2);
    },
  );

  it('aligns a loaded page boundary without fetching or retaining the old focus', async () => {
    const onLoadNewer = vi.fn();
    const onAligned = vi.fn();
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ policy: historyPolicy, onLoadNewer }} />),
    );
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4]}
          options={{
            policy: historyPolicy,
            onLoadNewer,
            navigationTarget: { messageId: 3, alignment: 'start', onAligned },
          }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.querySelector('[data-message-id="3"]')!.getBoundingClientRect().top).toBe(0);
    expect(onAligned).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('removes surplus boundary space after released focus gains real messages below', async () => {
    const options = {
      policy: historyPolicy,
      focus: { messageId: 4, active: true },
    };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(scroll.bottomSpacerPx).toBe(25);
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    });
    const previousTop = scroller.scrollTop;
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4, 5, 6]}
          options={{ ...options, focus: { messageId: 4, active: false } }}
        />,
      ),
    );
    expect(scroll.bottomSpacerPx).toBe(0);
    expect(scroller.scrollTop).toBe(previousTop);
  });

  it('preserves a history reading anchor when a card resizes during a below-page request', async () => {
    const options = { policy: historyPolicy };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ ...options, loadingNewer: true }} />),
    );
    await act(async () => {
      itemHeight = 100;
      resize();
    });
    expect(container.querySelector('[data-message-id="2"]')!.getBoundingClientRect().top).toBe(-1);
  });

  it('waits for usable viewport geometry before recentering a responsive hidden feed', async () => {
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4]}
          options={{ policy: historyPolicy, focus: { messageId: 4, active: true } }}
        />,
      ),
    );
    const previousTop = scroll.scrollerRef.current!.scrollTop;
    await act(async () => {
      width = 0;
      itemHeight = 10000;
      resize();
    });
    expect(scroll.scrollerRef.current!.scrollTop).toBe(previousTop);
    await act(async () => {
      width = 100;
      itemHeight = 100;
      resize();
    });
    expect(container.querySelector('[data-message-id="4"]')!.getBoundingClientRect().top).toBe(0);
  });

  it('releases focus after the first response mounts a previously empty viewport', async () => {
    const release = vi.fn();
    const options = {
      policy: historyPolicy,
      focus: { messageId: 4, active: true, onRelease: release },
    };
    await act(async () => root.render(<TestFeed ids={[]} options={options} />));
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
