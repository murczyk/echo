import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import {
  parseMessengerChatQueryFromWindow,
  parseMessengerViewFromWindow,
  clearTableQueryInUrl,
  replaceMessengerChatQueryInUrl,
  replaceMessengerViewInUrl,
  type MessengerView,
} from '../helpers';
import { useMessengerChats } from '../use-messenger-chats';
import type { MessengerAccountItem } from './MessengerAccountList';
import { chatLabel, MessengerAccountSidebar } from './MessengerAccountSidebar';
import { MessengerChatView } from './MessengerChatView';
import { MessengerContactsView } from './MessengerContactsView';
import { MessengerInfoCard } from './MessengerInfoCard';
import { MessengerNoteCard } from './MessengerNoteCard';

type Props = {
  account: MessengerAccountItem | null;
  loading?: boolean;
  refreshToken?: number;
  // Reports whether any messenger request of the workspace is running, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
  onSaveInternalNotes?: (accountId: string, internalNotes: string) => Promise<void>;
  // shortcut: the external id will open another app, wire the target when it exists.
};

// A generic cap until the backend defines its own limit.
const INTERNAL_NOTES_MAX_LENGTH = 512;

export function MessengerWorkspace({
  account,
  loading = false,
  refreshToken = 0,
  onBusyChange,
  onSaveInternalNotes,
}: Props) {
  if (account == null && loading) {
    return (
      <p className="p-4 opacity-60" role="status">
        Завантажуємо акаунт…
      </p>
    );
  }
  if (account == null) {
    return (
      <div data-messenger-workspace-empty>
        <PowerAlert severity="info" sx={{ width: '100%', boxSizing: 'border-box' }}>
          Акаунт не обрано.
        </PowerAlert>
      </div>
    );
  }
  return (
    <MessengerAccountWorkspace
      key={account.id}
      account={account}
      refreshToken={refreshToken}
      onBusyChange={onBusyChange}
      onSaveInternalNotes={onSaveInternalNotes}
    />
  );
}

// Everything that belongs to one analysis messenger account: its chats, the open chat and the account cards.
function MessengerAccountWorkspace({
  account,
  refreshToken,
  onBusyChange,
  onSaveInternalNotes,
}: {
  account: MessengerAccountItem;
  refreshToken: number;
  onBusyChange?: (busy: boolean) => void;
  onSaveInternalNotes?: Props['onSaveInternalNotes'];
}) {
  // The page's own phone check. The sidebar and the chat take it from here (the chat through `group-data-[mobile=true]/messenger`).
  const mobile = useMediaQuery(useTheme().breakpoints.down('sm'));
  const chatsState = useMessengerChats(account.id, refreshToken);
  const [chatBusy, setChatBusy] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const busy = chatsState.fetching || chatBusy || viewBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  // The analysis messenger chat and its position come from the URL once, on mount; after that the chat view owns them.
  const [selected, setSelected] = useState(() => parseMessengerChatQueryFromWindow(account.id));
  const chat = chatsState.chats.find((item) => item.id === selected.chatId) ?? null;
  // A failed chat list proves nothing, so a shared link survives it and opens after a retry.
  const chatMissing =
    selected.chatId != null && !chatsState.loading && chatsState.error == null && chat == null;

  // A view of the account (the contacts) instead of the account cards; a chat takes its place and the other way round.
  const [view, setView] = useState<MessengerView | null>(() =>
    parseMessengerViewFromWindow(account.id),
  );
  const selectChat = (chatId: string | null) => {
    setSelected({ chatId, anchorMessageId: null });
    if (chatId == null) {
      replaceMessengerChatQueryInUrl({ chatId: null, anchorMessageId: null });
    } else {
      setView(null);
      replaceMessengerViewInUrl(null);
      clearTableQueryInUrl();
    }
  };
  const openView = (next: MessengerView | null) => {
    setSelected({ chatId: null, anchorMessageId: null });
    setView(next);
    replaceMessengerViewInUrl(next);
    // The table of a view starts clean, whatever another table left in the URL, and leaves nothing behind.
    clearTableQueryInUrl();
  };

  // A shared analysis messenger link to a chat that is gone, or that this login cannot see, opens the account instead.
  useEffect(() => {
    if (chatMissing) selectChat(null);
  }, [chatMissing]);

  return (
    // On a phone the open sidebar takes the whole width, so the page beside it is hidden (kept mounted, with its scroll).
    <div
      className="group/messenger flex h-full min-h-0 [&:has([data-messenger-sidebar][data-mobile=true][data-open=true])>:not([data-messenger-sidebar])]:hidden"
      data-messenger-workspace
      data-mobile={mobile ? 'true' : 'false'}
    >
      <MessengerAccountSidebar
        mobile={mobile}
        account={account}
        chatsState={chatsState}
        selectedChatId={selected.chatId}
        contactsOpen={view === 'contacts' && chat == null}
        onSelectChat={selectChat}
        onOpenContacts={() => openView('contacts')}
        onOpenAccount={() => {
          selectChat(null);
          openView(null);
        }}
      />
      {chat != null ? (
        <MessengerChatView
          key={chat.id}
          account={account}
          chat={chat}
          title={chatLabel(chat)}
          initialAnchorId={selected.anchorMessageId}
          refreshToken={refreshToken}
          onBusyChange={setChatBusy}
          onBack={() => selectChat(null)}
          mobile={mobile}
        />
      ) : selected.chatId != null && chatsState.loading ? (
        <p className="p-4 opacity-60" role="status">
          Завантажуємо чат…
        </p>
      ) : view === 'contacts' ? (
        <MessengerContactsView
          account={account}
          refreshToken={refreshToken}
          onBusyChange={setViewBusy}
          onBack={() => openView(null)}
        />
      ) : (
        // The first card starts level with the top of the panel toggle of the sidebar (0.5 rem), on any screen. On a phone
        // the cards also sit as close to the sides as the bubbles of a chat. `!`: Bootstrap's `.p-4` and `.gap-4` are `!important`.
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 !pt-2 group-data-[mobile=true]/messenger:!gap-1.5 group-data-[mobile=true]/messenger:!px-1.5 group-data-[mobile=true]/messenger:!pb-1.5">
          <MessengerNoteCard
            key={`internal-${account.id}`}
            title="Внутрішній опис"
            maxLength={INTERNAL_NOTES_MAX_LENGTH}
            text={account.internalNotes}
            onSave={
              onSaveInternalNotes == null
                ? undefined
                : (internalNotes) => onSaveInternalNotes(account.id, internalNotes)
            }
          />
          <MessengerNoteCard title="Опис" text={account.notes} />
          <MessengerInfoCard account={account} />
        </main>
      )}
    </div>
  );
}
