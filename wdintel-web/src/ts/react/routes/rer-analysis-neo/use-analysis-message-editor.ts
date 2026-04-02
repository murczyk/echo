import type { InboxMessage } from '../../../../Bindings';
import { useCallback, useState } from 'react';

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
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час збереження повідомлення.';
}

export function useAnalysisMessageEditor({
  messages,
  onError,
  onUnauthorized,
  onUpdateLocalMessage,
}: Props): Result {
  const [editorMessage, setEditorMessage] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [editorSaveInFlight, setEditorSaveInFlight] = useState(false);

  const openEditor = useCallback(
    (messageId: number) => {
      const entry = messages.find(([id]) => id === messageId) ?? null;
      if (entry == null) return;
      setEditorMessage({ id: entry[0], message: entry[1] });
    },
    [messages],
  );

  const closeEditor = useCallback(() => {
    setEditorMessage(null);
  }, []);

  const saveEditor = useCallback(async (message: InboxMessage) => {
    if (editorMessage == null) return;
    setEditorSaveInFlight(true);
    onError('');
    try {
      await submitAnalysisInboxMessages({ messages: [[editorMessage.id, message]] });
      onUpdateLocalMessage(editorMessage.id, () => message);
      setEditorMessage(null);
    } catch (error) {
      if (!onUnauthorized(error)) {
        onError(toErrorMessage(error));
      }
    } finally {
      setEditorSaveInFlight(false);
    }
  }, [editorMessage, onError, onUnauthorized, onUpdateLocalMessage]);

  return {
    editorMessage,
    editorSaveInFlight,
    closeEditor,
    openEditor,
    saveEditor,
  };
}
