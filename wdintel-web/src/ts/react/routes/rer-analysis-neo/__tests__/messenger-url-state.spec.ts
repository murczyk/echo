/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMessengerChatLink,
  parseMessengerChatQueryFromWindow,
  parseMessengerQueryStateFromWindow,
  replaceMessengerChatQueryInUrl,
  replaceMessengerQueryStateInUrl,
} from '../helpers';
import { LeftPanelTab } from '../types';

afterEach(() => window.history.replaceState({}, '', '/'));

describe('messenger URL state', () => {
  it('reads the account only together with the messenger tab', () => {
    window.history.replaceState({}, '', '/rer-analysis-neo?messengerAccount=7');
    expect(parseMessengerQueryStateFromWindow()).toEqual({
      leftPanelTab: LeftPanelTab.EchoGroups,
      messengerAccountId: null,
    });

    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=7',
    );
    expect(parseMessengerQueryStateFromWindow()).toEqual({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: '7',
    });
  });

  it('falls back to echo groups for an unknown tab or a blank account', () => {
    window.history.replaceState({}, '', '/rer-analysis-neo?leftPanelTab=nope&messengerAccount=7');
    expect(parseMessengerQueryStateFromWindow().leftPanelTab).toBe(LeftPanelTab.EchoGroups);

    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=%20',
    );
    expect(parseMessengerQueryStateFromWindow().messengerAccountId).toBeNull();
  });

  it('writes both params, drops them for echo groups, and keeps unrelated params and history state', () => {
    const state = { __echoBrowserBackOverlayIds: ['layer-1'] };
    window.history.replaceState(state, '', '/rer-analysis-neo?group=g1&freqs=111.1#top');

    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: '7',
    });
    const written = new URL(window.location.href);
    expect(written.searchParams.get('leftPanelTab')).toBe('messenger');
    expect(written.searchParams.get('messengerAccount')).toBe('7');
    expect(written.searchParams.get('group')).toBe('g1');
    expect(written.hash).toBe('#top');
    expect(window.history.state).toEqual(state);

    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.EchoGroups,
      messengerAccountId: '7',
    });
    expect(window.location.search).toBe('?group=g1&freqs=111.1');
  });
});

describe('messenger chat URL state', () => {
  const base = '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=7';

  it('reads the chat and anchor only for the account in the URL', () => {
    window.history.replaceState({}, '', `${base}&messengerChat=c1&messengerAnchor=m9`);
    expect(parseMessengerChatQueryFromWindow('7')).toEqual({ chatId: 'c1', anchorMessageId: 'm9' });
    expect(parseMessengerChatQueryFromWindow('8')).toEqual({ chatId: null, anchorMessageId: null });
  });

  it('ignores an anchor without a chat and blank values', () => {
    window.history.replaceState({}, '', `${base}&messengerAnchor=m9`);
    expect(parseMessengerChatQueryFromWindow('7')).toEqual({ chatId: null, anchorMessageId: null });

    window.history.replaceState({}, '', `${base}&messengerChat=c1&messengerAnchor=%20`);
    expect(parseMessengerChatQueryFromWindow('7')).toEqual({ chatId: 'c1', anchorMessageId: null });
  });

  it('writes and clears the chat params, keeping history state and unrelated params', () => {
    const state = { __echoBrowserBackOverlayIds: ['layer-1'] };
    window.history.replaceState(state, '', `${base}&group=g1#top`);

    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: 'm9' });
    const written = new URL(window.location.href);
    expect(written.searchParams.get('messengerChat')).toBe('c1');
    expect(written.searchParams.get('messengerAnchor')).toBe('m9');
    expect(written.searchParams.get('group')).toBe('g1');
    expect(written.hash).toBe('#top');
    expect(window.history.state).toEqual(state);

    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: null });
    expect(window.location.search).not.toContain('messengerAnchor');

    replaceMessengerChatQueryInUrl({ chatId: null, anchorMessageId: 'm9' });
    expect(window.location.search).not.toContain('messengerChat');
    expect(window.location.search).not.toContain('messengerAnchor');
  });

  it('does not write anything without an account in the URL', () => {
    window.history.replaceState({}, '', '/rer-analysis-neo?group=g1');
    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: 'm9' });
    expect(window.location.search).toBe('?group=g1');
  });

  it('writes only on the analysis route, with or without a trailing slash', () => {
    window.history.replaceState({}, '', '/rer-duty-neo?messengerAccount=7');
    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: 'm9' });
    expect(window.location.search).toBe('?messengerAccount=7');

    window.history.replaceState({}, '', '/rer-analysis-neo/?messengerAccount=7');
    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: 'm9' });
    expect(window.location.search).toContain('messengerChat=c1');
  });

  it('drops the chat when another account is selected or the tab is left', () => {
    window.history.replaceState({}, '', `${base}&messengerChat=c1&messengerAnchor=m9`);
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: '7',
    });
    expect(window.location.search).toContain('messengerChat=c1');

    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: '8',
    });
    expect(window.location.search).not.toContain('messengerChat');
    expect(window.location.search).not.toContain('messengerAnchor');

    window.history.replaceState({}, '', `${base}&messengerChat=c1&messengerAnchor=m9`);
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.EchoGroups,
      messengerAccountId: null,
    });
    expect(window.location.search).toBe('');
  });

  it('builds a link that opens the chat at a message and keeps the rest of the URL', () => {
    window.history.replaceState({}, '', `${base}&messengerChat=old&messengerAnchor=oldm&group=g1`);
    const link = new URL(buildMessengerChatLink('c2', 'm5'));
    expect(link.searchParams.get('messengerChat')).toBe('c2');
    expect(link.searchParams.get('messengerAnchor')).toBe('m5');
    expect(link.searchParams.get('messengerAccount')).toBe('7');
    expect(link.searchParams.get('group')).toBe('g1');
  });
});
