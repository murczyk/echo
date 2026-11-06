import { useEffect, useState } from 'react';

import type { MessengersChatItem } from '../../../../Bindings';
import { isAbortError } from '../../services/api/client';
import { listMessengersChats } from '../../services/api/analysis-messengers';
import { toErrorMessage } from './use-analysis-data.shared';

export type MessengerChatSection = 'private' | 'group' | 'channel' | 'bot';

// TODO: `isBot` is optional until the backend sends it (Bindings.ts is generated, so it is added here);
// then drop this type, use MessengersChatItem and make the flag required.
export type MessengerChat = MessengersChatItem & { isBot?: boolean | null };

// Bots are PRIVATE chats flagged `isBot`, as in kontur. `chat_type` is free text, so unknown values land in groups.
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

export function useMessengerChats(accountId: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listMessengersChats({ accountId }, { signal: controller.signal })
      .then((rsp) => setResult({ accountId, attempt, chats: rsp.items, error: null }))
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        setResult({ accountId, attempt, chats: [], error: toErrorMessage(reason) });
      });
    return () => controller.abort();
  }, [accountId, attempt]);

  // A result counts only for the account and attempt it was loaded for, so another account never
  // shows the previous chats, and a retry shows loading again.
  const current = result?.accountId === accountId && result.attempt === attempt ? result : null;
  return {
    chats: current?.chats ?? [],
    loading: current == null,
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
  };
}
