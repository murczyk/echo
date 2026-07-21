import { useCallback, useState } from 'react';
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
  invalidateTagFacetLoad: () => void;
  reload: (options?: AnalysisReloadOptions) => Promise<void>;
  setMapOpenMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setSummaryRows: React.Dispatch<React.SetStateAction<SummaryTableFreqRow[]>>;
  toErrorMessage: (error: unknown) => string;
};

export function useAnalysisDataMessageActions(params: Params) {
  const [messageActionCount, setMessageActionCount] = useState(0);
  const [botTagAction, setBotTagAction] = useState<MessageCardBotTagAction | null>(null);

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

      setMessageActionCount((current) => current + 1);
      setBotTagAction(nextBotTagAction);
      try {
        try {
          if (userHasTag) {
            await inboxMessageTagsRm({ messageId, tagId });
          } else {
            await inboxMessageTagsAdd({ messageId, tagId });
          }
        } catch (mutationError) {
          if (!params.onUnauthorized(mutationError)) {
            params.patchMessages((id, message) => (id === messageId ? sourceMessage : message));
            params.onError(params.toErrorMessage(mutationError));
          }
          return;
        }

        params.patchMessages((id, message) => {
          if (id !== messageId) return message;
          return toggleHumanTag(message, tagId, currentUserName, currentUserOrganismId);
        });

        try {
          params.invalidateTagFacetLoad();
          // Keep the user's cursor and page after a tag mutation. A cursor cannot represent a
          // stable ordinal page once membership changes, so rebuilding/clamping it from counts
          // could move the user elsewhere (including page one). Canonical reflow needs
          // snapshot/offset pagination; this page intentionally favors stable position.
          await params.reload({ preserveMessagePage: true });
        } catch (reloadError) {
          // The tag mutation above already persisted, so the optimistic patch is now the
          // correct state — a reload failure must not roll it back. Report the error only.
          if (!params.onUnauthorized(reloadError)) {
            params.onError(params.toErrorMessage(reloadError));
          }
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [params],
  );

  const onMarkBotTagWrong = useCallback(
    async (messageId: number, tagId: number) => {
      setMessageActionCount((current) => current + 1);
      try {
        await inboxMessageTagsModelError({ messageId, tagId });
        setBotTagAction(null);
        params.patchMessages((id, message) =>
          id === messageId ? removeBotTags(message, tagId) : message,
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
  };
}
