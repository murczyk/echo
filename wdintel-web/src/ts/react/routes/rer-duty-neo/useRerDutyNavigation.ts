import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { getDutyFollowScrollBehavior } from './duty-follow-scroll';
import { ScrollNavigationIntent } from './windowed-feed-scroll-shared';
import type { ExplicitScrollNavigation } from './windowed-feed-scroll-shared';

export type PendingFeedLanding = {
  generation: number;
};

export type ExplicitFeedNavigation = {
  feedId: string;
  generation: number;
};

type NavigationTarget = { id: number; timestamp: number | null };
type NavigationState = {
  generation: number;
  state: 'ready' | 'navigating';
  target: NavigationTarget | null;
  complete: (() => void) | null;
  releaseLoading: (() => void) | null;
  cancelScheduledWork: (() => void) | null;
};

type DeferredLandingParams = {
  changeKey: unknown;
  disableAutoScroll: boolean;
  columnRefsRef: MutableRefObject<
    Record<
      string,
      {
        scrollToEnd: (
          behavior?: ScrollBehavior,
          options?: { intent?: ScrollNavigationIntent; navigation?: ExplicitScrollNavigation },
        ) => void;
      } | null
    >
  >;
  pendingScrollToEndRef: MutableRefObject<Record<string, PendingFeedLanding>>;
  scheduledScrollToEndRef: MutableRefObject<Record<string, number>>;
  isFollowTailValid: (feedId: string, generation: number) => boolean;
};

/** Performs deferred scroll landing only while the owning navigation remains current. */
export function useRerDutyDeferredLanding(params: DeferredLandingParams) {
  useEffect(() => {
    const pendingEntries = Object.entries(params.pendingScrollToEndRef.current).filter(
      ([feedId, pending]) => params.scheduledScrollToEndRef.current[feedId] !== pending.generation,
    );
    if (pendingEntries.length === 0) return;
    const refs = params.columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pendingEntries.forEach(([feedId, pending]) => {
          const generation = pending.generation;
          if (params.scheduledScrollToEndRef.current[feedId] !== generation) return;
          if (params.pendingScrollToEndRef.current[feedId]?.generation !== generation) {
            delete params.scheduledScrollToEndRef.current[feedId];
            return;
          }
          if (params.disableAutoScroll || !params.isFollowTailValid(feedId, generation)) {
            delete params.scheduledScrollToEndRef.current[feedId];
            return;
          }
          delete params.pendingScrollToEndRef.current[feedId];
          delete params.scheduledScrollToEndRef.current[feedId];
          if (!refs[feedId]) return;
          refs[feedId]?.scrollToEnd(getDutyFollowScrollBehavior(), {
            intent: ScrollNavigationIntent.AutomaticFollow,
          });
        });
      });
    });
    pendingEntries.forEach(([feedId, pending]) => {
      params.scheduledScrollToEndRef.current[feedId] = pending.generation;
    });
  }, [
    params.changeKey,
    params.columnRefsRef,
    params.disableAutoScroll,
    params.isFollowTailValid,
    params.pendingScrollToEndRef,
    params.scheduledScrollToEndRef,
  ]);
}

