import { memo } from 'react';
import { isPresent } from '../../../utils/misc';
import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../../Bindings';
import { AnalysisMessageCard } from '../../shared/message-card/MessageCard';
import {
  resolveMessageCardEtalonDisplayModel,
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  buildMessageLinkFullUrl,
  type MessageCardEtalonDisplayModel,
} from '../../shared/message-card/message-card.utils';
import { buildMessageCardDisplayLabels } from '../../shared/message-card/message-card-labels';
import { copyMessageValue } from '../message-utils';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import type { AddPointHighlightBlacklistRequest } from '../../shared/message-card/point-highlight-blacklist';
import { DEFAULT_MEDIA_SUMMARY_ENABLED } from '../../../hooks/duty-settings-defaults';

export type BotTagAction = { messageId: number; tagId: number };

function filterOtherMessageComments(
  currentUserLogin: string | null,
  comments: MessageComment[],
): MessageComment[] {
  const normalizedCurrentUserLogin = currentUserLogin?.trim() ?? '';
  return comments.filter((comment) => {
    const commentLogin = comment.login.trim();
    // Analysis shows peer/post comments under the card; the current user's own
    // comment is already rendered and edited through `msg.extendedForm`.
    return commentLogin !== '' && commentLogin !== normalizedCurrentUserLogin;
  });
}
type AnalysisMessageCardItemProps = {
  unreadBoundary?: boolean;
  authUserName: string | null;
  currentUserLogin: string | null;
  copiedFeedbackId: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  hideGroupName?: boolean;
  id: number;
  message: InboxMessage;
  messageComments: MessageComment[];
  networkDisplayMap: Record<number, string>;
  botTagAction?: BotTagAction | null;
  onCreateReport: (
    id: number,
    etalonDisplayModel: MessageCardEtalonDisplayModel,
    focusTarget: HTMLElement,
  ) => void;
  onEditReport: (reportId: number, sourceMessageId?: number) => void | Promise<void>;
  onCopyFeedback: (value: string) => void;
  onDeleteOpen: (messageId: number) => void;
  onOpenPointsOnMap: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number, focusTarget?: HTMLElement) => void;
  onSaveMessageUpdate: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => Promise<boolean>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  referenceTimeMs: number | null;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  tagsLoading: boolean;
  tagsLayout: TagsLayoutVariant;
  hideBotTags: boolean;
  hideNetworks: boolean;
  messageTimeBasis?: MessageTimeBasis;
  mediaSummaryEnabled?: boolean;
  collapseMediaPreviews: boolean;
  messageTextPreviewLines: 20 | 40 | null;
  showCallsignAddForm: boolean;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
};

