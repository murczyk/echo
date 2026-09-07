import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { InboxMessagesReq } from '../../../../Bindings';
import { fetchInboxCount } from '../../services/api/inbox';
import type { MessageFeedState } from './utils';
import { beginDutyScrollDebugActivity, recordDutyScrollDebugEvent } from './duty-scroll-debug';
import {
  DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
  withDutyFeedRequestDeadline,
} from './dutyFeedRequestDeadline';

export type ConfirmedTailPreview = { tailId: number; count: number; generation: number };

type Params = {
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  pendingReloadFeedIdsRef: MutableRefObject<Set<string>>;
  getFeedLoadGeneration: (feedId: string) => number;
  buildReqForFeed: (
    feed: MessageFeedState,
    options: { sinceIdNoninclusive?: number; nolimit?: boolean },
  ) => InboxMessagesReq;
  getFeedCountSignature: (feed: MessageFeedState) => string;
};

/** Owns tail polling request identity, de-duplication, and stale-response rejection. */
export function useRerDutyTailPollRequests(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const tailCountRequestPromiseByFeedIdRef = useRef<Record<string, Promise<number | null>>>({});
  const tailPreviewPromiseByFeedIdRef = useRef<
    Record<string, Promise<ConfirmedTailPreview | null>>
  >({});
  const tailPreviewGenerationByFeedIdRef = useRef<Record<string, number>>({});

  const resetTailRequests = useCallback((feedId: string) => {
    tailPreviewGenerationByFeedIdRef.current[feedId] =
      (tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    delete tailCountRequestPromiseByFeedIdRef.current[feedId];
    delete tailPreviewPromiseByFeedIdRef.current[feedId];
  }, []);

  const requestValidatedTailCount = useCallback((feedId: string, tailId: number) => {
    const requestParams = paramsRef.current;
    const existingPromise = tailCountRequestPromiseByFeedIdRef.current[feedId];
    if (existingPromise) return existingPromise;
    const feed = requestParams.messageFeedsRef.current.find((candidate) => candidate.id === feedId);
    if (!feed || feed.loading || feed.items.at(-1)?.[0] !== tailId) return Promise.resolve(null);
    const requestGeneration = requestParams.getFeedLoadGeneration(feedId);
    const requestSignature = requestParams.getFeedCountSignature(feed);
    const requestPromise = (async () => {
      const finish = beginDutyScrollDebugActivity(feedId, 'tailCount', `tail=${tailId}`);
      let quantity: number;
      try {
        ({ quantity } = await withDutyFeedRequestDeadline(
          DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
          (signal) =>
            fetchInboxCount(
              requestParams.buildReqForFeed(feed, { sinceIdNoninclusive: tailId, nolimit: true }),
              { signal },
            ),
        ));
        finish(`ok; quantity=${quantity}; tail=${tailId}`);
      } catch (error) {
        finish(`error; tail=${tailId}; ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      const currentFeed = requestParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (
        !currentFeed ||
        currentFeed.loading ||
        requestParams.getFeedLoadGeneration(feedId) !== requestGeneration ||
        currentFeed.items.at(-1)?.[0] !== tailId ||
        requestParams.getFeedCountSignature(currentFeed) !== requestSignature
      ) {
        recordDutyScrollDebugEvent(feedId, 'counter:discard', `tail=${tailId} became stale`);
        return null;
      }
      recordDutyScrollDebugEvent(feedId, 'counter:accept', `tail=${tailId}; newer=${quantity}`);
      return quantity;
    })();
    tailCountRequestPromiseByFeedIdRef.current[feedId] = requestPromise;
    void requestPromise
      .finally(() => {
        if (tailCountRequestPromiseByFeedIdRef.current[feedId] === requestPromise) {
          delete tailCountRequestPromiseByFeedIdRef.current[feedId];
        }
      })
      .catch(() => {});
    return requestPromise;
  }, []);

  const requestValidatedTailPreview = useCallback(
    (feedId: string): Promise<ConfirmedTailPreview | null> => {
      const requestParams = paramsRef.current;
      const existingPromise = tailPreviewPromiseByFeedIdRef.current[feedId];
      if (existingPromise) return existingPromise;
      const feed = requestParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      const tailId = feed?.items.at(-1)?.[0];
      if (
        !feed ||
        feed.loading ||
        requestParams.pendingReloadFeedIdsRef.current.has(feedId) ||
        tailId == null
      ) {
        return Promise.resolve(null);
      }
      const requestGeneration = requestParams.getFeedLoadGeneration(feedId);
      const generation = tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
      tailPreviewGenerationByFeedIdRef.current[feedId] = generation;
      const requestSignature = requestParams.getFeedCountSignature(feed);
      const requestPromise = (async () => {
        const count = await requestValidatedTailCount(feedId, tailId);
        const currentFeed = requestParams.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        if (
          count === null ||
          !currentFeed ||
          requestParams.getFeedLoadGeneration(feedId) !== requestGeneration ||
          currentFeed.items.at(-1)?.[0] !== tailId ||
          requestParams.getFeedCountSignature(currentFeed) !== requestSignature
        )
          return null;
        return { tailId, count, generation };
      })();
      tailPreviewPromiseByFeedIdRef.current[feedId] = requestPromise;
      void requestPromise
        .finally(() => {
          if (tailPreviewPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete tailPreviewPromiseByFeedIdRef.current[feedId];
          }
        })
        .catch(() => {});
      return requestPromise;
    },
    [requestValidatedTailCount],
  );

  return {
    tailPreviewGenerationByFeedIdRef,
    resetTailRequests,
    requestValidatedTailCount,
    requestValidatedTailPreview,
  };
}