/** Owns per-feed navigation identities used to reject stale follow and arrow work. */
export function useRerDutyNavigation() {
  const pendingScrollToEndRef = useRef<Record<string, PendingFeedLanding>>({});
  const scheduledScrollToEndRef = useRef<Record<string, number>>({});
  const followTailByFeedIdRef = useRef<Record<string, boolean>>({});
  const followGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const explicitNavigationByFeedIdRef = useRef<Record<string, NavigationState>>({});

  useEffect(
    () => () => {
      Object.values(explicitNavigationByFeedIdRef.current).forEach((operation) => {
        operation.cancelScheduledWork?.();
        operation.releaseLoading?.();
      });
      explicitNavigationByFeedIdRef.current = {};
      pendingScrollToEndRef.current = {};
      scheduledScrollToEndRef.current = {};
    },
    [],
  );

  const beginFollowTail = useCallback((feedId: string) => {
    const generation = (followGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    followGenerationByFeedIdRef.current[feedId] = generation;
    followTailByFeedIdRef.current[feedId] = true;
    delete pendingScrollToEndRef.current[feedId];
    return generation;
  }, []);

  const ensureFollowTail = useCallback(
    (feedId: string) => {
      const generation = followGenerationByFeedIdRef.current[feedId];
      if (followTailByFeedIdRef.current[feedId] === true && generation !== undefined) {
        return generation;
      }
      return beginFollowTail(feedId);
    },
    [beginFollowTail],
  );

  const beginExplicitNavigation = useCallback(
    (feedId: string): ExplicitFeedNavigation => {
      const generation = beginFollowTail(feedId);
      const previous = explicitNavigationByFeedIdRef.current[feedId];
      previous?.cancelScheduledWork?.();
      previous?.releaseLoading?.();
      explicitNavigationByFeedIdRef.current[feedId] = {
        generation,
        state: 'ready',
        target: null,
        complete: null,
        releaseLoading: null,
        cancelScheduledWork: null,
      };
      return { feedId, generation };
    },
    [beginFollowTail],
  );

  const cancelFollowTail = useCallback((feedId: string) => {
    followGenerationByFeedIdRef.current[feedId] =
      (followGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    followTailByFeedIdRef.current[feedId] = false;
    delete pendingScrollToEndRef.current[feedId];
    delete scheduledScrollToEndRef.current[feedId];
    const operation = explicitNavigationByFeedIdRef.current[feedId];
    operation?.cancelScheduledWork?.();
    operation?.releaseLoading?.();
    delete explicitNavigationByFeedIdRef.current[feedId];
  }, []);

  const isFollowTailValid = useCallback(
    (feedId: string, generation: number) =>
      followTailByFeedIdRef.current[feedId] === true &&
      followGenerationByFeedIdRef.current[feedId] === generation,
    [],
  );

  const isExplicitNavigationCurrent = useCallback(
    ({ feedId, generation }: ExplicitFeedNavigation) => isFollowTailValid(feedId, generation),
    [isFollowTailValid],
  );

  const registerExplicitLanding = useCallback(
    (operation: ExplicitFeedNavigation, target: NavigationTarget, complete: () => void) => {
      if (!isExplicitNavigationCurrent(operation)) return false;
      const active = explicitNavigationByFeedIdRef.current[operation.feedId];
      if (!active || active.generation !== operation.generation) return false;
      if (active.state !== 'ready') return false;
      active.target = target;
      active.complete = complete;
      active.state = 'navigating';
      return true;
    },
    [isExplicitNavigationCurrent],
  );

  const registerExplicitLoading = useCallback(
    (operation: ExplicitFeedNavigation, releaseLoading: () => void) => {
      const active = explicitNavigationByFeedIdRef.current[operation.feedId];
      if (
        !isExplicitNavigationCurrent(operation) ||
        !active ||
        active.generation !== operation.generation
      ) {
        releaseLoading();
        return false;
      }
      active.releaseLoading?.();
      active.releaseLoading = releaseLoading;
      return true;
    },
    [isExplicitNavigationCurrent],
  );

  const isExplicitNavigationLoading = useCallback((feedId: string) => {
    const active = explicitNavigationByFeedIdRef.current[feedId];
    return (
      active?.releaseLoading != null && (active.state === 'ready' || active.state === 'navigating')
    );
  }, []);

  const cancelExplicitNavigation = useCallback((operation: ExplicitFeedNavigation) => {
    const active = explicitNavigationByFeedIdRef.current[operation.feedId];
    if (!active || active.generation !== operation.generation) return false;
    active.cancelScheduledWork?.();
    active.releaseLoading?.();
    delete explicitNavigationByFeedIdRef.current[operation.feedId];
    delete pendingScrollToEndRef.current[operation.feedId];
    delete scheduledScrollToEndRef.current[operation.feedId];
    return true;
  }, []);

  const registerExplicitScheduledWork = useCallback(
    (operation: ExplicitFeedNavigation, cancel: () => void) => {
      const active = explicitNavigationByFeedIdRef.current[operation.feedId];
      if (
        !isExplicitNavigationCurrent(operation) ||
        !active ||
        active.generation !== operation.generation ||
        active.state !== 'navigating'
      ) {
        cancel();
        return false;
      }
      active.cancelScheduledWork?.();
      active.cancelScheduledWork = cancel;
      return true;
    },
    [isExplicitNavigationCurrent],
  );

  const clearExplicitScheduledWork = useCallback((operation: ExplicitFeedNavigation) => {
    const active = explicitNavigationByFeedIdRef.current[operation.feedId];
    if (!active || active.generation !== operation.generation) return;
    active.cancelScheduledWork = null;
  }, []);

  const getExplicitScrollNavigation = useCallback(
    (feedId: string, generation: number): ExplicitScrollNavigation | null => {
      const active = explicitNavigationByFeedIdRef.current[feedId];
      if (
        !active ||
        active.generation !== generation ||
        active.state !== 'navigating' ||
        !active.target
      )
        return null;
      const operation = { feedId, generation };
      return {
        feedId,
        generation,
        targetId: active.target.id,
        isCurrent: () => isExplicitNavigationCurrent(operation),
        onLanded: () => {
          const current = explicitNavigationByFeedIdRef.current[feedId];
          if (!current || current.generation !== generation || current.state !== 'navigating')
            return;
          const complete = current.complete;
          current.cancelScheduledWork?.();
          delete explicitNavigationByFeedIdRef.current[feedId];
          delete pendingScrollToEndRef.current[feedId];
          delete scheduledScrollToEndRef.current[feedId];
          current.releaseLoading?.();
          complete?.();
        },
        onUnavailable: () => {
          const current = explicitNavigationByFeedIdRef.current[feedId];
          if (current?.generation === generation && current.state === 'navigating') {
            current.cancelScheduledWork?.();
            current.releaseLoading?.();
            delete explicitNavigationByFeedIdRef.current[feedId];
            delete pendingScrollToEndRef.current[feedId];
            delete scheduledScrollToEndRef.current[feedId];
          }
        },
      };
    },
    [isExplicitNavigationCurrent],
  );

  return {
    pendingScrollToEndRef,
    scheduledScrollToEndRef,
    followTailByFeedIdRef,
    followGenerationByFeedIdRef,
    beginFollowTail,
    ensureFollowTail,
    beginExplicitNavigation,
    cancelFollowTail,
    isFollowTailValid,
    isExplicitNavigationCurrent,
    registerExplicitLanding,
    registerExplicitLoading,
    isExplicitNavigationLoading,
    cancelExplicitNavigation,
    registerExplicitScheduledWork,
    clearExplicitScheduledWork,
    getExplicitScrollNavigation,
  };
}