export const AnalysisMessageCardItem = memo(function AnalysisMessageCardItem({
  unreadBoundary,
  authUserName,
  currentUserLogin,
  copiedFeedbackId,
  botTagAction,
  groupInfos,
  hideGroupName = false,
  id,
  message,
  messageComments,
  networkDisplayMap,
  onCreateReport,
  onEditReport,
  onCopyFeedback,
  onDeleteOpen,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  onOpenEditor,
  onSaveMessageUpdate,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  profiles,
  referenceTimeMs,
  tagsMap,
  tagsOrder,
  tagsLoading,
  tagsLayout,
  hideBotTags,
  hideNetworks,
  messageTimeBasis,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  collapseMediaPreviews,
  messageTextPreviewLines,
  showCallsignAddForm,
  searchText,
  callsignInfoMap,
  networks,
  unitsMap,
}: AnalysisMessageCardItemProps) {
  const normalizeCallsign = (value: string) => value.trim().toUpperCase();
  const saveCallsignPatch = (updater: (message: InboxMessage) => InboxMessage) => {
    return onSaveMessageUpdate(id, updater);
  };
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(message, {
    networkDisplayMap,
    networks,
  });
  const labels = buildMessageCardDisplayLabels(message, { groupInfos, profiles });
  const visibleMessageComments = filterOtherMessageComments(currentUserLogin, messageComments);

  return (
    <AnalysisMessageCard
      unreadBoundary={unreadBoundary}
      id={id}
      msg={message}
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      groupName={labels.groupName}
      hideGroupName={hideGroupName}
      reportGroupInfos={groupInfos}
      senderName={labels.senderName}
      copiedFeedbackId={copiedFeedbackId}
      messageComments={visibleMessageComments}
      networkDisplayMap={networkDisplayMap}
      tagsMap={tagsMap}
      tagsOrder={tagsOrder}
      tagsLoading={tagsLoading}
      tagsLayout={tagsLayout}
      hideBotTags={hideBotTags}
      hideNetworks={hideNetworks}
      messageTimeBasis={messageTimeBasis}
      collapseMediaPreviews={collapseMediaPreviews}
      messageTextPreviewLines={messageTextPreviewLines}
      searchText={searchText}
      onOpenPointsOnMap={onOpenPointsOnMap}
      onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
      callsignInfoMap={callsignInfoMap}
      networks={networks}
      unitsMap={unitsMap}
      onBookmark={() => onToggleMessageBookmark(id, message.bookmarked)}
      onImportant={() => onToggleMessageImportant(id, message.important)}
      onCopyText={() => {
        void copyMessageValue(message.text).then(() => {
          onCopyFeedback(`text-${id}`);
        });
      }}
      onCopyFreq={() => {
        void copyMessageValue(message.freq).then(() => {
          onCopyFeedback(`freq-${id}`);
        });
      }}
      onCopyMessageLink={() => {
        void copyMessageValue(buildMessageLinkFullUrl(message, 'analysis', id)).then(() => {
          onCopyFeedback(`link-${id}`);
        });
      }}
      onCopyTextWithNetwork={
        etalonDisplayModel.primaryKind === 'network' && etalonDisplayModel.copyEtalonValue != null
          ? () => {
              void copyMessageValue(
                buildCopyTextWithNetworkName(
                  message.text,
                  etalonDisplayModel.copyEtalonValue,
                  message.noHeadersBody,
                ),
              ).then(() => {
                onCopyFeedback(`text-network-${id}`);
              });
            }
          : undefined
      }
      onCopyTextWithNetworkAndNote={
        etalonDisplayModel.primaryKind === 'network' &&
        etalonDisplayModel.copyEtalonValue != null &&
        isPresent(message.extendedForm) &&
        message.extendedForm.trim() !== ''
          ? () => {
              void copyMessageValue(
                buildCopyTextWithNetworkAndNote(
                  message.text,
                  etalonDisplayModel.copyEtalonValue,
                  message.extendedForm,
                  message.noHeadersBody,
                ),
              ).then(() => {
                onCopyFeedback(`text-network-note-${id}`);
              });
            }
          : undefined
      }
      onCopyEtalon={(value) => {
        void copyMessageValue(value).then(() => {
          onCopyFeedback(`etalon-${id}`);
        });
      }}
      onCopyLocation={(value) => {
        void copyMessageValue(value).then(() => {
          onCopyFeedback(`location-${id}`);
        });
      }}
      onCreateReport={(visibleEtalonDisplayModel, focusTarget) =>
        onCreateReport(id, visibleEtalonDisplayModel, focusTarget)
      }
      onEditReport={(reportId) => onEditReport(reportId, id)}
      onDelete={() => onDeleteOpen(id)}
      onEditDetails={(focusTarget) => onOpenEditor(id, focusTarget)}
      onToggleTag={(tagId) => onToggleMessageTag(id, tagId)}
      botTagAction={botTagAction?.messageId === id ? botTagAction : null}
      onCancelBotTagAction={onCancelBotTagAction}
      onMarkBotTagWrong={onMarkBotTagWrong}
      analysisCallsignActions={{
        onAddCallsign: async (callsign) => {
          return saveCallsignPatch((current) => {
            const currentCallsigns = current.callsigns ?? [];
            const nextCallsign = normalizeCallsign(callsign);
            if (currentCallsigns.some((item) => normalizeCallsign(item) === nextCallsign))
              return current;
            return { ...current, callsigns: [...currentCallsigns, nextCallsign] };
          });
        },
        onRemoveCallsign: async (callsign) => {
          return saveCallsignPatch((current) => ({
            ...current,
            callsigns: (current.callsigns ?? []).filter(
              (item) => normalizeCallsign(item) !== normalizeCallsign(callsign),
            ),
          }));
        },
      }}
      showCallsignAddForm={showCallsignAddForm}
      mediaSummaryEnabled={mediaSummaryEnabled}
    />
  );
});
