/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersMessageItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({ listMessengersMessages: vi.fn() }));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

import { MessengerChatSearchBar } from '../MessengerChatSearchBar';

const hit = (id: string, headline: string): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt: Date.UTC(2026, 8, 12, 12),
  text: 'plain',
  isOutgoing: false,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
  headline,
});

describe('MessengerChatSearchBar', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpenHit = vi.fn();
  const onJumpToDate = vi.fn();

  const type = (label: string, value: string) =>
    act(() => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(350)));
  const click = (element: Element | null | undefined) =>
    act(async () => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === text);

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.listMessengersMessages.mockReset();
    onOpenHit.mockReset();
    onJumpToDate.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <MessengerChatSearchBar
          accountId="a1"
          chatId="c1"
          senderLabel={() => 'Ivan'}
          onOpenHit={onOpenHit}
          onJumpToDate={onJumpToDate}
          jumping={false}
        />,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('asks for nothing until two letters are typed, then once after the typing pauses', async () => {
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [hit('m1', 'вогонь по танках')],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'т');
    await settle();
    expect(apiMock.listMessengersMessages).not.toHaveBeenCalled();

    type('Пошук у чаті', 'та');
    type('Пошук у чаті', ' танк ');
    await settle();
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'c1',
        query: 'танк',
        searchMode: 'Fuzzy',
        cursor: null,
        aroundMessageId: null,
      }),
      expect.anything(),
    );
    expect(container.querySelector('mark')?.textContent).toBe('танках');
    expect(container.textContent).toContain('Ivan · ');
  });

  const input = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Пошук у чаті"]')!;
  const hits = () => container.querySelectorAll('[data-messenger-search-hit]');
  const key = (name: string) =>
    act(
      async () =>
        void input().dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
        ),
    );
  const searchTwoHits = async () => {
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [hit('m2', 'second'), hit('m1', 'first')],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'bb');
    await settle();
  };

  it('opens the hit that was clicked, closes the list and keeps the text', async () => {
    await searchTwoHits();
    await click(hits()[0]);

    expect(onOpenHit).toHaveBeenCalledWith('m2');
    expect(hits()).toHaveLength(0);
    expect(input().value).toBe('bb');
  });

  it('closes on a click outside and shows the same hits again on a click or focus, without asking again', async () => {
    await searchTwoHits();
    await click(document.body);
    expect(hits()).toHaveLength(0);
    expect(input().value).toBe('bb');

    await click(input());
    expect(hits()).toHaveLength(2);
    await click(document.body);
    await act(async () => void input().dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(hits()).toHaveLength(2);
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
  });

  it('stays open when the input loses focus, as when the phone keyboard is dismissed', async () => {
    await searchTwoHits();
    await act(
      async () => void input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
    );
    await act(async () => void input().dispatchEvent(new FocusEvent('blur')));
    expect(hits()).toHaveLength(2);
  });

  it('shows the list again when typing after it was closed', async () => {
    await searchTwoHits();
    await click(document.body);
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [hit('m3', 'third')],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'bbb');
    await settle();
    expect(hits()).toHaveLength(1);
  });

  it('closes with Escape, keeping the text, and lets an Escape with nothing to close through', async () => {
    await searchTwoHits();
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    await key('Escape');
    expect(hits()).toHaveLength(0);
    expect(input().value).toBe('bb');
    expect(reached).not.toHaveBeenCalled();

    await key('Escape');
    expect(reached).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', reached);
  });

  it('moves over the hits with the arrow keys and opens the one it is on with Enter', async () => {
    await searchTwoHits();
    await key('Enter');
    expect(onOpenHit).not.toHaveBeenCalled();

    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(hits()[1].id);
    expect(hits()[1].getAttribute('aria-selected')).toBe('true');
    await key('ArrowUp');
    expect(hits()[0].getAttribute('aria-selected')).toBe('true');

    await key('Enter');
    expect(onOpenHit).toHaveBeenCalledWith('m2');
    expect(hits()).toHaveLength(0);
  });

  it('opens a closed list with an arrow key', async () => {
    await searchTwoHits();
    await click(document.body);
    await key('ArrowDown');
    expect(hits()).toHaveLength(2);
  });

  it('marks the hit that was opened last when the list is shown again, and forgets it for a new search', async () => {
    await searchTwoHits();
    await click(hits()[1]);
    await click(input());
    expect(hits()[1].getAttribute('aria-current')).toBe('true');
    expect(hits()[0].getAttribute('aria-current')).toBeNull();

    type('Пошук у чаті', 'bbb');
    await settle();
    expect([...hits()].some((item) => item.getAttribute('aria-current') === 'true')).toBe(false);
  });

  it('leaves the list open, and marks nothing opened, when a hit is tapped while a jump is loading', async () => {
    await searchTwoHits();
    act(() =>
      root.render(
        <MessengerChatSearchBar
          accountId="a1"
          chatId="c1"
          senderLabel={() => 'Ivan'}
          onOpenHit={onOpenHit}
          onJumpToDate={onJumpToDate}
          jumping
        />,
      ),
    );
    await click(hits()[0]);

    expect(onOpenHit).not.toHaveBeenCalled();
    expect(hits()).toHaveLength(2);
    expect(hits()[0].getAttribute('aria-current')).toBeNull();
  });

  it('shows the text of a hit whose headline is empty', async () => {
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [hit('m1', '')],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'bb');
    await settle();
    expect(hits()[0].textContent).toContain('plain');
  });

  it('keeps no active hit for the arrow keys while there is nothing to move over', async () => {
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'bb');
    await settle();
    await key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBeNull();

    // The hit that arrives later is not highlighted behind the reader's back.
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [hit('m1', 'x')],
      olderCursor: null,
      newerCursor: null,
    });
    type('Пошук у чаті', 'bbb');
    await settle();
    expect(hits()[0].getAttribute('aria-selected')).toBe('false');
  });

  it('drops the error of a failed page when the next page loads', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce({ items: [hit('m3', 'x')], olderCursor: 'o1', newerCursor: null })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [hit('m2', 'x')], olderCursor: null, newerCursor: null });
    type('Пошук у чаті', 'xx');
    await settle();
    await click(button('Показати ще'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');

    await click(button('Показати ще'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(hits()).toHaveLength(2);
  });

  it('clears the text and the list with the cross', async () => {
    await searchTwoHits();
    await click(container.querySelector('[aria-label="Очистити пошук"]'));
    expect(input().value).toBe('');
    expect(hits()).toHaveLength(0);
  });

  it('says so when nothing matches and when the search fails', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce({ items: [], olderCursor: null, newerCursor: null })
      .mockRejectedValueOnce(new Error('offline'));
    type('Пошук у чаті', 'xx');
    await settle();
    expect(container.textContent).toContain('Нічого не знайдено.');

    type('Пошук у чаті', 'yy');
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  });

  it('loads older hits with the cursor', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce({ items: [hit('m2', 'x')], olderCursor: 'o1', newerCursor: null })
      .mockResolvedValueOnce({ items: [hit('m1', 'x')], olderCursor: null, newerCursor: null });
    type('Пошук у чаті', 'xx');
    await settle();
    await click(button('Показати ще'));

    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'o1', query: 'xx' }),
      expect.anything(),
    );
    expect(container.querySelectorAll('[data-messenger-search-hit]')).toHaveLength(2);
    expect(button('Показати ще')).toBeUndefined();
  });
});
