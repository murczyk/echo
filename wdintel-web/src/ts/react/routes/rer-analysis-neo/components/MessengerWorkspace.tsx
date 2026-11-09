import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Collapse } from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { formatDate } from '../../../utils/misc';
import {
  parseMessengerChatQueryFromWindow,
  parseMessengerViewFromWindow,
  clearTableQueryInUrl,
  replaceMessengerChatQueryInUrl,
  replaceMessengerViewInUrl,
  type MessengerView,
} from '../helpers';
import {
  chatSectionOf,
  type MessengerChat,
  useMessengerChats,
  type MessengerChatSection,
} from '../use-messenger-chats';
import { CopyValue } from './CopyValue';
import { MessengerAccountAvatar, type MessengerAccountItem } from './MessengerAccountList';
import { MessengerChatView } from './MessengerChatView';
import { MessengerContactsView } from './MessengerContactsView';
import { MessengerInfoCard } from './MessengerInfoCard';
import { MessengerNoteCard } from './MessengerNoteCard';
import { MessengerSearchField } from './MessengerSearchField';

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

// shortcut: the gallery is not wired yet, its item does nothing.
const GALLERY_NAV_ITEM = 'Галерея';
const CHAT_SECTIONS: ReadonlyArray<{ key: MessengerChatSection; title: string }> = [
  { key: 'private', title: 'Приватні' },
  { key: 'group', title: 'Групи' },
  { key: 'channel', title: 'Канали' },
  { key: 'bot', title: 'Боти' },
];

// Short numeric date, e.g. 12.09.26.
const formatChatDate = (ms: number) =>
  formatDate(ms, { day: '2-digit', month: '2-digit', year: '2-digit' });

const chatLabel = (chat: MessengerChat) => chat.title || chat.username || chat.externalId;

function ChatSection({
  title,
  chats,
  selectedChatId,
  onSelectChat,
}: {
  title: string;
  chats: MessengerChat[];
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          {title} ({chats.length})
        </span>
        <ExpandMoreIcon fontSize="small" className={open ? '' : '-rotate-90'} />
      </button>
      <Collapse in={open}>
        {chats.length === 0 ? (
          <p className="px-3 py-1 text-xs opacity-60">Немає чатів</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className="group-navigation-list-item"
                  data-messenger-chat
                  data-selected={chat.id === selectedChatId ? 'true' : 'false'}
                  aria-current={chat.id === selectedChatId ? 'true' : undefined}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <MessengerAccountAvatar
                    account={{ id: chat.id, name: chatLabel(chat), phone: '' }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="group-navigation-name" title={chatLabel(chat)}>
                      {chatLabel(chat)}
                    </span>
                    {chat.lastMessageDate != null ? (
                      <span className="group-navigation-name text-xs opacity-60">
                        {formatChatDate(chat.lastMessageDate)}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Collapse>
    </section>
  );
}

function MessengerSidebar({
  account,
  chatsState: { chats, loading, error, retry },
  selectedChatId,
  contactsOpen,
  onSelectChat,
  onOpenContacts,
}: {
  account: MessengerAccountItem;
  chatsState: ReturnType<typeof useMessengerChats>;
  selectedChatId: string | null;
  contactsOpen: boolean;
  onSelectChat: (chatId: string) => void;
  onOpenContacts: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? chats.filter((chat) =>
        [chat.title, chat.username, chat.externalId].some((field) =>
          (field ?? '').toLowerCase().includes(needle),
        ),
      )
    : chats;
  return (
    <aside
      aria-label="Навігація акаунту"
      className="slim-scrollbar flex min-h-0 w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-solid border-black/12 py-2 dark:border-white/12"
    >
      <div className="flex items-center gap-3 px-3 pb-1">
        <MessengerAccountAvatar account={account} />
        <span className="flex min-w-0 flex-col">
          <CopyValue text={account.name} className="group-navigation-name">
            {account.name}
          </CopyValue>
          {account.phone ? (
            <CopyValue
              text={account.phone.startsWith('+') ? account.phone : `+${account.phone}`}
              className="group-navigation-name text-xs opacity-60"
            >
              {account.phone}
            </CopyValue>
          ) : null}
          {account.username ? (
            <CopyValue
              text={`@${account.username}`}
              className="group-navigation-name text-xs opacity-60"
            >
              @{account.username}
            </CopyValue>
          ) : null}
          {account.userId ? (
            <span className="group-navigation-name text-xs opacity-60" data-messenger-user-id>
              User ID: <CopyValue text={account.userId}>{account.userId}</CopyValue>
            </span>
          ) : null}
          {account.externalId ? (
            <span className="group-navigation-name text-xs opacity-60">
              External ID: <CopyValue text={account.externalId}>{account.externalId}</CopyValue>
            </span>
          ) : null}
        </span>
      </div>
      <nav className="flex flex-col">
        <button type="button" className="px-3 py-2 text-start text-sm">
          {GALLERY_NAV_ITEM}
        </button>
        <button
          type="button"
          className="px-3 py-2 text-start text-sm data-[selected=true]:font-medium"
          data-messenger-nav="contacts"
          data-selected={contactsOpen ? 'true' : 'false'}
          aria-current={contactsOpen ? 'true' : undefined}
          onClick={onOpenContacts}
        >
          Контакти
        </button>
      </nav>
      <div className="px-3">
        <MessengerSearchField value={query} onChange={setQuery} ariaLabel="Пошук чату" />
      </div>
      {error != null ? (
        <div className="flex flex-col items-start gap-1 px-3 py-2">
          <p className="m-0" role="alert">
            {error}
          </p>
          <button type="button" className="text-xs underline" onClick={retry}>
            Повторити завантаження
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="px-3 text-xs opacity-60" role="status">
          Завантажуємо чати…
        </p>
      ) : // A failed first load has no chats to show; a failed refresh keeps the old ones under the error.
      error != null && chats.length === 0 ? null : (
        CHAT_SECTIONS.map(({ key, title }) => (
          <ChatSection
            key={key}
            title={title}
            chats={visible.filter((chat) => chatSectionOf(chat) === key)}
            selectedChatId={selectedChatId}
            onSelectChat={onSelectChat}
          />
        ))
      )}
    </aside>
  );
}

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
    <div className="flex h-full min-h-0" data-messenger-workspace>
      <MessengerSidebar
        account={account}
        chatsState={chatsState}
        selectedChatId={selected.chatId}
        contactsOpen={view === 'contacts' && chat == null}
        onSelectChat={selectChat}
        onOpenContacts={() => openView('contacts')}
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
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
