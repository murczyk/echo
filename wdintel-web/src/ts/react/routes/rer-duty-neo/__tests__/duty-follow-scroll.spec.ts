/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  feedFollowEaseOutCubic,
  feedFollowScrollFrame,
  getFeedFollowScrollBehavior,
} from '../../shared/message-feed/feed-follow-scroll';
describe('getFeedFollowScrollBehavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns smooth when reduced motion is not preferred', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as MediaQueryList);
    expect(getFeedFollowScrollBehavior()).toBe('smooth');
  });

  it('returns auto when reduced motion is preferred', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: true }) as MediaQueryList);
    expect(getFeedFollowScrollBehavior()).toBe('auto');
  });
});
describe('feedFollowScrollFrame', () => {
  it('eases from start toward the live edge over the duration', () => {
    const mid = feedFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 225,
      fromScrollTop: 100,
      scrollHeight: 400,
      clientHeight: 100,
      durationMs: 450,
    });
    expect(mid.done).toBe(false);
    expect(mid.scrollTop).toBeGreaterThan(100);
    expect(mid.scrollTop).toBeLessThan(300);
  });

  it('rebases from the current position over remaining time when max grows', () => {
    const before = feedFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 400,
      fromScrollTop: 100,
      scrollHeight: 400,
      clientHeight: 100,
      durationMs: 450,
    });
    const after = feedFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 400,
      fromScrollTop: 100,
      currentScrollTop: before.scrollTop,
      lastMaxScrollTop: 300,
      scrollHeight: 700,
      clientHeight: 100,
      durationMs: 450,
    });

    expect(after.done).toBe(false);
    expect(after.fromScrollTop).toBe(before.scrollTop);
    expect(after.startedAtMs).toBe(400);
    expect(after.durationMs).toBe(50);
    // Local t=0 after rebase — must not apply ~t_abs * 300 of growth in this frame.
    expect(after.scrollTop).toBeCloseTo(before.scrollTop, 5);
    expect(after.scrollTop - before.scrollTop).toBeLessThan(1);

    const later = feedFollowScrollFrame({
      startedAtMs: after.startedAtMs,
      nowMs: 425,
      fromScrollTop: after.fromScrollTop,
      currentScrollTop: after.scrollTop,
      lastMaxScrollTop: after.maxScrollTop,
      scrollHeight: 700,
      clientHeight: 100,
      durationMs: after.durationMs,
    });
    expect(later.scrollTop).toBeGreaterThan(after.scrollTop);
    expect(later.scrollTop).toBeLessThan(600);
  });

  it('finishes at max scrollTop', () => {
    const end = feedFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 450,
      fromScrollTop: 100,
      scrollHeight: 400,
      clientHeight: 100,
      durationMs: 450,
    });
    expect(end).toMatchObject({ scrollTop: 300, done: true, maxScrollTop: 300 });
  });

  it('ease-out cubic is 0 at start and 1 at end', () => {
    expect(feedFollowEaseOutCubic(0)).toBe(0);
    expect(feedFollowEaseOutCubic(1)).toBe(1);
    expect(feedFollowEaseOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
