import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupFeedCursorDto, InboxMessage } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import type { GroupFeedNavigationModel, GroupNavigationItem } from './group-navigation.types';
import { groupFeedStateStore } from './group-feed-state-store';

const GROUP_READ_DWELL_MS = 300;

type ReadPosition = { cursor: GroupFeedCursorDto; order: number };
type ReadQueue = {
  attempted?: ReadPosition;
  pending?: ReadPosition;
  active?: { position: ReadPosition; controller: AbortController };
};

function isNewer(left: ReadPosition, right: ReadPosition): boolean {
  return (
    left.order > right.order ||
    (left.order === right.order && left.cursor.messageId > right.cursor.messageId)
  );
}

export function useGroupFeedReadReceipts({
  enabled,
  groups,
  messages,
  acknowledge,
}: {
  enabled: boolean;
  groups: readonly GroupNavigationItem[];
  messages: ReadonlyArray<[number, InboxMessage]>;
  acknowledge: GroupFeedNavigationModel['acknowledge'];
}) {
  const [visibleIds, setVisibleIds] = useState<readonly number[]>([]);
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible');
  const queues = useRef(new Map<string, ReadQueue>());
  const acknowledgeRef = useRef(acknowledge);
  acknowledgeRef.current = acknowledge;

  const flush = useCallback(function flush(masterKey: string) {
    const queue = queues.current.get(masterKey);
    if (!queue?.pending || queue.active) return;
    const position = queue.pending;
    queue.pending = undefined;
    const controller = new AbortController();
    queue.active = { position, controller };
    queue.attempted = position;
    void acknowledgeRef
      .current({ masterKey, cursor: position.cursor }, controller.signal)
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === 'AbortError') &&
          !(error instanceof HttpRequestError && error.status === 409) &&
          queue.attempted === position
        ) {
          queue.attempted = undefined;
        }
      })
      .finally(() => {
        if (queue.active?.controller !== controller) return;
        queue.active = undefined;
        flush(masterKey);
      });
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const queue of queues.current.values()) {
        queue.active?.controller.abort();
        queue.active = undefined;
        queue.pending = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (enabled && documentVisible && visibleIds.length > 0) {
      void groupFeedStateStore.ensureLoaded();
    }
  }, [documentVisible, enabled, messages, visibleIds]);

  useEffect(() => {
    if (!enabled || !documentVisible) return;
    const visible = new Set(visibleIds);
    const unreadGroups = new Set(
      groups
        .filter((group) => group.unreadCount > 0 && group.latestCursor != null)
        .map((group) => group.masterKey),
    );
    const positions = new Map<string, ReadPosition>();
    for (const [id, message] of messages) {
      if (!visible.has(id) || message.createdAt == null || message.isOwn === true) {
        continue;
      }
      const position = {
        cursor: { createdAt: message.createdAt, messageId: id },
        order: message.createdAtOrder ?? message.createdAt * 1000,
      };
      const memberships =
        message.groupMasterKeys ?? (message.groupMasterKey ? [message.groupMasterKey] : []);
      for (const masterKey of memberships) {
        if (!unreadGroups.has(masterKey)) continue;
        const previous = positions.get(masterKey);
        if (!previous || isNewer(position, previous)) positions.set(masterKey, position);
      }
    }
    if (positions.size === 0) return;
    const timer = window.setTimeout(() => {
      for (const [masterKey, position] of positions) {
        const queue: ReadQueue = queues.current.get(masterKey) ?? {};
        queues.current.set(masterKey, queue);
        if (
          [queue.attempted, queue.pending].some(
            (previous) => previous && !isNewer(position, previous),
          )
        )
          continue;
        queue.pending = position;
        flush(masterKey);
      }
    }, GROUP_READ_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [documentVisible, enabled, flush, groups, messages, visibleIds]);

  return useCallback((ids: readonly number[]) => {
    setVisibleIds((previous) =>
      previous.length === ids.length && previous.every((id, index) => id === ids[index])
        ? previous
        : [...ids],
    );
  }, []);
}
