import type { InboxMessage } from '../../../../Bindings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import { submitAnalysisInboxMessages } from '../../services/api/analysis';
import { fetchMessagesByIds } from '../../services/api/inbox-messages';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import { isIntelligenceReport } from '../shared/intelligence-reports';
import { isAbortError } from '../../services/api/client';
import type { ReportEditLoadState } from '../shared/manage-message/useManageMessageDrawer';

type Props = {
  messages: Array<[number, InboxMessage]>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  onUpdateLocalMessage: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => void;
};

type Result = {
  editorMessage: { id: number; message: InboxMessage } | null;
  editorEditAsReport: boolean;
  reportSource: { id: number; message: InboxMessage } | null;
  editTargetLoadState: ReportEditLoadState;
  editorSaveInFlight: boolean;
  closeEditor: () => void;
  openEditor: (messageId: number) => void;
  openReportCreator: (messageId: number) => void;
  openReportEditor: (messageId: number) => void;
  retryEditTargetLoad: () => void;
  saveEditor: (message: InboxMessage) => Promise<void>;
  saveMessageUpdate: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => Promise<boolean>;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час збереження повідомлення.';
}

export function buildMessageDraftMap(
  messages: Array<[number, InboxMessage]>,
): Map<number, InboxMessage> {
  return new Map(messages);
}

export function prepareQueuedMessageUpdate(
  draftMap: Map<number, InboxMessage>,
  messages: Array<[number, InboxMessage]>,
  messageId: number,
  updater: (message: InboxMessage) => InboxMessage,
): { currentMessage: InboxMessage | null; nextMessage: InboxMessage | null } {
  const currentMessage =
    draftMap.get(messageId) ?? messages.find(([id]) => id === messageId)?.[1] ?? null;
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
  queue.set(
    messageId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

export function useAnalysisMessageEditor({
  messages,
  onError,
  onUnauthorized,
  onUpdateLocalMessage,
}: Props): Result {
  const [editorMessage, setEditorMessage] = useState<{ id: number; message: InboxMessage } | null>(
    null,
  );
  const [editorEditAsReport, setEditorEditAsReport] = useState(false);
  const [editTargetLoadState, setEditTargetLoadState] = useState<ReportEditLoadState>({
    status: 'idle',
  });
  const [reportSource, setReportSource] = useState<{ id: number; message: InboxMessage } | null>(
    null,
  );
  const editorSaveInFlight = false;
  const messagesRef = useRef(messages);
  const messageDraftsRef = useRef(buildMessageDraftMap(messages));
  const saveQueueRef = useRef(new Map<number, Promise<void>>());
  const reportLoadControllerRef = useRef<AbortController | null>(null);
  const cancelReportEditLoad = useCallback(() => {
    reportLoadControllerRef.current?.abort();
    reportLoadControllerRef.current = null;
    setEditTargetLoadState({ status: 'idle' });
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    messageDraftsRef.current = buildMessageDraftMap(messages);
  }, [messages]);

  useInboxChangedMessageIds({
    onMessageIds: async (messageIds) => {
      const currentEditorMessage = editorMessage;
      if (
        isNullOrUndefined(currentEditorMessage) ||
        !messageIds.includes(currentEditorMessage.id)
      ) {
        return;
      }

      try {
        const [entry] = await fetchMessagesByIds([currentEditorMessage.id]);
        if (isNullOrUndefined(entry)) return;
        setEditorMessage((current) =>
          current?.id === entry[0] ? { id: entry[0], message: entry[1] } : current,
        );
      } catch (error) {
        if (!onUnauthorized(error)) onError(toErrorMessage(error));
      }
    },
  });

  const openEditor = useCallback(
    (messageId: number) => {
      const entry = messages.find(([id]) => id === messageId) ?? null;
      if (isNullOrUndefined(entry)) return;
      cancelReportEditLoad();
      setReportSource(null);
      setEditorEditAsReport(isIntelligenceReport(entry[1]));
      setEditorMessage({ id: entry[0], message: entry[1] });
    },
    [cancelReportEditLoad, messages],
  );

  const closeEditor = useCallback(() => {
    cancelReportEditLoad();
    setEditorMessage(null);
    setEditorEditAsReport(false);
    setReportSource(null);
  }, [cancelReportEditLoad]);

  useEffect(() => () => cancelReportEditLoad(), [cancelReportEditLoad]);

  const openReportCreator = useCallback(
    (messageId: number) => {
      const entry = messages.find(([id]) => id === messageId) ?? null;
      if (isNullOrUndefined(entry)) return;
      cancelReportEditLoad();
      setEditorMessage(null);
      setEditorEditAsReport(false);
      setReportSource({ id: entry[0], message: entry[1] });
    },
    [cancelReportEditLoad, messages],
  );

  const openReportEditor = useCallback(
    (messageId: number) => {
      cancelReportEditLoad();
      const controller = new AbortController();
      reportLoadControllerRef.current = controller;
      setReportSource(null);
      setEditorMessage(null);
      setEditorEditAsReport(true);
      setEditTargetLoadState({ status: 'loading', reportId: messageId });
      void fetchMessagesByIds([messageId], null, { signal: controller.signal })
        .then(([entry]) => {
          if (controller.signal.aborted || reportLoadControllerRef.current !== controller) return;
          if (isNullOrUndefined(entry)) throw new Error('Розвіддонесення не знайдено.');
          reportLoadControllerRef.current = null;
          setEditTargetLoadState({ status: 'idle' });
          setEditorMessage({ id: entry[0], message: entry[1] });
        })
        .catch((error) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (reportLoadControllerRef.current !== controller) return;
          reportLoadControllerRef.current = null;
          setEditTargetLoadState({
            status: 'error',
            reportId: messageId,
            message: toErrorMessage(error),
          });
        });
    },
    [cancelReportEditLoad],
  );

  const retryEditTargetLoad = useCallback(() => {
    if (editTargetLoadState.status !== 'idle') openReportEditor(editTargetLoadState.reportId);
  }, [editTargetLoadState, openReportEditor]);

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
      messageDraftsRef.current.set(editorMessage.id, message);
      onUpdateLocalMessage(editorMessage.id, () => message);
      setEditorMessage(null);
    },
    [editorMessage, onUpdateLocalMessage],
  );

  return {
    editorMessage,
    editorEditAsReport,
    reportSource,
    editTargetLoadState,
    editorSaveInFlight,
    closeEditor,
    openEditor,
    openReportCreator,
    openReportEditor,
    retryEditTargetLoad,
    saveEditor,
    saveMessageUpdate,
  };
}
