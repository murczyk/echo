import { describe, expect, it } from 'vitest';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { findUnreadMarks } from '../messenger-unread';

const at = (id: string, sentAt: number) => ({ id, sentAt }) as MessengersMessageItem;
const window = [at('a', 100), at('b', 200), at('c', 300), at('d', 400)];

describe('findUnreadMarks', () => {
  it('has no marks for a chat never read', () => {
    expect(findUnreadMarks(window, null)).toEqual({ afterId: null, beforeId: null, aboveId: null });
  });

  it('marks where the reader stopped: the first message after the span', () => {
    expect(findUnreadMarks(window, { oldest: 100, newest: 200 })).toMatchObject({
      afterId: 'c',
      beforeId: null,
    });
  });

  it('marks unread history before the span and names its newest message', () => {
    expect(findUnreadMarks(window, { oldest: 300, newest: 400 })).toEqual({
      afterId: null,
      beforeId: 'c',
      aboveId: 'b',
    });
  });

  it('marks both sides of a span in the middle', () => {
    expect(findUnreadMarks(window, { oldest: 200, newest: 300 })).toEqual({
      afterId: 'd',
      beforeId: 'b',
      aboveId: 'a',
    });
  });

  it('marks nothing when a boundary is not loaded: the window starts or ends inside unread messages', () => {
    expect(findUnreadMarks([at('c', 300), at('d', 400)], { oldest: 100, newest: 200 })).toEqual({
      afterId: null,
      beforeId: null,
      aboveId: null,
    });
    expect(findUnreadMarks([at('a', 100), at('b', 200)], { oldest: 300, newest: 400 })).toEqual({
      afterId: null,
      beforeId: null,
      aboveId: null,
    });
  });

  it('says "stopped here" when no loaded message lies inside the span', () => {
    expect(findUnreadMarks(window, { oldest: 250, newest: 260 })).toEqual({
      afterId: 'c',
      beforeId: null,
      aboveId: null,
    });
  });
});
