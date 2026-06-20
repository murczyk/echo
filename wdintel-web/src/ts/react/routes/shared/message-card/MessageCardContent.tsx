import type { CallsignInfoRes, InboxMessage, MessageComment, Network, Tag, Unit } from '../../../../../Bindings';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import { isPresent } from '../../../utils/misc';
import { getPointEtalonsFromMessage, messageHasPalitraTag, type TagsLayoutVariant } from '../../rer-duty-neo/utils';
import { renderMarkedText } from './MarkedText';
import { MessageCardBotTagPrompt } from './MessageCardBotTagPrompt';
import { MessageCardComments } from './MessageCardComments';
import { MessageCardCallsignsSection } from './MessageCardCallsignsSection';
import {
  collectMessageImageHrefs,
  isAudioMediaAttachment,
  mediaAttachmentContentType,
  MessageMediaAudioPlayer,
  MessageMediaDownloadLink,
  MessagePictureThumb,
} from './MessageCardMedia';
import { MessageCardTags } from './MessageCardTags';
import type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';

export type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';

export function MessageCardMessageBody({
  compact = false,
  msg,
  tagsMap,
  tagsLoading = false,
  onToggleTag,
  tagsLayout = 'full',
  botTagAction = null,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  analysisCallsignActions,
  callsignInfoMap,
  networks,
  unitsMap,
  messageComments = [],
  searchText,
}: {
  compact?: boolean;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  tagsLoading?: boolean;
  onToggleTag: (tagId: number) => void;
  tagsLayout?: TagsLayoutVariant;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  analysisCallsignActions?: AnalysisCallsignActions;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  messageComments?: MessageComment[];
  searchText?: string | null;
}) {
  const imageHrefs = collectMessageImageHrefs(msg);
  const imageHrefSet = new Set(imageHrefs);
  const attachmentMedia = (msg.media ?? []).filter((attachment) => {
    const href = String(attachment.href ?? '');
    if (imageHrefSet.has(href)) return false;
    const contentType = mediaAttachmentContentType(attachment);
    if (contentType.startsWith('image/')) return false;
    if (contentType !== '') return true;
    return !/\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(href);
  });
  const audioAttachments = attachmentMedia.filter(isAudioMediaAttachment);
  const downloadAttachments = attachmentMedia.filter((attachment) => !isAudioMediaAttachment(attachment));

  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const hasTags = tagsLayout !== 'hidden' && Object.keys(tagsMap).length > 0;
  const textPrimary = useMemoText(msg, tagsMap, showPointLinks, callsignInfoMap, networks, unitsMap, searchText);
  const hasTextPrimary = Array.isArray(textPrimary) ? textPrimary.some((node) => isPresent(node)) : isPresent(textPrimary);

  return (
    <Stack spacing={compact ? 1.5 : 1.25} sx={{ minWidth: 0 }}>
      {imageHrefs.length > 0 ? (
        <Box className="m-1" sx={{ lineHeight: 0 }}>
          {imageHrefs.map((href) => (
            <MessagePictureThumb key={href} href={href} />
          ))}
        </Box>
      ) : null}
      {audioAttachments.length > 0 || downloadAttachments.length > 0 ? (
        <Box className="mt-1" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%' }}>
          {audioAttachments.map((attachment) => (
            <MessageMediaAudioPlayer key={attachment.id} attachment={attachment} />
          ))}
          {downloadAttachments.map((attachment) => (
            <MessageMediaDownloadLink key={attachment.id} attachment={attachment} />
          ))}
        </Box>
      ) : null}
      {hasTextPrimary ? (
        <Box component="div" className={msg.textMarked && msg.textMarked.length > 0 ? 'text-marked' : undefined} sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.35 }}>
          {textPrimary}
        </Box>
      ) : null}
      {isPresent(msg.extendedForm) && msg.extendedForm.trim() !== '' ? (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <ChatBubbleOutlineOutlinedIcon sx={{ fontSize: 13, color: 'var(--color-action)', flexShrink: 0 }} titleAccess="Коментар" />
          <Typography variant="caption" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {msg.extendedForm}
          </Typography>
        </Stack>
      ) : null}
      {messageComments.length > 0 ? <MessageCardComments messageComments={messageComments} /> : null}
      {tagsLoading ? (
        <Box sx={{ pt: 0.25, minHeight: 34, display: 'flex', alignItems: 'center' }} aria-label="Завантаження тегів">
          <CircularProgress size={14} />
        </Box>
      ) : hasTags ? (
        <Box sx={{ pt: 0.25, minWidth: 0 }}>
          <span className="inline-flex flex-wrap gap-1 min-w-0 w-full">
            <MessageCardTags msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} tagsLayout={tagsLayout} />
          </span>
        </Box>
      ) : null}
      {botTagAction != null && onMarkBotTagWrong != null && onCancelBotTagAction != null ? (
        <MessageCardBotTagPrompt botTagAction={botTagAction} onCancelBotTagAction={onCancelBotTagAction} onMarkBotTagWrong={onMarkBotTagWrong} />
      ) : null}
      {isPresent(analysisCallsignActions) ? (
        <MessageCardCallsignsSection msg={msg} actions={analysisCallsignActions} callsignInfoMap={callsignInfoMap} />
      ) : null}
    </Stack>
  );
}

function useMemoText(
  msg: InboxMessage,
  tagsMap: Record<number, Tag>,
  showPointLinks: boolean,
  callsignInfoMap?: Record<string, CallsignInfoRes>,
  networks?: Network[],
  unitsMap?: Record<number, Unit>,
  searchText?: string | null,
) {
  return msg.textMarked && msg.textMarked.length > 0
    ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
        showPointLinks,
        message: msg,
        callsignInfoMap,
        networks,
        unitsMap,
        freq: msg.freq ?? null,
        networkIds: msg.networkIds ?? null,
        searchText,
      })
    : (() => {
        const text = msg.text?.trim() ?? '';
        if (text === '' || text === '—' || text === '-') return null;
        return msg.text;
      })();
}

export const MessageCardContent = MessageCardMessageBody;
