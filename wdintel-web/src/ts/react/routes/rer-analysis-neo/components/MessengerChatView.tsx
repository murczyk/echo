import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Button, IconButton } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';

import type { MessengersChatReadState, MessengersMessageItem } from '../../../../../Bindings';
import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { formatCompactCount } from '../../../utils/format-compact-count';
import { PowerAlert } from '../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import {
  MessageFeed,
  type MessageFeedHandle,
  type MessageFeedPolicy,
} from '../../shared/message-feed';
import { buildMessengerChatLink, replaceMessengerChatQueryInUrl } from '../helpers';
import {
  buildPrivateChatCopyText,
  formatRelativeDateLabel,
  getSenderUiState,
  isPrivateChat,
} from '../messenger-message-ui';
import {
  findUnreadMarks,
  STOPPED_HERE_LABEL,
  UNREAD_ABOVE_LABEL,
  type ReadSpan,
} from '../messenger-unread';
import { senderName, useMessengerChat } from '../use-messenger-chat';
import { useMessengerReadTracking } from '../use-messenger-read-tracking';
import type { MessengerChat } from '../use-messenger-chats';
import type { MessengerAccountItem } from './MessengerAccountList';
import { MessengerMessageCard } from './MessengerMessageCard';

type Props = {
  account: MessengerAccountItem;
  chat: MessengerChat;
  title: string;
  // From the URL: the analysis messenger chat opens at this message instead of at its end.
  initialAnchorId: string | null;
  // Opened by choosing it in the list (not from a link): a chat with unread messages opens at the first of them.
  openAtUnread?: boolean;
  refreshToken?: number;
  // Reports whether this chat is loading or refreshing, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
  // The read state the server answered after the reader moved, for the badge of the chat in the sidebar.
  onReadState?: (chatId: string, state: MessengersChatReadState) => void;
  // The phone layout: no jump-to-start arrow, only the jump to the end while the reader is away from it.
  mobile?: boolean;
};

const FEED_POLICY: MessageFeedPolicy = {
  initialPosition: 'end',
  followAtBottom: false,
  aboveLoadBufferPx: 480,
  belowLoadBufferPx: 480,
  atBottomThresholdPx: 25,
  underfilledEdgeLoading: true,
  belowLoadStrategy: 'immediate',
  serializeEdgeLoads: true,
  expandBelowLoadBuffer: false,
  deferResizeWhileLoadingBelow: false,
};
const ANCHOR_FEED_POLICY: MessageFeedPolicy = { ...FEED_POLICY, initialPosition: 'start' };

const URL_WRITE_DELAY_MS = 300;
const COPIED_NOTICE_MS = 2000;
// How far from the bottom of the feed the reader still counts as being at the end of the chat.
const AT_END_THRESHOLD_PX = 52;

const noop = () => undefined;
const getMessageId = (message: MessengersMessageItem) => message.id;

