import { startTransition } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MessageFeedState } from './utils';

/**
 * Commit window/`items` identity changes as a React transition so scroll/input
 * stay responsive while MessageCard trees reconcile.
 * Keep urgent `setMessageFeeds` for loading flags and other interactive chrome.
 */
export function commitFeedWindowUpdate(
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>,
  update: SetStateAction<MessageFeedState[]>,
): void {
  startTransition(() => {
    setMessageFeeds(update);
  });
}

/** User-driven flush (bottom / arrow): apply window update without deferring. */
export function commitFeedWindowUpdateUrgent(
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>,
  update: SetStateAction<MessageFeedState[]>,
): void {
  setMessageFeeds(update);
}
