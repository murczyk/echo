import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { IconButton } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { PowerAlert } from '../../../components/PowerAlert';
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
import { senderName, useMessengerChat } from '../use-messenger-chat';
import type { MessengerChat } from '../use-messenger-chats';
import type { MessengerAccountItem } from './MessengerAccountList';
import { MessengerMessageCard } from './MessengerMessageCard';

type Props = {
  account: MessengerAccountItem;
  chat: MessengerChat;
  title: string;
  // From the URL: the analysis messenger chat opens at this message instead of at its end.
  initialAnchorId: string | null;
  refreshToken?: number;
  // Reports whether this chat is loading or refreshing, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
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

const getMessageId = (message: MessengersMessageItem) => message.id;

// The open chat of the analysis messenger: header, date pill and message feed.
export function MessengerChatView({
  account,
  chat,
  title,
  initialAnchorId,
  refreshToken = 0,
  onBusyChange,
  onBack,
}: Props) {
  const feedRef = useRef<MessageFeedHandle<string>>(null);
  const chatState = useMessengerChat({
    accountId: account.id,
    chatId: chat.id,
    anchorMessageId: initialAnchorId,
    refreshToken,
  });
  const { messages, memberById, loading, hasMoreAbove, hasMoreBelow } = chatState;
  const busy = loading || chatState.refreshing;
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

  const navigationTarget = useMemo(
    () =>
      landedOnAnchor && alignPending && initialAnchorId != null
        ? {
            messageId: initialAnchorId,
            alignment: 'start' as const,
            onAligned: () => {
              setAlignPending(false);
              feedRef.current?.highlightLinkedMessage(initialAnchorId);
            },
          }
        : null,
    [alignPending, initialAnchorId, landedOnAnchor],
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
          onCopyLink={copyLink}
          onCopyText={copyText}
        />
      );
    },
    [account.name, chat.chatType, copyLink, copyText, memberById],
  );

  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-label={title}
      data-messenger-chat-view
    >
      <header className="flex items-center gap-2 border-b border-solid border-black/12 px-2 py-1 dark:border-white/12">
        <IconButton size="small" aria-label="Назад до акаунта" onClick={onBack}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <h2 className="m-0 min-w-0 flex-1 truncate text-base font-medium" title={title}>
          {title}
        </h2>
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
              policy: landedOnAnchor ? ANCHOR_FEED_POLICY : FEED_POLICY,
              navigationTarget,
              resetKey: chat.id,
              edgeLoadRetryKey: edgeRetryKey,
              initialPositioningReady: !loading,
              loadEdgesOnLayout: !loading,
              hasReachedStart: loading || !hasMoreAbove,
              onLoadOlder: chatState.loadOlder,
              onLoadNewer: chatState.loadNewer,
              onFirstVisibleMessage,
            }}
            oldestNavigation={{
              onClick: () => void goToStart(),
              oldestLoaded: !hasMoreAbove,
              loading: chatState.jumpingToStart,
              label: 'На початок чату',
            }}
            newestNavigation={{
              edge: 'bottom',
              newestLoaded: !hasMoreBelow,
              onClick: () => void goToEnd(),
              loading: chatState.jumpingToEnd,
              label: 'В кінець чату',
              // Leaves room for the scrollbar and the bubbles' right edge.
              className: '[--message-feed-fab-right:32px] [--message-feed-fab-bottom:24px]',
            }}
          />
        </div>
      )}
    </section>
  );
}
