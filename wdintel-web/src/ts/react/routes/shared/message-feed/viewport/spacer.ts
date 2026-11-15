import type { MessageFeedId } from '../message-feed.types';
import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

export function useMessageFeedSpacer({
  scrollerRef,
  directItemTargetIdRef,
  itemIds,
}: {
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  directItemTargetIdRef: MutableRefObject<MessageFeedId | null>;
  itemIds: readonly MessageFeedId[];
}) {
  const [bottomSpacerPx, setBottomSpacerPx] = useState(0);
  const bottomSpacerRef = useRef(0);
  bottomSpacerRef.current = bottomSpacerPx;
  const reconcileBottomSpacer = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || directItemTargetIdRef.current !== null || scroller.clientHeight <= 0) return;
    setBottomSpacerPx((current) => {
      if (current === 0) return current;
      const contentHeight = scroller.scrollHeight - current;
      return Math.min(
        current,
        Math.ceil(Math.max(0, scroller.scrollTop + scroller.clientHeight - contentHeight)),
      );
    });
  }, [scrollerRef, directItemTargetIdRef]);
  useLayoutEffect(reconcileBottomSpacer, [itemIds, bottomSpacerPx, reconcileBottomSpacer]);
  return { bottomSpacerPx, bottomSpacerRef, setBottomSpacerPx, reconcileBottomSpacer };
}
