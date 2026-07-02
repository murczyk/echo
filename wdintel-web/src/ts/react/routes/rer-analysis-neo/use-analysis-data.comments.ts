import type { InboxMessage, MessageComment, User } from '../../../../Bindings';
import { fetchMessageComments } from '../../services/api/analysis';
import { fetchUserInfo } from '../../services/api/user';
import { toErrorMessage } from './use-analysis-data.shared';
import { isNullOrUndefined } from '../../utils/misc';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type LoadMessageCommentsParams = {
  authUserName: string | null;
  currentUser: User | null;
  messageComments: Record<number, MessageComment[]>;
  messageCommentsLoadVersionRef: React.MutableRefObject<number>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  setMessageComments: Setter<Record<number, MessageComment[]>>;
  setUsers: Setter<Record<string, User | null>>;
  users: Record<string, User | null>;
};

function normalizeLogin(login: string): string {
  return login.trim();
}

export function filterOtherMessageComments(
  authUserName: string | null,
  currentUser: User | null,
  users: Record<string, User | null>,
  comments: MessageComment[],
): MessageComment[] {
  return comments.filter((comment) => {
    const commentLogin = normalizeLogin(comment.login);
    if (commentLogin === '') return false;
    if (normalizeLogin(authUserName ?? '') === commentLogin) return false;
    if (normalizeLogin(currentUser?.name ?? '') === commentLogin) return false;

    const commentUser = users[commentLogin] ?? null;
    if (isNullOrUndefined(currentUser?.organismId) || isNullOrUndefined(commentUser?.organismId))
      return false;
    return currentUser.organismId !== commentUser.organismId;
  });
}

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

    const loginsToLoad = Array.from(
      new Set(
        (commentsRsp.data ?? [])
          .flatMap((entry) => entry.comments ?? [])
          .map((comment) => normalizeLogin(comment.login))
          .filter(
            (login) =>
              login !== '' &&
              normalizeLogin(params.authUserName ?? '') !== login &&
              normalizeLogin(params.currentUser?.name ?? '') !== login,
          )
          .filter((login) => !(login in params.users)),
      ),
    );

    if (loginsToLoad.length === 0) return;

    const nextUsers = await Promise.all(
      loginsToLoad.map(async (login) => {
        try {
          return { login, user: await fetchUserInfo(login) };
        } catch (loadError) {
          if (requestVersion !== params.messageCommentsLoadVersionRef.current) {
            return null;
          }
          if (params.onUnauthorized(loadError)) {
            return null;
          }
          params.onError(toErrorMessage(loadError));
          return { login, user: null };
        }
      }),
    );
    if (requestVersion !== params.messageCommentsLoadVersionRef.current) return;

    params.setUsers((current) => {
      const next = { ...current };
      for (const entry of nextUsers) {
        if (isNullOrUndefined(entry)) continue;
        next[entry.login] = entry.user;
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
