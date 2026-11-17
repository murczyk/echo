import { useCallback, useEffect, useState } from 'react';

import type { MessengersChatItem, MessengersChatReadState } from '../../../../Bindings';
import { isAbortError } from '../../services/api/client';
import {
  listMessengersChats,
  markAllMessengersChatsRead,
} from '../../services/api/analysis-messengers';
import { toErrorMessage } from './use-analysis-data.shared';

export type MessengerChatSection = 'private' | 'group' | 'channel' | 'bot';

export type MessengerChat = MessengersChatItem;

// Bots are PRIVATE chats flagged `isBot`, as in the collector. `chat_type` is free text, so unknown values land in groups.
export function chatSectionOf(chat: MessengerChat): MessengerChatSection {
  switch (chat.chatType?.toLowerCase()) {
    case 'private':
      return chat.isBot ? 'bot' : 'private';
    case 'channel':
      return 'channel';
    default:
      return 'group';
  }
}

type Result = { accountId: string; attempt: number; chats: MessengerChat[]; error: string | null };

// A new `refreshToken` reloads the list in place, the old chats stay on screen until the answer comes.
export function useMessengerChats(accountId: string, refreshToken = 0) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  // True while a request is in flight, the header refresh stays disabled meanwhile.
  const [fetching, setFetching] = useState(false);
  // Bumped after "read all" to load the counts again without showing the loading state.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFetching(true);
    listMessengersChats({ accountId }, { signal: controller.signal })
      .then((rsp) => {
        setResult({ accountId, attempt, chats: rsp.items, error: null });
        setFetching(false);
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        // A failed refresh keeps the chats of this account, so an open chat does not vanish.
        setResult((previous) => ({
          accountId,
          attempt,
          chats: previous?.accountId === accountId ? previous.chats : [],
          error: toErrorMessage(reason),
        }));
        setFetching(false);
      });
    return () => {
      controller.abort();
      setFetching(false);
    };
  }, [accountId, attempt, refreshToken, reloadKey]);

  // The read state of one chat as the server answered it, so its badge follows the reader without a reload.
  const patchReadState = useCallback((chatId: string, state: MessengersChatReadState) => {
    setResult((previous) =>
      previous == null
        ? previous
        : {
            ...previous,
            chats: previous.chats.map((chat) =>
              chat.id === chatId ? { ...chat, ...state } : chat,
            ),
          },
    );
  }, []);

  // Marks every chat of the account read, then loads the counts. Rejects when the request failed.
  const markAllRead = useCallback(async () => {
    await markAllMessengersChatsRead({ accountId });
    setReloadKey((value) => value + 1);
  }, [accountId]);

  // A result counts only for the account and attempt it was loaded for, so another account never
  // shows the previous chats, and a retry shows loading again.
  const current = result?.accountId === accountId && result.attempt === attempt ? result : null;
  return {
    chats: current?.chats ?? [],
    loading: current == null,
    fetching,
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
    patchReadState,
    markAllRead,
  };
}
