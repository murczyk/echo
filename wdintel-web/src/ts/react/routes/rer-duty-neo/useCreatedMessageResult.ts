import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { InboxMessage } from '../../../../Bindings';
import { fetchMessagesByIds } from '../../services/api/inbox-messages';

export type CreatedMessageResultState =
  | { kind: 'closed' }
  | { kind: 'message'; messageId: number; message: InboxMessage }
  | { kind: 'receipt'; messageId: number; warning: string };

type CreatedMessageResult = {
  signal_message_id: number;
  message?: InboxMessage;
};

export function useCreatedMessageResult() {
  const [createdMessageResult, setCreatedMessageResult] = useState<CreatedMessageResultState>({
    kind: 'closed',
  });
  const mountedRef = useRef(true);
  const operationIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationIdRef.current += 1;
    };
  }, []);

  const invalidatePendingOperations = useCallback(() => {
    operationIdRef.current += 1;
  }, []);

  const closeCreatedMessageResult = useCallback(() => {
    invalidatePendingOperations();
    setCreatedMessageResult({ kind: 'closed' });
  }, [invalidatePendingOperations]);

  const handleCreatedMessage = useCallback(async (result: CreatedMessageResult) => {
    const operationId = ++operationIdRef.current;
    const messageId = result.signal_message_id;
    const nextState = await resolveCreatedMessageResult(messageId, result.message);
    if (!isOperationCurrent(operationIdRef, operationId) || !mountedRef.current) return;

    scheduleNextFrame(operationIdRef, operationId, () => {
      if (mountedRef.current) {
        setCreatedMessageResult(nextState);
      }
    });
  }, []);

  return {
    createdMessageResult,
    closeCreatedMessageResult,
    handleCreatedMessage,
  };
}

async function resolveCreatedMessageResult(
  messageId: number,
  message: InboxMessage | undefined,
): Promise<CreatedMessageResultState> {
  if (message) {
    return { kind: 'message', messageId, message };
  }
  try {
    const fetched = await fetchMessagesByIds([messageId]);
    const fetchedMessage = fetched[0]?.[1] ?? null;
    if (fetchedMessage) {
      return { kind: 'message', messageId, message: fetchedMessage };
    }
  } catch {
    // Fall through to receipt state.
  }
  return {
    kind: 'receipt',
    messageId,
    warning: `Повідомлення №${messageId} створено, але попередній перегляд не вдалося завантажити.`,
  };
}

function isOperationCurrent(operationIdRef: MutableRefObject<number>, operationId: number) {
  return operationIdRef.current === operationId;
}

function scheduleNextFrame(
  operationIdRef: MutableRefObject<number>,
  operationId: number,
  callback: () => void,
) {
  const run = () => {
    if (!isOperationCurrent(operationIdRef, operationId)) return;
    callback();
  };
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => run());
    return;
  }
  setTimeout(run, 0);
}
