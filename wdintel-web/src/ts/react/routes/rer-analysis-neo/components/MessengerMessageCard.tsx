import LinkIcon from '@mui/icons-material/Link';
import MessageIcon from '@mui/icons-material/Message';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Menu, MenuItem } from '@mui/material';
import { memo, useMemo, useState } from 'react';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { missingAttachmentNotice } from '../messenger-message-ui';
import { ELLIPSIS, formatDateTime24 } from '../../../utils/misc';
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
  onCopyText: (text: string) => void;
};

const COPY_TITLE = `Копіювати${ELLIPSIS}`;

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
  onCopyText,
}: Props) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => setMenuAnchor(null);
  const runAndClose = (action: () => void) => () => {
    closeMenu();
    action();
  };
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
        className={`flex px-4 py-1 group-data-[mobile=true]/messenger:!px-1.5 group-data-[mobile=true]/messenger:!py-0.5 ${outgoing ? 'justify-end' : 'justify-start'}`}
        data-message-card-root
        data-messenger-message
        data-messenger-outgoing={outgoing ? 'true' : undefined}
      >
        <div
          className={`max-w-[80%] flow-root min-w-0 rounded-lg px-3 py-2 group-data-[mobile=true]/messenger:max-w-[92%] group-data-[mobile=true]/messenger:!px-2 group-data-[mobile=true]/messenger:!py-1 ${
            outgoing ? BUBBLE_COLORS.outgoing : BUBBLE_COLORS.incoming
          }`}
        >
          <div className="message-card-action-group float-right mb-1 ml-2">
            <button
              type="button"
              className="message-card-action-btn"
              title={COPY_TITLE}
              aria-label={COPY_TITLE}
              aria-haspopup="menu"
              aria-expanded={menuAnchor != null ? 'true' : undefined}
              data-messenger-menu
              onClick={(event) => setMenuAnchor(event.currentTarget)}
            >
              <ContentCopyOutlinedIcon className="message-card-action-btn__icon" />
            </button>
          </div>
          <div className="[&>*+*]:mt-1">
            {showSenderName && senderName ? (
              // A float is not counted in the width of the bubble, so a name as wide as the bubble would wrap beside the
              // button. The padding is the width of the button and its margin (30 + 8 px): it makes the bubble that much
              // wider than the name, and the button floats over the padding, so the name still fits on its line.
              <div
                className="pr-[38px] text-xs font-medium break-words opacity-70"
                data-messenger-sender
              >
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
              <div className="clear-both">
                <MessengerMessageAttachments attachments={message.attachments} />
              </div>
            ) : null}
            <div className="text-right text-xs opacity-80">{formatDateTime24(message.sentAt)}</div>
          </div>
          <Menu anchorEl={menuAnchor} open={menuAnchor != null} onClose={closeMenu}>
            <MenuItem
              data-messenger-copy-text-action
              onClick={runAndClose(() => onCopyText(message.text))}
            >
              <span className="message-card-header-menu-row">
                <MessageIcon fontSize="small" />
                <span className="message-card-header-menu-row__label">Копіювати повідомлення</span>
              </span>
            </MenuItem>
            <MenuItem data-messenger-copy-link onClick={runAndClose(() => onCopyLink(message.id))}>
              <span className="message-card-header-menu-row">
                <LinkIcon fontSize="small" />
                <span className="message-card-header-menu-row__label">
                  Копіювати посилання на повідомлення
                </span>
              </span>
            </MenuItem>
          </Menu>
        </div>
      </div>
    </MessageFeedItem>
  );
}

export const MessengerMessageCard = memo(MessengerMessageCardBase);
