import { useCallback, useEffect, useMemo } from 'react';
import { recordDutyScrollDebugEvent } from './duty-scroll-debug';
import {
  DUTY_FOLLOW_LAYOUT_STABLE_FRAMES,
  DUTY_FOLLOW_LAYOUT_STABLE_MAX_MS,
  DUTY_SMOOTH_FOLLOW_MS,
  dutyFollowScrollFrame,
  getDutyFollowScrollBehavior,
} from './duty-follow-scroll';
import {
  distanceToBottom,
  INITIAL_BOTTOM_SETTLE_FRAMES,
  INITIAL_BOTTOM_SETTLE_TIMEOUT_MS,
  nowMs,
  type ScrollStateOpts,
  type WindowedFeedScrollRefs,
} from './windowed-feed-scroll-shared';

export function useWindowedFeedScrollFollow(args: {
  refs: WindowedFeedScrollRefs;
  debugFeedId?: string;
  captureAnchorSnapshot: () => void;
  updateScrollState: (opts?: ScrollStateOpts) => void;
}) {
  const { refs, debugFeedId, captureAnchorSnapshot, updateScrollState } = args;

  const stopBottomSettle = useCallback(() => {
    const wasActive = refs.bottomSettleActiveRef.current;
    refs.bottomSettleActiveRef.current = false;
    if (refs.bottomSettleRafRef.current !== null) {
      cancelAnimationFrame(refs.bottomSettleRafRef.current);
      refs.bottomSettleRafRef.current = null;
    }
    if (refs.bottomSettleTimeoutRef.current !== null) {
      clearTimeout(refs.bottomSettleTimeoutRef.current);
      refs.bottomSettleTimeoutRef.current = null;
    }
    refs.bottomSettleResizeObserverRef.current?.disconnect();
    refs.bottomSettleResizeObserverRef.current = null;
    if (wasActive) recordDutyScrollDebugEvent(debugFeedId, 'settle:stop');
  }, [debugFeedId, refs]);

  const clearFollowScroll = useCallback(() => {
    refs.smoothFollowUntilMsRef.current = 0;
    refs.followAnimatingRef.current = false;
    if (refs.followScrollRafRef.current !== null) {
      cancelAnimationFrame(refs.followScrollRafRef.current);
      refs.followScrollRafRef.current = null;
    }
    refs.followScrollWaitRef.current = null;
  }, [refs]);

  useEffect(() => stopBottomSettle, [stopBottomSettle]);
  useEffect(() => () => clearFollowScroll(), [clearFollowScroll]);

  const scrollToBottom = useCallback(
    (
      behavior: ScrollBehavior = 'auto',
      debugReason = 'imperative',
      options?: { enableFollow?: boolean; skipLayoutWait?: boolean },
    ) => {
      if (!refs.enabledRef.current) return;
      const scroller = refs.scrollerRef.current;
      if (!scroller) return;
      // Pending poll scrollToEnd('smooth') races layout; wait until height is stable first.
      if (behavior === 'smooth' && options?.skipLayoutWait !== true) {
        refs.scheduleFollowScrollWhenStableRef.current?.(debugReason);
        return;
      }

      const now = nowMs();

      if (behavior === 'smooth') {
        // Chrome does not animate scrollTop / CSS scroll-behavior for this case — lerp on rAF.
        if (refs.followScrollRafRef.current !== null) {
          cancelAnimationFrame(refs.followScrollRafRef.current);
          refs.followScrollRafRef.current = null;
        }
        const fromScrollTop = scroller.scrollTop;
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const enableFollow = options?.enableFollow !== false;

        const finishFollowEaseLanding = (reason: string) => {
          refs.followAnimatingRef.current = false;
          refs.smoothFollowUntilMsRef.current = 0;
          const active = refs.scrollerRef.current;
          if (!active) return;
          const bottomDistance = distanceToBottom(active);
          const atPhysical = bottomDistance <= 1;
          if (atPhysical) {
            const wasPhysical = refs.physicallyAtBottomRef.current;
            refs.physicallyAtBottomRef.current = true;
            // Sticky true mid-ease hides the transition from updateScrollState — always
            // publish so FeedColumn / poll refs learn we landed on the tail.
            refs.callbacksRef.current.onPhysicalBottomChange?.(true);
            if (wasPhysical !== true) {
              recordDutyScrollDebugEvent(
                debugFeedId,
                'state:physical-bottom',
                `${wasPhysical ?? '—'}→true; distance=${bottomDistance.toFixed(1)}; reason=follow-ease-land`,
              );
              if (enableFollow) {
                const shouldFollow =
                  refs.callbacksRef.current.onReachedBottom?.({
                    hasSeenNotAtBottom: refs.hasSeenNotAtBottomRef.current,
                  }) !== false;
                refs.liveBottomFollowRef.current = shouldFollow;
                recordDutyScrollDebugEvent(
                  debugFeedId,
                  shouldFollow ? 'follow:enable' : 'follow:blocked',
                  `follow-ease land; returned=${refs.hasSeenNotAtBottomRef.current}`,
                );
              }
            } else if (enableFollow) {
              refs.liveBottomFollowRef.current = true;
            }
          }
          updateScrollState({
            allowLoadOlder: false,
            allowLoadNewer: false,
            allowTopReached: false,
          });
          captureAnchorSnapshot();
          recordDutyScrollDebugEvent(
            debugFeedId,
            'scroll-to-bottom',
            `${reason}; behavior=raf-ease; top=${active.scrollTop.toFixed(1)}; height=${active.scrollHeight.toFixed(1)}`,
          );
        };

        if (Math.abs(maxScrollTop - fromScrollTop) < 0.5) {
          if (enableFollow) refs.liveBottomFollowRef.current = true;
          finishFollowEaseLanding(debugReason);
          return;
        }

        refs.smoothFollowUntilMsRef.current = now + DUTY_SMOOTH_FOLLOW_MS;
        refs.followAnimatingRef.current = true;
        if (enableFollow) refs.liveBottomFollowRef.current = true;
        // Local sticky only — parent is notified in finishFollowEaseLanding.
        refs.physicallyAtBottomRef.current = true;
        // Wall-clock progress: under CPU throttle a synthetic 60 Hz clock stretched the
        // ease across many real seconds. Tests advance performance.now per rAF.
        let easeFromScrollTop = fromScrollTop;
        let easeStartedAtMs = now;
        let easeDurationMs = DUTY_SMOOTH_FOLLOW_MS;
        let lastMaxScrollTop = maxScrollTop;

        const tick = () => {
          refs.followScrollRafRef.current = null;
          if (!refs.enabledRef.current) {
            refs.followAnimatingRef.current = false;
            refs.smoothFollowUntilMsRef.current = 0;
            return;
          }
          if (enableFollow && refs.liveBottomFollowRef.current !== true) {
            refs.followAnimatingRef.current = false;
            refs.smoothFollowUntilMsRef.current = 0;
            return;
          }
          const active = refs.scrollerRef.current;
          if (!active) {
            refs.followAnimatingRef.current = false;
            refs.smoothFollowUntilMsRef.current = 0;
            return;
          }
          const frameNowMs = nowMs();
          const frame = dutyFollowScrollFrame({
            startedAtMs: easeStartedAtMs,
            nowMs: frameNowMs,
            fromScrollTop: easeFromScrollTop,
            currentScrollTop: active.scrollTop,
            lastMaxScrollTop,
            scrollHeight: active.scrollHeight,
            clientHeight: active.clientHeight,
            durationMs: easeDurationMs,
          });
          easeFromScrollTop = frame.fromScrollTop;
          easeStartedAtMs = frame.startedAtMs;
          easeDurationMs = frame.durationMs;
          lastMaxScrollTop = frame.maxScrollTop;
          refs.followAnimatingRef.current = true;
          active.scrollTop = frame.scrollTop;
          refs.previousScrollTopRef.current = active.scrollTop;
          if (!frame.done) {
            // Same wall clock as ResizeObserver suppression checks.
            refs.smoothFollowUntilMsRef.current = frameNowMs + DUTY_SMOOTH_FOLLOW_MS;
            refs.followScrollRafRef.current = requestAnimationFrame(tick);
            return;
          }
          finishFollowEaseLanding(debugReason);
        };

        recordDutyScrollDebugEvent(
          debugFeedId,
          'scroll-to-bottom',
          `${debugReason}; behavior=raf-ease:start; from=${fromScrollTop.toFixed(1)}; to=${maxScrollTop.toFixed(1)}`,
        );
        refs.followScrollRafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Instant path (initial / settle / catch-up / reduced-motion).
      refs.followAnimatingRef.current = false;
      if (refs.followScrollRafRef.current !== null && refs.followScrollWaitRef.current == null) {
        cancelAnimationFrame(refs.followScrollRafRef.current);
        refs.followScrollRafRef.current = null;
      }
      if (refs.followScrollWaitRef.current == null) {
        refs.smoothFollowUntilMsRef.current = 0;
      }
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      refs.previousScrollTopRef.current = scroller.scrollTop;
      if (options?.enableFollow !== false) {
        refs.liveBottomFollowRef.current = true;
      }
      const canScroll =
        scroller.scrollHeight > scroller.clientHeight || scroller.scrollHeight === 0;
      updateScrollState({
        allowLoadOlder: !canScroll,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      captureAnchorSnapshot();
      if (!debugReason.startsWith('settle:')) {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'scroll-to-bottom',
          `${debugReason}; behavior=instant; top=${scroller.scrollTop.toFixed(1)}; height=${scroller.scrollHeight.toFixed(1)}`,
        );
      }
    },
    [captureAnchorSnapshot, debugFeedId, refs, updateScrollState],
  );

  const startBottomSettle = useCallback(() => {
    if (!refs.enabledRef.current) return;
    stopBottomSettle();
    if (!refs.scrollerRef.current) return;

    refs.bottomSettleActiveRef.current = true;
    refs.bottomSettleFramesRemainingRef.current = INITIAL_BOTTOM_SETTLE_FRAMES;
    recordDutyScrollDebugEvent(
      debugFeedId,
      'settle:start',
      `frames=${INITIAL_BOTTOM_SETTLE_FRAMES}; timeout=${INITIAL_BOTTOM_SETTLE_TIMEOUT_MS}`,
    );

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (refs.bottomSettleActiveRef.current) scrollToBottom('auto', 'settle:resize');
      });
      refs.bottomSettleResizeObserverRef.current = observer;
      if (refs.scrollerRef.current) observer.observe(refs.scrollerRef.current);
      if (refs.listRef.current) observer.observe(refs.listRef.current);
    }

    refs.bottomSettleTimeoutRef.current = setTimeout(
      stopBottomSettle,
      INITIAL_BOTTOM_SETTLE_TIMEOUT_MS,
    );

    const settleFrame = () => {
      if (!refs.bottomSettleActiveRef.current) {
        refs.bottomSettleRafRef.current = null;
        return;
      }
      scrollToBottom('auto', 'settle:frame');
      refs.bottomSettleFramesRemainingRef.current -= 1;
      if (refs.bottomSettleFramesRemainingRef.current > 0) {
        refs.bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
        return;
      }
      refs.bottomSettleRafRef.current = null;
    };
    refs.bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
  }, [debugFeedId, refs, scrollToBottom, stopBottomSettle]);

  const scheduleFollowScrollWhenStable = useCallback(
    (debugReason: string, options?: { enableFollow?: boolean }) => {
      const enableFollow = options?.enableFollow !== false;
      const now = nowMs();
      const scroller = refs.scrollerRef.current;
      const height = scroller?.scrollHeight ?? 0;

      // Arm suppress before paint/resize can instant-pin the new height into view.
      refs.smoothFollowUntilMsRef.current =
        now + DUTY_FOLLOW_LAYOUT_STABLE_MAX_MS + DUTY_SMOOTH_FOLLOW_MS;
      if (enableFollow) {
        refs.liveBottomFollowRef.current = true;
      }
      // Sticky until the deferred scroll lands; measuring the below-fold append would
      // clear physical-bottom and skip the next catch-up load.
      refs.physicallyAtBottomRef.current = true;
      // Drop any in-flight settle snaps — they would pin instantly and defeat below-fold.
      stopBottomSettle();

      refs.followScrollWaitRef.current = {
        debugReason,
        startedAtMs: now,
        lastHeight: height,
        stableFrames: 0,
        enableFollow,
      };

      if (refs.followScrollRafRef.current !== null) {
        cancelAnimationFrame(refs.followScrollRafRef.current);
        refs.followScrollRafRef.current = null;
      }
      refs.followAnimatingRef.current = false;

      const tick = () => {
        refs.followScrollRafRef.current = null;
        const wait = refs.followScrollWaitRef.current;
        if (!wait) return;
        if (!refs.enabledRef.current) {
          refs.followScrollWaitRef.current = null;
          return;
        }
        if (wait.enableFollow && refs.liveBottomFollowRef.current !== true) {
          refs.followScrollWaitRef.current = null;
          return;
        }
        const activeScroller = refs.scrollerRef.current;
        if (!activeScroller) {
          refs.followScrollWaitRef.current = null;
          return;
        }

        const tickNow = nowMs();
        const nextHeight = activeScroller.scrollHeight;
        if (Math.abs(nextHeight - wait.lastHeight) <= 0.5) {
          wait.stableFrames += 1;
        } else {
          wait.lastHeight = nextHeight;
          wait.stableFrames = 0;
          // Layout still growing — keep resize snaps suppressed.
          refs.smoothFollowUntilMsRef.current =
            tickNow + DUTY_FOLLOW_LAYOUT_STABLE_MAX_MS + DUTY_SMOOTH_FOLLOW_MS;
        }

        const timedOut = tickNow - wait.startedAtMs >= DUTY_FOLLOW_LAYOUT_STABLE_MAX_MS;
        if (wait.stableFrames < DUTY_FOLLOW_LAYOUT_STABLE_FRAMES && !timedOut) {
          refs.followScrollRafRef.current = requestAnimationFrame(tick);
          return;
        }

        refs.followScrollWaitRef.current = null;
        const nextBehavior = getDutyFollowScrollBehavior();
        recordDutyScrollDebugEvent(
          debugFeedId,
          'follow:layout-stable',
          `reason=${wait.debugReason}; height=${nextHeight.toFixed(1)}; frames=${wait.stableFrames}; timedOut=${timedOut}; behavior=${nextBehavior}; enableFollow=${wait.enableFollow}`,
        );
        scrollToBottom(nextBehavior, wait.debugReason, {
          skipLayoutWait: true,
          enableFollow: wait.enableFollow,
        });
      };

      refs.followScrollRafRef.current = requestAnimationFrame(tick);
    },
    [debugFeedId, refs, scrollToBottom, stopBottomSettle],
  );
  refs.scheduleFollowScrollWhenStableRef.current = scheduleFollowScrollWhenStable;

  return useMemo(
    () => ({
      stopBottomSettle,
      clearFollowScroll,
      startBottomSettle,
      scrollToBottom,
      scheduleFollowScrollWhenStable,
    }),
    [
      clearFollowScroll,
      scheduleFollowScrollWhenStable,
      scrollToBottom,
      startBottomSettle,
      stopBottomSettle,
    ],
  );
}
