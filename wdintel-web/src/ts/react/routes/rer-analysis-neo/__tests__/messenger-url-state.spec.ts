/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import { parseMessengerQueryStateFromWindow, replaceMessengerQueryStateInUrl } from '../helpers';
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
