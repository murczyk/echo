import type { InboxMessage } from '../../../../Bindings';
import React from 'react';

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
  saveEditor: () => Promise<void>;
  updateEditorField: <K extends keyof InboxMessage>(field: K, value: InboxMessage[K]) => void;
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
  const [editorMessage, setEditorMessage] = React.useState<{ id: number; message: InboxMessage } | null>(null);
  const [editorSaveInFlight, setEditorSaveInFlight] = React.useState(false);

  const openEditor = React.useCallback(
    (messageId: number) => {
      const entry = messages.find(([id]) => id === messageId) ?? null;
      if (entry == null) return;
      setEditorMessage({ id: entry[0], message: entry[1] });
    },
    [messages],
  );

  const closeEditor = React.useCallback(() => {
    setEditorMessage(null);
  }, []);

  const updateEditorField = React.useCallback(<K extends keyof InboxMessage>(field: K, value: InboxMessage[K]) => {
    setEditorMessage((current) => (current == null ? current : { ...current, message: { ...current.message, [field]: value } }));
  }, []);

  const saveEditor = React.useCallback(async () => {
    if (editorMessage == null) return;
    setEditorSaveInFlight(true);
    onError('');
    try {
      await submitAnalysisInboxMessages({ messages: [[editorMessage.id, editorMessage.message]] });
      onUpdateLocalMessage(editorMessage.id, () => editorMessage.message);
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
    updateEditorField,
  };
}
