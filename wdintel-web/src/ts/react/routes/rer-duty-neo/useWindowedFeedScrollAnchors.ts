import { useCallback, useMemo } from 'react';
import {
  isDutyScrollDebugEnabled,
  recordDutyScrollDebugEvent,
  recordDutyScrollDebugMetrics,
} from './duty-scroll-debug';
import {
  distanceToBottom,
  effectiveBottomLoadBufferPx,
  type VisibleAnchor,
  type WindowedFeedScrollRefs,
} from './windowed-feed-scroll-shared';

const MAX_SYNC_ANCHOR_CORRECTIONS = 5;

type AnchorRestoreOutcome = 'restored' | 'pending' | 'missing';

type AnchorRestoreOptions = {
  settleSynchronousLayout?: boolean;
};

export function useWindowedFeedScrollAnchors(args: {
  refs: WindowedFeedScrollRefs;
  debugFeedId?: string;
  topLoadBufferPx: number;
  bottomLoadBufferPx: number;
  atBottomThresholdPx: number;
  unreadPrefetchNeeded: boolean;
}) {
  const {
    refs,
    debugFeedId,
    topLoadBufferPx,
    bottomLoadBufferPx,
    atBottomThresholdPx,
    unreadPrefetchNeeded,
  } = args;

  const collectVisibleAnchors = useCallback((): VisibleAnchor[] => {
    const scroller = refs.scrollerRef.current;
    if (!scroller) return [];
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;
    const scrollerBottom = scrollerRect.bottom;
    const ids = refs.itemIdsRef.current;
    if (ids.length === 0) return [];

    const getRect = (idx: number) => {
      const id = ids[idx];
      const node = refs.itemRefsRef.current.get(id);
      return node ? node.getBoundingClientRect() : null;
    };

    let low = 0;
    let high = ids.length - 1;
    let firstVisibleIdx = -1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const rect = getRect(mid);

      if (!rect) {
        low = mid + 1;
        continue;
      }

      if (rect.bottom >= scrollerTop) {
        if (mid === 0) {
          firstVisibleIdx = mid;
          break;
        } else {
          const prevRect = getRect(mid - 1);
          if (!prevRect || prevRect.bottom < scrollerTop) {
            firstVisibleIdx = mid;
            break;
          } else {
            high = mid - 1;
          }
        }
      } else {
        low = mid + 1;
      }
    }

    if (firstVisibleIdx === -1) return [];

    const anchors: VisibleAnchor[] = [];
    for (let i = firstVisibleIdx; i < ids.length; i++) {
      const id = ids[i];
      const node = refs.itemRefsRef.current.get(id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top > scrollerBottom) break;
      if (rect.bottom >= scrollerTop) {
        anchors.push({ id, index: i, offsetTop: rect.top - scrollerTop });
      }
    }

    return anchors;
  }, [refs]);

  const collectMountedItemOffsets = useCallback((): Map<number, number> => {
    const scroller = refs.scrollerRef.current;
    const offsets = new Map<number, number>();
    if (!scroller) return offsets;
    const scrollerTop = scroller.getBoundingClientRect().top;
    for (const id of refs.itemIdsRef.current) {
      const node = refs.itemRefsRef.current.get(id);
      if (!node) continue;
      offsets.set(id, node.getBoundingClientRect().top - scrollerTop);
    }
    return offsets;
  }, [refs]);

  const captureAnchorSnapshot = useCallback(() => {
    const scroller = refs.scrollerRef.current;
    if (!scroller) {
      refs.anchorSnapshotRef.current = null;
      return;
    }
    const anchors = collectVisibleAnchors();
    const itemOffsets = collectMountedItemOffsets();
    if (anchors.length === 0 && itemOffsets.size === 0) {
      refs.anchorSnapshotRef.current = null;
      return;
    }
    refs.anchorSnapshotRef.current = {
      anchors,
      itemOffsets,
      itemIds: refs.itemIdsRef.current.slice(),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
  }, [collectMountedItemOffsets, collectVisibleAnchors, refs]);

  const touchAnchorSnapshotScrollMetrics = useCallback(() => {
    const scroller = refs.scrollerRef.current;
    const snapshot = refs.anchorSnapshotRef.current;
    if (!scroller || !snapshot) return;
    if (
      snapshot.scrollTop === scroller.scrollTop &&
      snapshot.scrollHeight === scroller.scrollHeight
    ) {
      return;
    }
    refs.anchorSnapshotRef.current = {
      ...snapshot,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
  }, [refs]);

  const captureVisibleAnchorSnapshot = useCallback(() => {
    const scroller = refs.scrollerRef.current;
    if (!scroller) return;
    const anchors = collectVisibleAnchors();
    if (anchors.length === 0) {
      touchAnchorSnapshotScrollMetrics();
      return;
    }
    const itemOffsets = new Map<number, number>();
    for (const anchor of anchors) {
      itemOffsets.set(anchor.id, anchor.offsetTop);
    }
    refs.anchorSnapshotRef.current = {
      anchors,
      itemOffsets,
      itemIds: refs.itemIdsRef.current.slice(),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
  }, [collectVisibleAnchors, refs, touchAnchorSnapshotScrollMetrics]);

  const publishDebugMetrics = useCallback(
    (scroller: HTMLDivElement, previousScrollTop: number) => {
      if (!isDutyScrollDebugEnabled() || !debugFeedId) return;
      const bottomDistance = distanceToBottom(scroller);
      const anchors = collectVisibleAnchors();
      const anchor = refs.anchorSnapshotRef.current?.anchors[0] ?? null;
      const computedStyle = window.getComputedStyle(scroller);
      const bottomBufferPx = effectiveBottomLoadBufferPx(
        scroller,
        bottomLoadBufferPx,
        unreadPrefetchNeeded,
      );
      recordDutyScrollDebugMetrics(debugFeedId, {
        capturedAtMs: Date.now(),
        scrollTop: scroller.scrollTop,
        previousScrollTop,
        scrollDelta: scroller.scrollTop - previousScrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        bottomDistance,
        topLoadBufferPx,
        bottomLoadBufferPx: bottomBufferPx,
        atBottomThresholdPx,
        atTop: scroller.scrollTop <= 0,
        atBottom: bottomDistance <= atBottomThresholdPx,
        physicallyAtBottom: bottomDistance <= 1,
        nearBottom: bottomDistance <= bottomBufferPx,
        liveBottomFollow: refs.liveBottomFollowRef.current,
        bottomSettleActive: refs.bottomSettleActiveRef.current,
        loadOlderTriggered: refs.loadOlderTriggeredRef.current,
        loadNewerTriggered: refs.loadNewerTriggeredRef.current,
        visibleAnchorCount: anchors.length,
        firstVisibleId: anchors[0]?.id ?? null,
        lastVisibleId: anchors.at(-1)?.id ?? null,
        anchorId: anchor?.id ?? null,
        anchorOffsetTop: anchor?.offsetTop ?? null,
        itemCount: refs.itemIdsRef.current.length,
        firstItemId: refs.itemIdsRef.current[0] ?? null,
        lastItemId: refs.itemIdsRef.current.at(-1) ?? null,
        enabled: refs.enabledRef.current,
        isWatchMode: refs.isWatchModeRef.current,
        overflowAnchor: computedStyle.overflowAnchor,
        scrollBehavior: computedStyle.scrollBehavior,
      });
    },
    [
      atBottomThresholdPx,
      bottomLoadBufferPx,
      collectVisibleAnchors,
      debugFeedId,
      refs,
      topLoadBufferPx,
      unreadPrefetchNeeded,
    ],
  );

  const reportVisibleMessageIds = useCallback(
    (atBottom: boolean) => {
      if (!refs.enabledRef.current) return;
      refs.reportVisibleMessageIdsLatestArgsRef.current = atBottom;

      const run = () => {
        if (!refs.enabledRef.current) return;
        refs.reportVisibleMessageIdsLastRunRef.current = Date.now();
        const latestAtBottom = refs.reportVisibleMessageIdsLatestArgsRef.current;
        const { onVisibleMessageIds } = refs.callbacksRef.current;
        if (!onVisibleMessageIds || refs.itemIdsRef.current.length === 0) return;
        if (latestAtBottom) {
          onVisibleMessageIds(refs.itemIdsRef.current[refs.itemIdsRef.current.length - 1], {
            atBottom: true,
          });
          return;
        }

        const anchors = collectVisibleAnchors();
        const lastVisibleIndex = anchors.reduce((max, anchor) => Math.max(max, anchor.index), -1);
        if (lastVisibleIndex < 0) return;
        onVisibleMessageIds(refs.itemIdsRef.current[lastVisibleIndex], { atBottom: false });
      };

      const now = Date.now();
      if (now - refs.reportVisibleMessageIdsLastRunRef.current > 200) {
        if (refs.reportVisibleMessageIdsRafRef.current !== null) {
          window.clearTimeout(refs.reportVisibleMessageIdsRafRef.current);
          refs.reportVisibleMessageIdsRafRef.current = null;
        }
        run();
      } else if (refs.reportVisibleMessageIdsRafRef.current === null) {
        refs.reportVisibleMessageIdsRafRef.current = window.setTimeout(() => {
          refs.reportVisibleMessageIdsRafRef.current = null;
          if (!refs.enabledRef.current) return;
          run();
        }, 200);
      }
    },
    [collectVisibleAnchors, refs],
  );

  const restoreAnchorPosition = useCallback(
    (options?: AnchorRestoreOptions): AnchorRestoreOutcome => {
      const scroller = refs.scrollerRef.current;
      const snapshot = refs.anchorSnapshotRef.current;
      if (!scroller || !snapshot) return 'missing';
      const maxCorrections = options?.settleSynchronousLayout ? MAX_SYNC_ANCHOR_CORRECTIONS : 1;

      const applyDelta = (
        id: number,
        expectedOffsetTop: number,
        reason: string,
      ): AnchorRestoreOutcome | null => {
        const node = refs.itemRefsRef.current.get(id);
        if (!node) return null;
        const scrollerTop = scroller.getBoundingClientRect().top;
        const initialOffsetTop = node.getBoundingClientRect().top - scrollerTop;
        let residualDelta = initialOffsetTop - expectedOffsetTop;
        let correctionCount = 0;
        while (Math.abs(residualDelta) > 0.5 && correctionCount < maxCorrections) {
          const targetScrollTop = scroller.scrollTop + residualDelta;
          const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (targetScrollTop > maxScrollTop + 0.5) {
            recordDutyScrollDebugEvent(
              debugFeedId,
              'anchor:restore-pending',
              `id=${id}; reason=${reason}; target=${targetScrollTop.toFixed(1)}; range=0..${maxScrollTop.toFixed(1)}`,
            );
            return 'pending';
          }
          refs.isRestoringAnchorRef.current = true;
          scroller.scrollTop += residualDelta;
          refs.previousScrollTopRef.current = scroller.scrollTop;
          refs.isRestoringAnchorRef.current = false;
          correctionCount += 1;
          residualDelta = node.getBoundingClientRect().top - scrollerTop - expectedOffsetTop;
        }
        const outcome = Math.abs(residualDelta) <= 0.5 ? 'restored' : 'pending';
        recordDutyScrollDebugEvent(
          debugFeedId,
          'anchor:restore',
          `id=${id}; reason=${reason}; offset=${expectedOffsetTop.toFixed(1)}; current=${initialOffsetTop.toFixed(1)}; corrections=${correctionCount}; residual=${residualDelta.toFixed(1)}; outcome=${outcome}`,
        );
        return outcome;
      };

      for (const anchor of snapshot.anchors) {
        const outcome = applyDelta(anchor.id, anchor.offsetTop, 'visible');
        if (outcome !== null) return outcome;
      }

      for (const id of snapshot.itemIds) {
        const expectedOffsetTop = snapshot.itemOffsets.get(id);
        if (expectedOffsetTop == null) continue;
        const outcome = applyDelta(id, expectedOffsetTop, 'common');
        if (outcome !== null) return outcome;
      }

      const firstCurrentId = refs.itemIdsRef.current[0];
      if (firstCurrentId != null) {
        const trimmedPrefix = snapshot.itemIds.indexOf(firstCurrentId);
        if (trimmedPrefix > 0) {
          let removedHeight = 0;
          for (let i = 0; i < trimmedPrefix; i++) {
            const id = snapshot.itemIds[i];
            const nextId = snapshot.itemIds[i + 1];
            const top = snapshot.itemOffsets.get(id);
            const nextTop = snapshot.itemOffsets.get(nextId);
            if (top == null || nextTop == null) {
              removedHeight = 0;
              break;
            }
            removedHeight += nextTop - top;
          }
          if (removedHeight > 0.5) {
            refs.isRestoringAnchorRef.current = true;
            scroller.scrollTop = Math.max(0, snapshot.scrollTop - removedHeight);
            refs.previousScrollTopRef.current = scroller.scrollTop;
            refs.isRestoringAnchorRef.current = false;
            recordDutyScrollDebugEvent(
              debugFeedId,
              'anchor:restore',
              `reason=prefix-height; removed=${removedHeight.toFixed(1)}; scrollTop=${scroller.scrollTop.toFixed(1)}`,
            );
            return 'restored';
          }
        }
      }

      recordDutyScrollDebugEvent(
        debugFeedId,
        'anchor:missing',
        `visible=${snapshot.anchors.map((anchor) => anchor.id).join(',')}; snapshotMounted=${snapshot.itemIds.join(',')}; liveMounted=${[...refs.itemRefsRef.current.keys()].join(',')}; unmountedAnchor=${snapshot.anchors.some((anchor) => !refs.itemRefsRef.current.has(anchor.id))}`,
      );
      return 'missing';
    },
    [debugFeedId, refs],
  );

  return useMemo(
    () => ({
      collectVisibleAnchors,
      captureAnchorSnapshot,
      captureVisibleAnchorSnapshot,
      restoreAnchorPosition,
      publishDebugMetrics,
      reportVisibleMessageIds,
    }),
    [
      captureAnchorSnapshot,
      captureVisibleAnchorSnapshot,
      collectVisibleAnchors,
      publishDebugMetrics,
      reportVisibleMessageIds,
      restoreAnchorPosition,
    ],
  );
}
