import { useEffect, useState } from 'react';

import type { MessengersChatMemberItem } from '../../../../Bindings';
import { listMessengersChatMembers } from '../../services/api/analysis-messengers';
import { isAbortError } from '../../services/api/client';
import { toErrorMessage } from './use-analysis-data.shared';

type Result = { chatId: string; members: MessengersChatMemberItem[] | null; error: string | null };

// Every member of one analysis messenger chat, in one request (the API has no paging). A new `refreshToken` (the
// header refresh button) reloads in place: the old members stay on screen until the answer comes.
// shortcut: this asks `chats/members/list` on its own although the open chat already loaded it for the sender names,
// share one cache when a very large group makes the second request noticeable.
export function useMessengerChatMembers(accountId: string, chatId: string, refreshToken = 0) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFetching(true);
    listMessengersChatMembers({ accountId, chatId }, { signal: controller.signal })
      .then((rsp) => {
        setResult({ chatId, members: rsp.items, error: null });
        setFetching(false);
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        // A failed refresh keeps the members of this chat.
        setResult((previous) => ({
          chatId,
          members: previous?.chatId === chatId ? previous.members : null,
          error: toErrorMessage(reason),
        }));
        setFetching(false);
      });
    return () => controller.abort();
  }, [accountId, chatId, refreshToken, attempt]);

  const current = result?.chatId === chatId ? result : null;
  return {
    members: current?.members ?? [],
    // Nothing to show yet.
    loading: current?.members == null && current?.error == null,
    fetching,
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
  };
}
