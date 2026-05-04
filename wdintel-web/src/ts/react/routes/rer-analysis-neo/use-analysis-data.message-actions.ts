import { useCallback, useState } from 'react';

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
  inboxMessageTagsRm,
} from '../../services/api/analysis';
import { buildAnalysisReq } from './helpers';
import { getMessageTagEnabled } from './message-utils';
import type { AnalysisQueryState } from './types';

type Params = {
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

export function useAnalysisDataMessageActions(params: Params) {
  const [messageActionCount, setMessageActionCount] = useState(0);

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

        params.patchMessages((id, message) => (id === messageId ? { ...message, bookmarked: !currentlyBookmarked } : message));
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

        params.patchMessages((id, message) => (id === messageId ? { ...message, important: !currentlyImportant } : message));
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
        params.patchMessages((id, message) => (id === messageId ? { ...message, extendedForm: comment } : message));
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
      if ((sourceMessage === null || sourceMessage === undefined)) return;

      const enabled = getMessageTagEnabled(sourceMessage, tagId);

      setMessageActionCount((current) => current + 1);
      try {
        if (enabled) {
          await inboxMessageTagsRm({ messageId, tagId });
        } else {
          await inboxMessageTagsAdd({ messageId, tagId });
        }

        params.patchMessages((id, message) => {
          if (id !== messageId) return message;

          const currentTags = message.tags ?? [];
          const currentInboxTags = message.inboxTags ?? [];
          const nextTags = enabled ? currentTags.filter((value) => value !== tagId) : [...currentTags, tagId];
          const nextInboxTags: InboxMessageTag[] = enabled
            ? currentInboxTags.filter((tag) => tag.tagId !== tagId)
            : [...currentInboxTags, { id: 0, tagId, confidence: 1, login: null, model: null, organismId: null }];

          return {
            ...message,
            tags: nextTags,
            inboxTags: nextInboxTags,
          };
        });
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

  const renameSummaryUnit = useCallback(
    async (freq: string, unit: string, unitNew: string) => {
      const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
      if ((analysisReq === null || analysisReq === undefined)) {
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
              ? { ...row, units: Array.from(new Set(row.units.map((value) => (value === unit ? unitNew : value)))) }
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
    messageActionCount,
    onDeleteMessage,
    onToggleMessageBookmark,
    onToggleMessageImportant,
    onSaveMessageComment,
    onToggleMessageTag,
    renameSummaryUnit,
  };
}
