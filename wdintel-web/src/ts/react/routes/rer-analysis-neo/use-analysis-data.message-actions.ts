import { useCallback, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import type { InboxMessage, SummaryTableFreqRow } from '../../../../Bindings';
import {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  editAnalysisFreqUnitName,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
} from '../../services/api/analysis';
import { addPalitraHighlightBlacklistEntry } from '../../services/api/palitra';
import { buildAnalysisReq } from './helpers';
import type { User } from '../../../../Bindings';
import type { AnalysisQueryState, AnalysisReloadOptions } from './types';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import {
  hasBotTag,
  hasUserTag,
  removeBotTags,
  toggleHumanTag,
} from '../shared/message-card/message-card-tag-actions';
import {
  pointBlacklistLabelKey,
  removePointHighlightSourceFromMessage,
  type AddPointHighlightBlacklistRequest,
} from '../shared/message-card/point-highlight-blacklist';

type Params = {
  currentUser: User | null;
  authUserName: string | null;
  messages: Array<[number, InboxMessage]>;
  mapOpenMessages: Array<[number, InboxMessage]>;
  optionsFreqs: string[];
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  patchMessages: (updater: (messageId: number, message: InboxMessage) => InboxMessage) => void;
  queryState: AnalysisQueryState;
  completeLocalInboxChangeOrigin: (origin: string) => void;
  failLocalInboxChangeOrigin: (origin: string) => boolean;
  reconcileTagMutation: (messageId: number) => Promise<void>;
  registerLocalInboxChangeOrigin: () => string;
  refreshTagFacet: () => Promise<void>;
  reload: (options?: AnalysisReloadOptions) => Promise<void>;
  setMapOpenMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setSummaryRows: React.Dispatch<React.SetStateAction<SummaryTableFreqRow[]>>;
  toErrorMessage: (error: unknown) => string;
};

export function useAnalysisDataMessageActions(params: Params) {
  const [messageActionCount, setMessageActionCount] = useState(0);
  const [botTagAction, setBotTagAction] = useState<MessageCardBotTagAction | null>(null);
  const pointBlacklistRequestsRef = useRef<Map<string, Promise<void>>>(new Map());

  const onDeleteMessage = useCallback(
    async (messageId: number) => {
      setMessageActionCount((current) => current + 1);
      try {
        await deleteMessage({ id: messageId });
        params.setMessages((current) => current.filter(([id]) => id !== messageId));
        params.setMapOpenMessages((current) => current.filter(([id]) => id !== messageId));
        await params.reload();
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.onError(params.toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onAddPointHighlightBlacklist = useCallback(
    (request: AddPointHighlightBlacklistRequest) => {
      const key = `${request.messageId}:${pointBlacklistLabelKey(request.etalon)}:${request.palitraId}`;
      const existing = pointBlacklistRequestsRef.current.get(key);
      if (existing) return existing;

      let promise!: Promise<void>;
      promise = (async () => {
        try {
          await addPalitraHighlightBlacklistEntry(request.palitraId, request.etalon);
          params.patchMessages((_messageId, message) =>
            removePointHighlightSourceFromMessage(message, request),
          );
        } catch (error) {
          if (!params.onUnauthorized(error)) params.onError(params.toErrorMessage(error));
          throw error;
        } finally {
          if (pointBlacklistRequestsRef.current.get(key) === promise) {
            pointBlacklistRequestsRef.current.delete(key);
          }
        }
      })();
      pointBlacklistRequestsRef.current.set(key, promise);
      return promise;
    },
    [params],
  );

  const onToggleMessageBookmark = useCallback(
    async (messageId: number, currentlyBookmarked: boolean) => {
      setMessageActionCount((current) => current + 1);
      try {
        if (currentlyBookmarked) {
          await bookmarkRemove({ messageId });
        } else {
          await bookmarkAdd({ messageId });
        }

        params.patchMessages((id, message) =>
          id === messageId ? { ...message, bookmarked: !currentlyBookmarked } : message,
        );
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.onError(params.toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onToggleMessageImportant = useCallback(
    async (messageId: number, currentlyImportant: boolean) => {
      setMessageActionCount((current) => current + 1);
      try {
        if (currentlyImportant) {
          await importantRemove({ messageId });
        } else {
          await importantAdd({ messageId });
        }

        params.patchMessages((id, message) =>
          id === messageId ? { ...message, important: !currentlyImportant } : message,
        );
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.onError(params.toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onSaveMessageComment = useCallback(
    async (messageId: number, comment: string | null) => {
      setMessageActionCount((current) => current + 1);
      try {
        await commentSave({ messageId, comment });
        params.patchMessages((id, message) =>
          id === messageId ? { ...message, extendedForm: comment } : message,
        );
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.onError(params.toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onToggleMessageTag = useCallback(
    async (messageId: number, tagId: number) => {
      const sourceMessage =
        params.messages.find(([id]) => id === messageId)?.[1] ??
        params.mapOpenMessages.find(([id]) => id === messageId)?.[1] ??
        null;
      if (isNullOrUndefined(sourceMessage)) return;

      const currentUserName = params.currentUser?.name ?? params.authUserName ?? null;
      const currentUserOrganismId = params.currentUser?.organismId ?? null;
      const userHasTag = hasUserTag(sourceMessage, tagId, currentUserName);
      const botHasTag = hasBotTag(sourceMessage, tagId);
      const nextBotTagAction = userHasTag && botHasTag ? { messageId, tagId } : null;
      const eventOrigin = params.registerLocalInboxChangeOrigin();

      setMessageActionCount((current) => current + 1);
      setBotTagAction(nextBotTagAction);
      try {
        try {
          if (userHasTag) {
            await inboxMessageTagsRm({ messageId, tagId }, { eventOrigin });
          } else {
            await inboxMessageTagsAdd({ messageId, tagId }, { eventOrigin });
          }
        } catch (mutationError) {
          const eventReceived = params.failLocalInboxChangeOrigin(eventOrigin);
          const unauthorized = params.onUnauthorized(mutationError);
          if (!unauthorized) {
            params.onError(params.toErrorMessage(mutationError));
          }
          if (eventReceived) await params.reconcileTagMutation(messageId);
          return;
        }

        params.completeLocalInboxChangeOrigin(eventOrigin);
        params.patchMessages((id, message) => {
          if (id !== messageId) return message;
          return toggleHumanTag(message, tagId, currentUserName, currentUserOrganismId);
        });

        // Do not reload the inbox after a tag mutation. The Tags facet refreshes immediately when it
        // is already open; the paginated message list reconciles on the next explicit pagination,
        // filter, or page refresh action.
        await params.refreshTagFacet();
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onMarkBotTagWrong = useCallback(
    async (messageId: number, tagId: number) => {
      const eventOrigin = params.registerLocalInboxChangeOrigin();
      setMessageActionCount((current) => current + 1);
      try {
        try {
          await inboxMessageTagsModelError({ messageId, tagId }, { eventOrigin });
        } catch (mutationError) {
          const eventReceived = params.failLocalInboxChangeOrigin(eventOrigin);
          const unauthorized = params.onUnauthorized(mutationError);
          if (!unauthorized) {
            params.onError(params.toErrorMessage(mutationError));
          }
          if (eventReceived) await params.reconcileTagMutation(messageId);
          return;
        }

        params.completeLocalInboxChangeOrigin(eventOrigin);
        setBotTagAction(null);
        params.patchMessages((id, message) =>
          id === messageId ? removeBotTags(message, tagId) : message,
        );
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onCancelBotTagAction = useCallback(() => {
    setBotTagAction(null);
  }, []);

  const renameSummaryUnit = useCallback(
    async (freq: string, unit: string, unitNew: string) => {
      const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
      if (isNullOrUndefined(analysisReq)) {
        params.onError('Перевірте дату та час перед збереженням підрозділу.');
        return;
      }

      try {
        await editAnalysisFreqUnitName({
          analysisStatsReq: analysisReq,
          freq,
          unit,
          unitNew,
          search: params.queryState.search.trim() || null,
          filterTagsOption: params.queryState.filterTagsOption,
          reportTagsOnlyThisUnit: params.queryState.reportTagsOnlyThisUnit,
        });
        params.setSummaryRows((current) =>
          current.map((row) =>
            row.freq === freq
              ? {
                  ...row,
                  units: Array.from(
                    new Set(row.units.map((value) => (value === unit ? unitNew : value))),
                  ),
                }
              : row,
          ),
        );
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.onError(params.toErrorMessage(loadError));
        }
      }
    },
    [params],
  );

  return {
    botTagAction,
    messageActionCount,
    onCancelBotTagAction,
    onDeleteMessage,
    onMarkBotTagWrong,
    onSaveMessageComment,
    onToggleMessageBookmark,
    onToggleMessageImportant,
    onToggleMessageTag,
    renameSummaryUnit,
    onAddPointHighlightBlacklist,
  };
}
