/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ECHO_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { attachInteractionNavigationCollector } from '../interaction-navigation';
import type { DebugEventInput } from '../../types';

const SECRET = 'ECHO_SECRET_SENTINEL';
const tick = () => Promise.resolve();

beforeEach(() => {
  window.history.replaceState({}, '', '/source');
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('interaction and navigation collector', () => {
  it('captures safe interaction structure and excludes recorder-root activity', () => {
    const events: DebugEventInput[] = [];
    const cleanup = attachInteractionNavigationCollector((input) => events.push(input));
    const button = document.createElement('button');
    button.setAttribute('role', 'switch');
    button.dataset.testid = 'safe-toggle';
    button.setAttribute('aria-label', SECRET);
    Object.defineProperty(button, 'textContent', {
      get: () => {
        throw new Error('text read');
      },
    });
    document.body.append(button);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'password';
    input.setAttribute('value', SECRET);
    Object.defineProperty(input, 'value', {
      get: () => {
        throw new Error('value read');
      },
    });
    form.append(input);
    document.body.append(form);
    form.dispatchEvent(new Event('submit', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    const recorderRoot = document.createElement('div');
    recorderRoot.dataset.debugRecorderRoot = '';
    const recorderButton = document.createElement('button');
    recorderRoot.append(recorderButton);
    document.body.append(recorderRoot);
    recorderButton.click();

    expect(events.map((event) => event.kind)).toEqual([
      'interaction.click',
      'interaction.submit',
      'interaction.focus',
    ]);
    expect(events[0]?.target).toEqual({ tag: 'button', role: 'switch', testId: 'safe-toggle' });
    expect(events[1]?.target).toEqual({ tag: 'form' });
    expect(events[2]?.target).toEqual({ tag: 'input', inputType: 'password' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    cleanup();
  });

  it('records only interactions that can actually initiate scrolling', () => {
    const events: DebugEventInput[] = [];
    const cleanup = attachInteractionNavigationCollector((input) => events.push(input));
    window.dispatchEvent(new WheelEvent('wheel'));
    window.dispatchEvent(new TouchEvent('touchmove'));
    window.dispatchEvent(new PointerEvent('pointerdown'));
    const typing = new KeyboardEvent('keydown', { code: 'KeyA' });
    Object.defineProperty(typing, 'key', {
      get: () => {
        throw new Error('key read');
      },
    });
    window.dispatchEvent(typing);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown' }));

    expect(events).toEqual([
      { kind: 'scroll.intent', source: 'collector', details: { kind: 'wheel' } },
      { kind: 'scroll.intent', source: 'collector', details: { kind: 'touch' } },
      { kind: 'scroll.intent', source: 'collector', details: { kind: 'pointer' } },
      { kind: 'scroll.intent', source: 'collector', details: { kind: 'keyboard' } },
    ]);
    cleanup();
  });

  it('ignores navigation timing that predates the recording', () => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type) =>
      type === 'navigation' ? ([{ type: 'reload' }] as PerformanceEntry[]) : [],
    );
    vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(1_000);
    const events: DebugEventInput[] = [];
    const cleanup = attachInteractionNavigationCollector((input) => events.push(input), {
      recordingStartedAt: 2_000,
    });

    expect(events.some((event) => event.kind === 'navigation.reload')).toBe(false);
    cleanup();
  });

  it('maps history, guard, traversal, hash, lifecycle and document state without URLs', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type) =>
      type === 'navigation' ? ([{ type: 'reload' }] as PerformanceEntry[]) : [],
    );
    const events: DebugEventInput[] = [];
    vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(1_000);
    const cleanup = attachInteractionNavigationCollector((input) => events.push(input), {
      recordingStartedAt: 500,
    });

    window.history.pushState({}, '', `/next?token=${SECRET}#private`);
    await tick();
    window.history.replaceState({}, '', `/replaced?token=${SECRET}`);
    window.dispatchEvent(
      new CustomEvent(ECHO_NAVIGATION_EVENT, {
        detail: { kind: 'replace', forced: true, destination: SECRET },
      }),
    );
    await tick();
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    const pageshow = new Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(events.map((event) => event.kind)).toEqual([
      'navigation.reload',
      'navigation.push',
      'navigation.replace',
      'navigation.traverse',
      'navigation.hashchange',
      'document.pagehide',
      'navigation.bfcache-restored',
      'network.offline',
      'network.online',
      'document.visibility',
    ]);
    expect(events[1]).toMatchObject({ route: '/next' });
    expect(events[2]).toMatchObject({ route: '/replaced', details: { forced: true } });
    expect(events[9]).toMatchObject({ details: { visible: false } });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    cleanup();
  });

  it('restores exact history functions and does not stack across attach cycles', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const nativePush = window.history.pushState;
    const nativeReplace = window.history.replaceState;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const events: DebugEventInput[] = [];
      const cleanup = attachInteractionNavigationCollector((input) => events.push(input));
      window.history.pushState({}, '', `/cycle-${cycle}`);
      await tick();
      expect(events.filter((event) => event.kind === 'navigation.push')).toHaveLength(1);
      cleanup();
      cleanup();
      expect(window.history.pushState).toBe(nativePush);
      expect(window.history.replaceState).toBe(nativeReplace);
    }
  });
});
