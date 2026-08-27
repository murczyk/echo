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

export type DutyFollowScrollFrameArgs = {
  startedAtMs: number;
  nowMs: number;
  fromScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  durationMs?: number;
  /** Current scroller position; required with lastMaxScrollTop to rebase on growth. */
  currentScrollTop?: number;
  /** Previous frame's maxScrollTop; when max grows, rebase from current over remaining time. */
  lastMaxScrollTop?: number;
};

export type DutyFollowScrollFrameResult = {
  scrollTop: number;
  done: boolean;
  fromScrollTop: number;
  startedAtMs: number;
  durationMs: number;
  maxScrollTop: number;
};

/**
 * Next scrollTop for a follow ease frame. When maxScrollTop grows mid-ease, rebases
 * from the current scroll position over the remaining duration so new distance is not
 * applied retroactively via the original from×absolute-t lerp.
 */
export function dutyFollowScrollFrame(
  args: DutyFollowScrollFrameArgs,
): DutyFollowScrollFrameResult {
  const maxScrollTop = Math.max(0, args.scrollHeight - args.clientHeight);
  let fromScrollTop = args.fromScrollTop;
  let startedAtMs = args.startedAtMs;
  let durationMs = args.durationMs ?? DUTY_SMOOTH_FOLLOW_MS;

  if (
    args.currentScrollTop != null &&
    args.lastMaxScrollTop != null &&
    maxScrollTop > args.lastMaxScrollTop + 0.5
  ) {
    const endAtMs = startedAtMs + durationMs;
    const remainingMs = Math.max(0, endAtMs - args.nowMs);
    fromScrollTop = args.currentScrollTop;
    startedAtMs = args.nowMs;
    durationMs = remainingMs;
  }

  const elapsed = args.nowMs - startedAtMs;
  if (durationMs < 0.5 || elapsed >= durationMs || Math.abs(maxScrollTop - fromScrollTop) < 0.5) {
    return {
      scrollTop: maxScrollTop,
      done: true,
      fromScrollTop,
      startedAtMs,
      durationMs,
      maxScrollTop,
    };
  }
  const t = dutyFollowEaseOutCubic(elapsed / durationMs);
  return {
    scrollTop: fromScrollTop + (maxScrollTop - fromScrollTop) * t,
    done: false,
    fromScrollTop,
    startedAtMs,
    durationMs,
    maxScrollTop,
  };
}
