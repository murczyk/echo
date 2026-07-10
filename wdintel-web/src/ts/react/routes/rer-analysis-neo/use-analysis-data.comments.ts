import type { InboxMessage, MessageComment } from '../../../../Bindings';
import { fetchMessageComments } from '../../services/api/analysis';
import { toErrorMessage } from './use-analysis-data.shared';
import { isNullOrUndefined } from '../../utils/misc';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type LoadMessageCommentsParams = {
  messageComments: Record<number, MessageComment[]>;
  messageCommentsLoadVersionRef: React.MutableRefObject<number>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  setMessageComments: Setter<Record<number, MessageComment[]>>;
};

export async function loadMissingMessageCommentsForMessages(
  messages: Array<[number, InboxMessage]>,
  params: LoadMessageCommentsParams,
  forceReload = false,
): Promise<void> {
  const messageIds = Array.from(
    new Set(
      messages
        .map(([messageId]) => messageId)
        .filter(
          (messageId) =>
            Number.isInteger(messageId) &&
            (forceReload || isNullOrUndefined(params.messageComments[messageId])),
        ),
    ),
  );

  if (messageIds.length === 0) return;

  const requestVersion = params.messageCommentsLoadVersionRef.current;

  try {
    const commentsRsp = await fetchMessageComments({
      messages: messageIds.map((messageId) => ({ messageId })),
    });
    if (requestVersion !== params.messageCommentsLoadVersionRef.current) return;

    const commentsByMessageId = new Map<number, MessageComment[]>();
    for (const entry of commentsRsp.data ?? []) {
      commentsByMessageId.set(entry.messageId, entry.comments ?? []);
    }

    params.setMessageComments((current) => {
      const next = { ...current };
      for (const messageId of messageIds) {
        next[messageId] = commentsByMessageId.get(messageId) ?? [];
      }
      return next;
    });
  } catch (loadError) {
    if (requestVersion !== params.messageCommentsLoadVersionRef.current) return;
    if (!params.onUnauthorized(loadError)) {
      params.onError(toErrorMessage(loadError));
    }
  }
}