// The open chat of the analysis messenger: header, date pill and message feed.
export function MessengerChatView({
  account,
  chat,
  title,
  initialAnchorId,
  openAtUnread = false,
  refreshToken = 0,
  onBusyChange,
  onBack,
  onReadState,
  mobile = false,
}: Props) {
  const feedRef = useRef<MessageFeedHandle<string>>(null);
  // The read span the chat had when it was opened, kept while it stays open: the writes of the reader move the stored
  // bounds, and the dividers must not walk away from the reader. A chat never read has no span to stop at.
  const [span] = useState<ReadSpan | null>(() =>
    chat.oldestReadAt == null || chat.newestReadAt == null
      ? null
      : { oldest: chat.oldestReadAt, newest: chat.newestReadAt },
  );
  const chatState = useMessengerChat({
    accountId: account.id,
    chatId: chat.id,
    anchorMessageId: initialAnchorId,
    unreadSpan: openAtUnread && span != null && chat.unreadCount > 0 ? span : null,
    refreshToken,
  });
  const { messages, memberById, loading, hasMoreAbove, hasMoreBelow } = chatState;
  const busy = loading || chatState.refreshing;
  const { onVisibleMessages } = useMessengerReadTracking({
    accountId: account.id,
    chatId: chat.id,
    messages,
    oldestReadAt: chat.oldestReadAt,
    newestReadAt: chat.newestReadAt,
    onReadState: onReadState ?? noop,
  });
  const marks = useMemo(() => findUnreadMarks(messages, span), [messages, span]);
  // Primitives, so a page that arrives does not make every bubble render again.
  const { afterId, beforeId } = marks;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [firstVisibleId, setFirstVisibleId] = useState<string | null>(null);
  // The chat opens at its end, so the reader starts there.
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const [alignPending, setAlignPending] = useState(true);
  // The feed asks for an edge page once; changing this key lets it ask again after a failed page.
  const [edgeRetryKey, setEdgeRetryKey] = useState(0);

  // Decided once, when the first page arrives: the anchor may be gone and the chat then opens at its end.
  const landedOnAnchorRef = useRef<boolean | null>(null);
  if (loading) {
    // A retry after a failed first load starts the decision over.
    landedOnAnchorRef.current = null;
  } else if (landedOnAnchorRef.current === null) {
    landedOnAnchorRef.current =
      initialAnchorId != null && messages.some((message) => message.id === initialAnchorId);
  }
  const landedOnAnchor = landedOnAnchorRef.current === true;
  // A link to a message that is gone (deleted, or never seen by this login) opens the chat at its end; say so.
  const { notify } = useOptionalPowerSnackbar();
  const anchorMissing =
    !loading && chatState.error == null && initialAnchorId != null && !landedOnAnchor;
  useEffect(() => {
    if (anchorMissing) {
      notify({
        severity: 'warning',
        message: 'Повідомлення не знайдено, можливо, його видалено. Чат відкрито з кінця.',
      });
    }
  }, [anchorMissing, notify]);

  // "Go to unread": the message to bring to the top. It waits for the message to be in the window and rendered, then aligns.
  const [unreadTarget, setUnreadTarget] = useState<string | null>(null);
  // A chat that opened at its first unread message lines it up once, when the first page is in.
  const { landingId } = chatState;
  const [landingAligned, setLandingAligned] = useState(false);
  const navigationTarget = useMemo(
    () =>
      unreadTarget != null
        ? {
            messageId: unreadTarget,
            alignment: 'start' as const,
            onAligned: () => setUnreadTarget(null),
          }
        : landingId != null && !landingAligned
          ? {
              messageId: landingId,
              alignment: 'start' as const,
              onAligned: () => setLandingAligned(true),
            }
          : landedOnAnchor && alignPending && initialAnchorId != null
            ? {
                messageId: initialAnchorId,
                alignment: 'start' as const,
                onAligned: () => {
                  setAlignPending(false);
                  feedRef.current?.highlightLinkedMessage(initialAnchorId);
                },
              }
            : null,
    [alignPending, initialAnchorId, landedOnAnchor, landingAligned, landingId, unreadTarget],
  );

  // The URL keeps the first visible analysis messenger message, so a refresh or a shared link reopens the same spot.
  // Only a reader at the very end has nothing to keep: the chat opens there by itself. The loaded
  // window often reaches the newest message while the reader is far above it, so that alone is no reason to drop it.
  const anchorForUrl = !hasMoreBelow && atBottom ? null : firstVisibleId;
  useEffect(() => {
    // Until the anchor is aligned the first visible message is just the top of the page.
    if (loading || navigationTarget != null) return;
    const timer = window.setTimeout(
      () => replaceMessengerChatQueryInUrl({ chatId: chat.id, anchorMessageId: anchorForUrl }),
      URL_WRITE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [anchorForUrl, chat.id, loading, navigationTarget]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const onFirstVisibleMessage = useCallback((id: string) => setFirstVisibleId(id), []);
  const copyLink = useCallback(
    (messageId: string) => {
      void copyTextToClipboard(buildMessengerChatLink(chat.id, messageId)).then(() =>
        setCopied(true),
      );
    },
    [chat.id],
  );
  const copyText = useCallback((text: string) => void copyTextToClipboard(text), []);
  const { goToEnd: loadEnd } = chatState;
  const goToEnd = useCallback(async () => {
    if (await loadEnd()) {
      requestAnimationFrame(() => feedRef.current?.scrollToBottom('smooth'));
    }
  }, [loadEnd]);

  const { goToStart: loadStart } = chatState;
  const goToStart = useCallback(async () => {
    if (await loadStart()) {
      requestAnimationFrame(() =>
        feedRef.current?.getScrollerElement()?.scrollTo({ top: 0, behavior: 'smooth' }),
      );
    }
  }, [loadStart]);

  // The unread messages are after the read span (new ones) or before it (history that was never read). It goes to the
  // first unread message after the span, and failing that to the newest of those before it. What is loaded is checked
  // first; otherwise the page around the bound is loaded.
  const { loadAroundSentAt } = chatState;
  const goToUnread = useCallback(async () => {
    if (span == null) return;
    let target = marks.afterId;
    // A request replaces the window, so what was read from the old one (`marks`, `hasMoreAbove`) no longer holds.
    let replaced = false;
    const nothingAfter = !hasMoreBelow && (messages.at(-1)?.sentAt ?? 0) <= span.newest;
    if (target == null && !nothingAfter) {
      const items = await loadAroundSentAt(span.newest);
      if (items == null) return;
      replaced = true;
      target = items.find((item) => item.sentAt > span.newest)?.id ?? null;
    }
    if (target == null) {
      if (!replaced && marks.aboveId != null) {
        target = marks.aboveId;
      } else if (replaced || hasMoreAbove) {
        const items = await loadAroundSentAt(span.oldest - 1);
        if (items == null) return;
        target = items.filter((item) => item.sentAt < span.oldest).at(-1)?.id ?? null;
      }
    }
    if (target != null) setUnreadTarget(target);
    else notify({ severity: 'info', message: 'Непрочитаних повідомлень не знайдено.' });
  }, [hasMoreAbove, hasMoreBelow, loadAroundSentAt, marks, messages, notify, span]);

  const privateChat = isPrivateChat(chat.chatType);
  const handleCopy = (event: ClipboardEvent<HTMLElement>) => {
    if (!privateChat) return;
    const selection = window.getSelection();
    const text = selection ? buildPrivateChatCopyText(event.currentTarget, selection) : null;
    if (text == null) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
  };

  // The date pill follows the first visible message. Until the feed reports one it shows the message the
  // chat landed on: the anchor, or the newest message when the chat opens at its end.
  const lastDateLabelRef = useRef('');
  const landingMessage = landedOnAnchor
    ? messages.find((item) => item.id === initialAnchorId)
    : landingId != null
      ? messages.find((item) => item.id === landingId)
      : messages[messages.length - 1];
  const dateMessage =
    firstVisibleId == null ? landingMessage : messages.find((item) => item.id === firstVisibleId);
  // A first visible message that left the window keeps the label it had.
  if (dateMessage != null) lastDateLabelRef.current = formatRelativeDateLabel(dateMessage.sentAt);
  const dateLabel = messages.length === 0 ? '' : lastDateLabelRef.current;

  const renderMessage = useCallback(
    (message: MessengersMessageItem) => {
      const member =
        message.senderChatMemberId == null ? undefined : memberById.get(message.senderChatMemberId);
      const sender = getSenderUiState({
        isOutgoing: message.isOutgoing,
        chatType: chat.chatType,
        member,
        accountName: account.name,
      });
      return (
        <MessengerMessageCard
          key={message.id}
          message={message}
          senderName={member == null ? null : senderName(member)}
          showSenderName={sender.showName}
          copyPrefix={sender.needsCopyPrefix ? sender.copyName : null}
          unreadDivider={
            message.id === afterId
              ? STOPPED_HERE_LABEL
              : message.id === beforeId
                ? UNREAD_ABOVE_LABEL
                : null
          }
          onCopyLink={copyLink}
          onCopyText={copyText}
        />
      );
    },
    [account.name, afterId, beforeId, chat.chatType, copyLink, copyText, memberById],
  );

  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-label={title}
      data-messenger-chat-view
    >
      <header className="flex items-center gap-2 border-b border-solid border-black/12 px-2 py-1 group-data-[mobile=true]/messenger:!gap-1 group-data-[mobile=true]/messenger:!px-1 dark:border-white/12">
        <IconButton size="small" aria-label="Назад до акаунта" onClick={onBack}>
          <ArrowBackIcon
            fontSize="small"
            className="group-data-[mobile=true]/messenger:!size-[18px]"
          />
        </IconButton>
        {/* `!` on the phone: the global h2 style is outside the layers and wins over a plain size, so the title came out bigger
            than the page title. */}
        <h2
          className="m-0 min-w-0 flex-1 truncate text-base font-medium group-data-[mobile=true]/messenger:!text-[18px] group-data-[mobile=true]/messenger:!font-medium"
          title={title}
        >
          {title}
        </h2>
        {span != null && chat.unreadCount > 0 ? (
          <Button
            size="small"
            disabled={chatState.jumpingToUnread}
            onClick={() => void goToUnread()}
            data-messenger-go-to-unread
          >
            До непрочитаних ({formatCompactCount(chat.unreadCount)})
          </Button>
        ) : null}
        {copied ? (
          <span className="text-xs opacity-70" role="status">
            Посилання скопійовано
          </span>
        ) : null}
      </header>
      {chatState.error != null ? (
        <div className="p-3">
          <PowerAlert
            severity="error"
            action={
              <button type="button" className="cursor-pointer underline" onClick={chatState.retry}>
                Повторити завантаження
              </button>
            }
          >
            {chatState.error}
          </PowerAlert>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col" onCopy={handleCopy}>
          {dateLabel !== '' ? (
            <div className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-echo-pill bg-black/45 px-echo-md py-0.5 text-xs text-white">
              {dateLabel}
            </div>
          ) : null}
          {chatState.pagingError != null ? (
            <PowerAlert
              severity="error"
              action={
                <button
                  type="button"
                  className="cursor-pointer underline"
                  onClick={() => {
                    chatState.clearPagingError();
                    setEdgeRetryKey((key) => key + 1);
                  }}
                >
                  Повторити
                </button>
              }
            >
              {chatState.pagingError}
            </PowerAlert>
          ) : null}
          {!loading && messages.length === 0 ? (
            <p className="p-4 opacity-60" role="status">
              Повідомлень немає.
            </p>
          ) : null}
          <MessageFeed<MessengersMessageItem, string>
            ref={feedRef}
            items={messages}
            getMessageId={getMessageId}
            parseId={String}
            renderMessage={renderMessage}
            isLoading={loading}
            loadingAbove={chatState.loadingAbove}
            loadingBelow={chatState.loadingBelow}
            hasMoreAbove={hasMoreAbove}
            hasMoreBelow={hasMoreBelow}
            scrollerProps={{
              className: 'slim-scrollbar min-h-0 flex-1',
              'data-messenger-feed-scroller': true,
              onScroll: ({ currentTarget: el }) =>
                setAtBottom(
                  el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_THRESHOLD_PX,
                ),
            }}
            listProps={{ className: 'pb-echo-xl' }}
            scrollOptions={{
              policy: landedOnAnchor || landingId != null ? ANCHOR_FEED_POLICY : FEED_POLICY,
              navigationTarget,
              resetKey: chat.id,
              edgeLoadRetryKey: edgeRetryKey,
              initialPositioningReady: !loading,
              loadEdgesOnLayout: !loading,
              hasReachedStart: loading || !hasMoreAbove,
              onLoadOlder: chatState.loadOlder,
              onLoadNewer: chatState.loadNewer,
              onFirstVisibleMessage,
              onVisibleMessages,
            }}
            oldestNavigation={
              mobile
                ? undefined
                : {
                    onClick: () => void goToStart(),
                    oldestLoaded: !hasMoreAbove,
                    loading: chatState.jumpingToStart,
                    label: 'На початок чату',
                  }
            }
            newestNavigation={{
              edge: 'bottom',
              newestLoaded: !hasMoreBelow,
              onClick: () => void goToEnd(),
              loading: chatState.jumpingToEnd,
              label: 'В кінець чату',
              // Leaves room for the scrollbar and the bubbles' right edge. On a phone it sits as close to the corner as the
              // bubbles do to the edge, the same on both sides.
              className: mobile
                ? '[--message-feed-fab-right:8px] [--message-feed-fab-bottom:8px]'
                : '[--message-feed-fab-right:32px] [--message-feed-fab-bottom:24px]',
            }}
          />
        </div>
      )}
    </section>
  );
}
