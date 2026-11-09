/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  readLinkedMessageReference,
  readLinkedMessageReferenceFromWindow,
  removeLinkedMessageReferenceFromWindowUrl,
} from '../message-navigation-url';

describe('linked-message URL handling', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it.each([
    ['m=primary', 'primary'],
    ['mid=legacy', 'legacy'],
    ['messageUid=older', 'older'],
    ['m=%20%20&mid=legacy', 'legacy'],
    ['m=%20%20&mid=%20%20&messageUid=older', 'older'],
    ['m=%20%20&mid=%20%20', null],
    ['m=%D1%96%D0%B4-%D1%81%D0%B8%D0%B3%D0%BD%D0%B0%D0%BB%D1%83', 'ід-сигналу'],
  ])('reads %s as %s', (query, expected) => {
    expect(readLinkedMessageReference(new URLSearchParams(query))).toBe(expected);
  });

  it('reads a copied link from the current window', () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=%20&mid=target-41');
    expect(readLinkedMessageReferenceFromWindow()).toBe('target-41');
  });

  it('removes all link aliases without disturbing page state or the hash', () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?state=feed-1&m=target&mid=old&messageUid=older&messagesPage=3#fragment',
    );

    removeLinkedMessageReferenceFromWindowUrl();

    expect(window.location.pathname).toBe('/rer-analysis-neo');
    expect(window.location.search).toBe('?state=feed-1&messagesPage=3');
    expect(window.location.hash).toBe('#fragment');
  });

  it('keeps the linked URL in history when leaving it for browsing', () => {
    window.history.replaceState({}, '', '/rer-analysis-neo?m=target&messagesPage=3');
    const historyLength = window.history.length;

    removeLinkedMessageReferenceFromWindowUrl({ keepInHistory: true });

    expect(window.history.length).toBe(historyLength + 1);
    expect(window.location.search).toBe('?messagesPage=3');
  });

  it('leaves history untouched when the URL has no linked message', () => {
    window.history.replaceState({ layer: 'overlay' }, '', '/rer-analysis-neo?messagesPage=3');
    const historyLength = window.history.length;

    removeLinkedMessageReferenceFromWindowUrl({ keepInHistory: true });

    expect(window.history.length).toBe(historyLength);
    expect(window.history.state).toEqual({ layer: 'overlay' });
  });
});
