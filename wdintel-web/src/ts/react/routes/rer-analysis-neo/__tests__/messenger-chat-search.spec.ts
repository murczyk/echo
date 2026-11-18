import { describe, expect, it } from 'vitest';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { isInRange, pickJumpTarget, splitHeadline } from '../messenger-chat-search';

const message = (id: string, sentAt: number) => ({ id, sentAt }) as MessengersMessageItem;

describe('splitHeadline', () => {
  it('marks the text between the start and stop characters', () => {
    expect(splitHeadline('вогонь по танках з півночі')).toEqual([
      { text: 'вогонь по ', match: false },
      { text: 'танках', match: true },
      { text: ' з півночі', match: false },
    ]);
  });

  it('keeps markup in the text as text', () => {
    expect(splitHeadline('<b>x</b>')).toEqual([
      { text: '<b>', match: false },
      { text: 'x', match: true },
      { text: '</b>', match: false },
    ]);
  });

  it('returns no parts for an empty headline', () => {
    expect(splitHeadline('')).toEqual([]);
  });
});

describe('pickJumpTarget', () => {
  const items = [message('a', 10), message('b', 20), message('c', 30)];

  it('takes the first message sent in or after the range', () => {
    expect(pickJumpTarget(items, 20)?.id).toBe('b');
    expect(pickJumpTarget(items, 11)?.id).toBe('b');
  });

  it('falls back to the newest message before the range when nothing is later', () => {
    expect(pickJumpTarget(items, 100)?.id).toBe('c');
  });

  it('lands on the first message when the range is before the chat', () => {
    expect(pickJumpTarget(items, 1)?.id).toBe('a');
  });

  it('has no target for an empty chat', () => {
    expect(pickJumpTarget([], 5)).toBeNull();
  });
});

describe('isInRange', () => {
  it('includes both ends', () => {
    expect(isInRange(message('a', 10), 10, 20)).toBe(true);
    expect(isInRange(message('a', 20), 10, 20)).toBe(true);
    expect(isInRange(message('a', 21), 10, 20)).toBe(false);
    expect(isInRange(message('a', 9), 10, 20)).toBe(false);
  });
});
