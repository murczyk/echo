/** Scroll behavior for following the live tail when new messages arrive. */
export function getDutyFollowScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined') return 'auto';
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
}

/** Duration of the manual follow ease (Chrome does not animate scrollTop via CSS). */
export const DUTY_SMOOTH_FOLLOW_MS = 450;

/** Same scrollHeight for this many frames before we follow-scroll (cards still laying out). */
export const DUTY_FOLLOW_LAYOUT_STABLE_FRAMES = 3;

/** Cap how long we wait for layout to settle before forcing the follow scroll. */
export const DUTY_FOLLOW_LAYOUT_STABLE_MAX_MS = 450;

/** Ease-out cubic for follow-tail animation. */
export function dutyFollowEaseOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/**
 * Next scrollTop for a follow ease frame. Re-reads max each frame so late card
 * growth retargets without a hard snap.
 */
export function dutyFollowScrollFrame(args: {
  startedAtMs: number;
  nowMs: number;
  fromScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  durationMs?: number;
}): { scrollTop: number; done: boolean } {
  const durationMs = args.durationMs ?? DUTY_SMOOTH_FOLLOW_MS;
  const maxScrollTop = Math.max(0, args.scrollHeight - args.clientHeight);
  const elapsed = args.nowMs - args.startedAtMs;
  if (elapsed >= durationMs || Math.abs(maxScrollTop - args.fromScrollTop) < 0.5) {
    return { scrollTop: maxScrollTop, done: true };
  }
  const t = dutyFollowEaseOutCubic(elapsed / durationMs);
  return {
    scrollTop: args.fromScrollTop + (maxScrollTop - args.fromScrollTop) * t,
    done: false,
  };
}
