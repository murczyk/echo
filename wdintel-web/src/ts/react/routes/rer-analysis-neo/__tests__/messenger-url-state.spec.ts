/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMessengerChatLink,
  clearTableQueryInUrl,
  parseMessengerChatQueryFromWindow,
  parseMessengerPanelTabFromWindow,
  parseMessengerViewFromWindow,
  parseMessengerQueryStateFromWindow,
  replaceMessengerChatQueryInUrl,
  replaceMessengerPanelTabInUrl,
  replaceMessengerQueryStateInUrl,
  replaceMessengerViewInUrl,
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

describe('messenger view URL state', () => {
  const url = (search: string) =>
    window.history.replaceState({}, '', `/rer-analysis-neo?${search}`);

  it('reads a known view only for the account in the URL', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts');
    expect(parseMessengerViewFromWindow('a1')).toBe('contacts');
    expect(parseMessengerViewFromWindow('a2')).toBeNull();
  });

  it('knows the gallery view', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=gallery');
    expect(parseMessengerViewFromWindow('a1')).toBe('gallery');
  });

  it('ignores an unknown view and lets a chat win over the view', () => {
    url('messengerAccount=a1&messengerView=nope');
    expect(parseMessengerViewFromWindow('a1')).toBeNull();
    url('messengerAccount=a1&messengerView=contacts&messengerChat=c1');
    expect(parseMessengerViewFromWindow('a1')).toBeNull();
  });

  it('opening a view leaves the chat, closing it keeps the rest of the URL', () => {
    const state = { __echoBrowserBackOverlayIds: ['layer-1'] };
    window.history.replaceState(
      state,
      '',
      '/rer-analysis-neo?group=g1&messengerAccount=a1&messengerChat=c1&messengerAnchor=m1#top',
    );
    replaceMessengerViewInUrl('contacts');
    let written = new URL(window.location.href);
    expect(written.searchParams.get('messengerView')).toBe('contacts');
    expect(written.searchParams.has('messengerChat')).toBe(false);
    expect(written.searchParams.has('messengerAnchor')).toBe(false);
    expect(written.searchParams.get('group')).toBe('g1');
    expect(written.hash).toBe('#top');
    expect(window.history.state).toEqual(state);

    replaceMessengerViewInUrl(null);
    written = new URL(window.location.href);
    expect(written.searchParams.has('messengerView')).toBe(false);
    expect(written.searchParams.get('messengerAccount')).toBe('a1');
  });

  it('does not write without an account in the URL or outside the analysis route', () => {
    url('group=g1');
    replaceMessengerViewInUrl('contacts');
    expect(window.location.search).toBe('?group=g1');

    window.history.replaceState({}, '', '/rer-duty-neo?messengerAccount=a1');
    replaceMessengerViewInUrl('contacts');
    expect(window.location.search).toBe('?messengerAccount=a1');
  });

  it('is dropped by opening a chat, selecting another account and leaving the tab', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts');
    replaceMessengerChatQueryInUrl({ chatId: 'c1', anchorMessageId: null });
    expect(window.location.search).not.toContain('messengerView');
    expect(window.location.search).toContain('messengerChat=c1');

    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts');
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: 'a2',
    });
    expect(window.location.search).not.toContain('messengerView');

    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts');
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.EchoGroups,
      messengerAccountId: null,
    });
    expect(window.location.search).not.toContain('messengerView');
  });

  it('survives selecting the same account again', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts');
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.Messenger,
      messengerAccountId: 'a1',
    });
    expect(window.location.search).toContain('messengerView=contacts');
  });
});

describe('table state in the URL', () => {
  it('clears the sorting, filters and search of a table, keeping everything else', () => {
    const state = { __echoBrowserBackOverlayIds: ['layer-1'] };
    window.history.replaceState(
      state,
      '',
      '/rer-analysis-neo?group=g1&messengerAccount=a1&sorting=%5B%5D&columnFilters=%5B%5D&globalFilter=x#top',
    );
    clearTableQueryInUrl();
    expect(window.location.search).toBe('?group=g1&messengerAccount=a1');
    expect(window.location.hash).toBe('#top');
    expect(window.history.state).toEqual(state);
  });

  it('writes only on the analysis route', () => {
    window.history.replaceState({}, '', '/rer-duty-neo?globalFilter=x');
    clearTableQueryInUrl();
    expect(window.location.search).toBe('?globalFilter=x');
  });
});

describe('messenger right panel tab URL state', () => {
  const url = (search: string) =>
    window.history.replaceState({}, '', `/rer-analysis-neo?${search}`);

  it('reads a known tab only', () => {
    url('messengerAccount=a1&messengerPanel=members');
    expect(parseMessengerPanelTabFromWindow()).toBe('members');
    url('messengerAccount=a1&messengerPanel=nope');
    expect(parseMessengerPanelTabFromWindow()).toBeNull();
    url('messengerAccount=a1');
    expect(parseMessengerPanelTabFromWindow()).toBeNull();
  });

  it('writes and removes the tab, keeping the rest of the URL', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&rightPanelOpen=true');
    replaceMessengerPanelTabInUrl('media');
    expect(window.location.search).toBe(
      '?leftPanelTab=messenger&messengerAccount=a1&rightPanelOpen=true&messengerPanel=media',
    );
    replaceMessengerPanelTabInUrl(null);
    expect(window.location.search).toBe(
      '?leftPanelTab=messenger&messengerAccount=a1&rightPanelOpen=true',
    );
  });

  it('writes nothing outside the messenger account or the analysis route', () => {
    url('rightPanelOpen=true');
    replaceMessengerPanelTabInUrl('media');
    expect(window.location.search).toBe('?rightPanelOpen=true');
    window.history.replaceState({}, '', '/other?messengerAccount=a1');
    replaceMessengerPanelTabInUrl('media');
    expect(window.location.search).toBe('?messengerAccount=a1');
  });

  it('is dropped when the messenger tab is left', () => {
    url('leftPanelTab=messenger&messengerAccount=a1&messengerPanel=media');
    replaceMessengerQueryStateInUrl({
      leftPanelTab: LeftPanelTab.EchoGroups,
      messengerAccountId: null,
    });
    expect(window.location.search).toBe('');
  });
});
