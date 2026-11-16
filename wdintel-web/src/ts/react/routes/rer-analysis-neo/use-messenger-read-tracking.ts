import { useCallback, useEffect, useRef } from 'react';

import type { MessengersChatReadState, MessengersMessageItem } from '../../../../Bindings';
import { updateMessengersChatReadState } from '../../services/api/analysis-messengers';

// A write waits for the reader to settle, and one write covers everything seen meanwhile.
export const READ_DEBOUNCE_MS = 1500;

type Args = {
  accountId: string;
  chatId: string;
  // The loaded window, oldest first.
  messages: readonly MessengersMessageItem[];
  // Identifies that window: a new key is a window that replaced the old one (a jump), not one that grew by a page.
  windowKey: number;
  // The stored read span of the chat (the chat list item), which follows the answers of the writes.
  oldestReadAt: number | null;
  newestReadAt: number | null;
  onReadState: (chatId: string, state: MessengersChatReadState) => void;
};

// Marks the messages the reader has seen as read. The stored read state is one span, so a write that is not
// next to it would also mark every message between them read. The window is contiguous: it is safe to write only
// when it reaches into the stored span (or there is none yet), because everything between a seen message and
// the span is then loaded, and was scrolled through on the way.
//
// Two things keep that true across a jump (to the start, to the end, to the unread): what was seen in one window is
// sent as it is and never merged with what is seen in the next one, and what was just sent counts as part of the
// stored span at once, without waiting for the answer, so the next window is judged against it.
export function useMessengerReadTracking({
  accountId,
  chatId,
  messages,
  windowKey,
  oldestReadAt,
  newestReadAt,
  onReadState,
}: Args) {
  const latest = useRef({ messages, windowKey, oldestReadAt, newestReadAt, onReadState });
  latest.current = { messages, windowKey, oldestReadAt, newestReadAt, onReadState };
  const pending = useRef<{ from: number; to: number } | null>(null);
  // The window `pending` was collected in.
  const pendingWindow = useRef(windowKey);
  // The writes that went out and did not fail, by number: what this hook has written counts as part of the stored span
  // until the stored span (the props) has caught up with it. One per write, so a failed one takes out only itself.
  const writes = useRef(new Map<number, { from: number; to: number }>());
  const timer = useRef<number | null>(null);
  // The number of the next write.
  const sequence = useRef(0);
  // The span of the answer shown last. An answer is judged by its span, not by when its request was made (see `flush`).
  const shown = useRef<{ from: number; to: number } | null>(null);

  const flush = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const range = pending.current;
    pending.current = null;
    if (range == null) return;
    const mine = ++sequence.current;
    writes.current.set(mine, range);
    updateMessengersChatReadState({
      accountId,
      chatId,
      oldestReadAt: range.from,
      newestReadAt: range.to,
    })
      .then((state) => {
        // The stored span only ever widens, so an answer that holds the span on screen is at least as current as it, whatever
        // the order the requests ran in on the server: a later request can run first, and the earlier one then answers with
        // the union. A narrower answer is an older state and is not shown.
        const { oldestReadAt: oldest, newestReadAt: newest } = latest.current;
        const onScreenFrom = Math.min(oldest ?? Infinity, shown.current?.from ?? Infinity);
        const onScreenTo = Math.max(newest ?? -Infinity, shown.current?.to ?? -Infinity);
        if (state.oldestReadAt == null || state.newestReadAt == null) return;
        if (state.oldestReadAt > onScreenFrom || state.newestReadAt < onScreenTo) return;
        shown.current = { from: state.oldestReadAt, to: state.newestReadAt };
        latest.current.onReadState(chatId, state);
      })
      // The next scroll sends it again, and a failed write only leaves the badge as it was.
      .catch(() => {
        writes.current.delete(mine);
      });
  }, [accountId, chatId]);

  // The reader leaves the chat: what was seen is not lost to the delay.
  useEffect(() => flush, [flush]);

  // What was on screen while the tab was hidden. A hidden tab shows nothing to anyone, so it reads nothing; the messages
  // that were there count once the tab is shown.
  const deferred = useRef<readonly string[] | null>(null);
  const onVisibleMessagesRef = useRef<(ids: readonly string[]) => void>(() => undefined);

  const onVisibleMessages = useCallback(
    (ids: readonly string[]) => {
      if (document.visibilityState === 'hidden') {
        deferred.current = ids;
        return;
      }
      const { messages: loaded, windowKey: key, oldestReadAt, newestReadAt } = latest.current;
      if (ids.length === 0 || loaded.length === 0) return;
      const seen = new Set(ids);
      let from = Infinity;
      let to = -Infinity;
      for (const message of loaded) {
        if (!seen.has(message.id)) continue;
        from = Math.min(from, message.sentAt);
        to = Math.max(to, message.sentAt);
      }
      if (from > to) return;
      // A jump replaced the window: what was seen before it goes out as it is, and starts nothing in common with this one.
      if (pending.current != null && pendingWindow.current !== key) flush();
      // The stored span, plus what was written and not answered yet.
      let spanFrom = oldestReadAt ?? Infinity;
      let spanTo = newestReadAt ?? -Infinity;
      for (const written of writes.current.values()) {
        spanFrom = Math.min(spanFrom, written.from);
        spanTo = Math.max(spanTo, written.to);
      }
      if (spanFrom !== Infinity) {
        if (from >= spanFrom && to <= spanTo) return;
        const reachesSpan =
          loaded[0].sentAt <= spanTo && loaded[loaded.length - 1].sentAt >= spanFrom;
        if (!reachesSpan) return;
      }
      const range = pending.current;
      if (range == null) pendingWindow.current = key;
      pending.current = {
        from: range == null ? from : Math.min(range.from, from),
        to: range == null ? to : Math.max(range.to, to),
      };
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, READ_DEBOUNCE_MS);
    },
    [flush],
  );

  onVisibleMessagesRef.current = onVisibleMessages;
  useEffect(() => {
    const onVisibilityChange = () => {
      const ids = deferred.current;
      if (document.visibilityState !== 'visible' || ids == null) return;
      deferred.current = null;
      onVisibleMessagesRef.current(ids);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return { onVisibleMessages };
}
