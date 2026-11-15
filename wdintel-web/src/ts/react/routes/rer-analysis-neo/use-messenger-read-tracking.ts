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
  // The stored read span of the chat (the chat list item), which follows the answers of the writes.
  oldestReadAt: number | null;
  newestReadAt: number | null;
  onReadState: (chatId: string, state: MessengersChatReadState) => void;
};

// Marks the messages the reader has seen as read. The stored read state is one span, so a write that is not
// next to it would also mark every message between them read. The window is contiguous: it is safe to write only
// when it reaches into the stored span (or there is none yet), because everything between a seen message and
// the span is then loaded, and was scrolled through on the way.
export function useMessengerReadTracking({
  accountId,
  chatId,
  messages,
  oldestReadAt,
  newestReadAt,
  onReadState,
}: Args) {
  const latest = useRef({ messages, oldestReadAt, newestReadAt, onReadState });
  latest.current = { messages, oldestReadAt, newestReadAt, onReadState };
  const pending = useRef<{ from: number; to: number } | null>(null);
  const timer = useRef<number | null>(null);
  // Only the newest answer is shown: the server widens the span, so an older answer would show an older count.
  const sequence = useRef(0);

  const flush = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const range = pending.current;
    pending.current = null;
    if (range == null) return;
    const mine = ++sequence.current;
    updateMessengersChatReadState({
      accountId,
      chatId,
      oldestReadAt: range.from,
      newestReadAt: range.to,
    })
      .then((state) => {
        if (mine === sequence.current) latest.current.onReadState(chatId, state);
      })
      // The next scroll sends it again, and a failed write only leaves the badge as it was.
      .catch(() => undefined);
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
      const { messages: loaded, oldestReadAt: oldest, newestReadAt: newest } = latest.current;
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
      if (oldest != null && newest != null) {
        if (from >= oldest && to <= newest) return;
        const reachesSpan =
          loaded[0].sentAt <= newest && loaded[loaded.length - 1].sentAt >= oldest;
        if (!reachesSpan) return;
      }
      const range = pending.current;
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
