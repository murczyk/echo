import type { InboxMessage } from '../../../../Bindings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';


import { submitAnalysisInboxMessages } from '../../services/api/analysis';

type Props = {
  messages: Array<[number, InboxMessage]>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  onUpdateLocalMessage: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => void;
};

type Result = {
  editorMessage: { id: number; message: InboxMessage } | null;
  editorSaveInFlight: boolean;
  closeEditor: () => void;
  openEditor: (messageId: number) => void;
  saveEditor: (message: InboxMessage) => Promise<void>;
  saveMessageUpdate: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => Promise<boolean>;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час збереження повідомлення.';
}

export function buildMessageDraftMap(messages: Array<[number, InboxMessage]>): Map<number, InboxMessage> {
  return new Map(messages);
}

export function prepareQueuedMessageUpdate(
  draftMap: Map<number, InboxMessage>,
  messages: Array<[number, InboxMessage]>,
  messageId: number,
  updater: (message: InboxMessage) => InboxMessage,
): { currentMessage: InboxMessage | null; nextMessage: InboxMessage | null } {
  const currentMessage = draftMap.get(messageId) ?? messages.find(([id]) => id === messageId)?.[1] ?? null;
  if (isNullOrUndefined(currentMessage)) return { currentMessage: null, nextMessage: null };
  const nextMessage = updater(currentMessage);
  if (nextMessage !== currentMessage) {
    draftMap.set(messageId, nextMessage);
  }
  return { currentMessage, nextMessage };
}

export function enqueueMessageSave<T>(
  queue: Map<number, Promise<void>>,
  messageId: number,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queue.get(messageId) ?? Promise.resolve();
  const current = previous.then(() => task());
  queue.set(messageId, current.then(() => undefined, () => undefined));
  return current;
}

export function useAnalysisMessageEditor({
  messages,
  onError,
  onUnauthorized,
  onUpdateLocalMessage,
}: Props): Result {
  const [editorMessage, setEditorMessage] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [editorSaveInFlight, setEditorSaveInFlight] = useState(false);
  const messagesRef = useRef(messages);
  const messageDraftsRef = useRef(buildMessageDraftMap(messages));
  const saveQueueRef = useRef(new Map<number, Promise<void>>());

  useEffect(() => {
    messagesRef.current = messages;
    messageDraftsRef.current = buildMessageDraftMap(messages);
  }, [messages]);

  const openEditor = useCallback(
    (messageId: number) => {
      const entry = messages.find(([id]) => id === messageId) ?? null;
      if (isNullOrUndefined(entry)) return;
      setEditorMessage({ id: entry[0], message: entry[1] });
    },
    [messages],
  );

  const closeEditor = useCallback(() => {
    setEditorMessage(null);
  }, []);

  const saveMessageUpdate = useCallback(
    async (messageId: number, updater: (message: InboxMessage) => InboxMessage) => {
      return enqueueMessageSave(saveQueueRef.current, messageId, async () => {
        const { currentMessage, nextMessage } = prepareQueuedMessageUpdate(
          messageDraftsRef.current,
          messagesRef.current,
          messageId,
          updater,
        );
        if (isNullOrUndefined(currentMessage) || isNullOrUndefined(nextMessage)) return false;
        if (nextMessage === currentMessage) return true;

        onError('');
        try {
          await submitAnalysisInboxMessages({ messages: [[messageId, nextMessage]] });
          onUpdateLocalMessage(messageId, () => nextMessage);
          return true;
        } catch (error) {
          messageDraftsRef.current.set(messageId, currentMessage);
          if (!onUnauthorized(error)) {
            onError(toErrorMessage(error));
          }
          return false;
        }
      });
    },
    [onError, onUnauthorized, onUpdateLocalMessage],
  );

  const saveEditor = useCallback(
    async (message: InboxMessage) => {
      if (isNullOrUndefined(editorMessage)) return;
      setEditorSaveInFlight(true);
      try {
        const saved = await saveMessageUpdate(editorMessage.id, () => message);
        if (saved) {
          setEditorMessage(null);
        }
      } finally {
        setEditorSaveInFlight(false);
      }
    },
    [editorMessage, saveMessageUpdate],
  );

  return {
    editorMessage,
    editorSaveInFlight,
    closeEditor,
    openEditor,
    saveEditor,
    saveMessageUpdate,
  };
}
