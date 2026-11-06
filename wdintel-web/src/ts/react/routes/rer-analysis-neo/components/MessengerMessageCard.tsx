import LinkIcon from '@mui/icons-material/Link';
import { Tooltip } from '@mui/material';
import { memo, useMemo } from 'react';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { missingAttachmentNotice } from '../messenger-message-ui';
import { formatDateTime24 } from '../../../utils/misc';
import { renderLinkifiedText } from '../../shared/message-card/message-card-linkify';
import { MessageFeedItem } from '../../shared/message-feed';
import { MessengerMessageAttachments } from './MessengerMessageAttachments';

type Props = {
  message: MessengersMessageItem;
  senderName: string | null;
  showSenderName: boolean;
  // The sender's name added in front of this message when a selection of a private chat is copied.
  copyPrefix: string | null;
  onCopyLink: (messageId: string) => void;
};

const BUBBLE_COLORS = {
  incoming: 'bg-black/5 dark:bg-white/10',
  outgoing: 'bg-[color-mix(in_srgb,var(--color-primary,#3b82f6)_18%,transparent)]',
};

// A bubble of the analysis messenger chat: sender name, text, attachments and a footer with the time and the link button.
// Takes primitives only, so `memo` can skip bubbles that did not change when the feed re-renders.
function MessengerMessageCardBase({
  message,
  senderName,
  showSenderName,
  copyPrefix,
  onCopyLink,
}: Props) {
  // Links open in a new tab, `www.` addresses too. An empty origin keeps echo's own message links
  // as plain links: an analysis messenger text is not an echo message reference.
  const text = useMemo(
    () => renderLinkifiedText(message.text, { linkWww: true, currentOrigin: '' }),
    [message.text],
  );
  const outgoing = message.isOutgoing === true;
  // Media that was announced but is not there: still arriving for a fresh message, gone for an old one.
  const attachmentNotice =
    message.hasMedia === true && message.attachments.length === 0
      ? missingAttachmentNotice(message.sentAt)
      : null;
  return (
    <MessageFeedItem id={message.id} data-message-id={message.id}>
      <div
        className={`flex px-4 py-1 ${outgoing ? 'justify-end' : 'justify-start'}`}
        data-message-card-root
        data-messenger-message
        data-messenger-outgoing={outgoing ? 'true' : undefined}
      >
        <div
          className={`flex max-w-[80%] min-w-0 flex-col gap-1 rounded-lg px-3 py-2 ${
            outgoing ? BUBBLE_COLORS.outgoing : BUBBLE_COLORS.incoming
          }`}
        >
          {showSenderName && senderName ? (
            <div className="text-xs font-medium opacity-70" data-messenger-sender>
              {senderName}
            </div>
          ) : null}
          <div
            className="text-sm break-words whitespace-pre-wrap"
            data-messenger-copy-text
            data-copy-sender={copyPrefix ?? undefined}
          >
            {text}
            {attachmentNotice != null ? <div>{attachmentNotice}</div> : null}
          </div>
          {message.attachments.length > 0 ? (
            <MessengerMessageAttachments attachments={message.attachments} />
          ) : null}
          <div className="flex items-center justify-end gap-1 text-xs opacity-80">
            <Tooltip title="Копіювати посилання на повідомлення">
              <button
                type="button"
                className="-my-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-echo-pill text-echo-text-muted hover:bg-echo-hover hover:text-echo-text focus-visible:outline-2 focus-visible:outline-echo-focus"
                aria-label="Копіювати посилання на повідомлення"
                data-messenger-copy-link
                onClick={() => onCopyLink(message.id)}
              >
                <LinkIcon fontSize="small" />
              </button>
            </Tooltip>
            <span>{formatDateTime24(message.sentAt)}</span>
          </div>
        </div>
      </div>
    </MessageFeedItem>
  );
}

export const MessengerMessageCard = memo(MessengerMessageCardBase);
