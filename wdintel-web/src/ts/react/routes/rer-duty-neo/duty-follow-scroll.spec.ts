/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dutyFollowEaseOutCubic,
  dutyFollowScrollFrame,
  getDutyFollowScrollBehavior,
} from './duty-follow-scroll';

describe('getDutyFollowScrollBehavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns smooth when reduced motion is not preferred', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as MediaQueryList);
    expect(getDutyFollowScrollBehavior()).toBe('smooth');
  });

  it('returns auto when reduced motion is preferred', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: true }) as MediaQueryList);
    expect(getDutyFollowScrollBehavior()).toBe('auto');
  });
});

describe('dutyFollowScrollFrame', () => {
  it('eases from start toward the live edge over the duration', () => {
    const mid = dutyFollowScrollFrame({
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

  it('retargets when scrollHeight grows mid-ease', () => {
    const before = dutyFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 225,
      fromScrollTop: 100,
      scrollHeight: 400,
      clientHeight: 100,
      durationMs: 450,
    });
    const after = dutyFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 225,
      fromScrollTop: 100,
      scrollHeight: 500,
      clientHeight: 100,
      durationMs: 450,
    });
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  });

  it('finishes at max scrollTop', () => {
    const end = dutyFollowScrollFrame({
      startedAtMs: 0,
      nowMs: 450,
      fromScrollTop: 100,
      scrollHeight: 400,
      clientHeight: 100,
      durationMs: 450,
    });
    expect(end).toEqual({ scrollTop: 300, done: true });
  });

  it('ease-out cubic is 0 at start and 1 at end', () => {
    expect(dutyFollowEaseOutCubic(0)).toBe(0);
    expect(dutyFollowEaseOutCubic(1)).toBe(1);
    expect(dutyFollowEaseOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
