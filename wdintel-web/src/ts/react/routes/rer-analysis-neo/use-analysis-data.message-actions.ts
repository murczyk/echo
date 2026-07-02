import { useCallback, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import type { InboxMessage, InboxMessageTag, SummaryTableFreqRow } from '../../../../Bindings';
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
import type { AnalysisQueryState } from './types';

export type AnalysisBotTagAction = {
  messageId: number;
  tagId: number;
};

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
  reload: () => Promise<void>;
  setMapOpenMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setSummaryRows: React.Dispatch<React.SetStateAction<SummaryTableFreqRow[]>>;
  toErrorMessage: (error: unknown) => string;
};

function getInboxTags(message: InboxMessage): InboxMessageTag[] {
  return message.inboxTags ?? [];
}

function hasUserTag(message: InboxMessage, tagId: number, login: string | null): boolean {
  if (isNullOrUndefined(login) || login.trim() === '') return false;
  return getInboxTags(message).some(
    (tag) => tag.tagId === tagId && tag.model == null && tag.login === login,
  );
}

function hasBotTag(message: InboxMessage, tagId: number): boolean {
  return getInboxTags(message).some((tag) => tag.tagId === tagId && tag.model != null);
}

function tagIdsWithFallback(
  inboxTags: InboxMessageTag[],
  fallbackTags: number[] | null | undefined,
): number[] {
  const next: number[] = [];
  for (const tag of inboxTags) {
    if (!next.includes(tag.tagId)) next.push(tag.tagId);
  }
  for (const tagId of fallbackTags ?? []) {
    if (!next.includes(tagId)) next.push(tagId);
  }
  return next;
}

function tagIdsWithoutTagId(
  inboxTags: InboxMessageTag[],
  fallbackTags: number[] | null | undefined,
  tagId: number,
): number[] {
  const next: number[] = [];
  for (const tag of inboxTags) {
    if (tag.tagId !== tagId && !next.includes(tag.tagId)) next.push(tag.tagId);
  }
  for (const fallbackTagId of fallbackTags ?? []) {
    if (fallbackTagId !== tagId && !next.includes(fallbackTagId)) next.push(fallbackTagId);
  }
  return next;
}

function toggleHumanTag(
  message: InboxMessage,
  tagId: number,
  login: string | null,
  organismId: number | null,
): InboxMessage {
  const currentTags = getInboxTags(message);
  const remainingTags =
    login == null
      ? currentTags
      : currentTags.filter(
          (tag) => !(tag.tagId === tagId && tag.model == null && tag.login === login),
        );
  const hasRemoved = remainingTags.length !== currentTags.length;
  const added =
    login != null && !hasRemoved
      ? [
          {
            id: 0,
            tagId,
            confidence: 1,
            login,
            model: null,
            organismId,
          },
        ]
      : [];
  const inboxTags = [...added, ...remainingTags];
  const hasRemainingTag = inboxTags.some((tag) => tag.tagId === tagId);
  return {
    ...message,
    inboxTags,
    tags: hasRemainingTag
      ? tagIdsWithFallback(inboxTags, message.tags ?? [])
      : tagIdsWithoutTagId(inboxTags, message.tags ?? [], tagId),
  };
}

function removeBotTags(message: InboxMessage, tagId: number): InboxMessage {
  const inboxTags = getInboxTags(message).filter(
    (tag) => !(tag.tagId === tagId && tag.model != null),
  );
  return {
    ...message,
    inboxTags,
    tags: tagIdsWithoutTagId(inboxTags, message.tags ?? [], tagId),
  };
}

export function useAnalysisDataMessageActions(params: Params) {
  const [messageActionCount, setMessageActionCount] = useState(0);
  const [botTagAction, setBotTagAction] = useState<AnalysisBotTagAction | null>(null);

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
        if (userHasTag) {
          await inboxMessageTagsRm({ messageId, tagId });
        } else {
          await inboxMessageTagsAdd({ messageId, tagId });
        }

        params.patchMessages((id, message) => {
          if (id !== messageId) return message;
          return toggleHumanTag(message, tagId, currentUserName, currentUserOrganismId);
        });
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) {
          params.patchMessages((id, message) => (id === messageId ? sourceMessage : message));
          params.onError(params.toErrorMessage(loadError));
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
