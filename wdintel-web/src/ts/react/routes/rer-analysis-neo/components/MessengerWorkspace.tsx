import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Collapse } from '@mui/material';
import { useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { MessengerAccountAvatar, type MessengerAccountItem } from './MessengerAccountList';
import { MessengerInfoCard } from './MessengerInfoCard';
import { MessengerNoteCard } from './MessengerNoteCard';
import { MessengerSearchField } from './MessengerSearchField';

type Props = {
  account: MessengerAccountItem | null;
  loading?: boolean;
  onSaveInternalNotes?: (accountId: string, internalNotes: string) => Promise<void>;
  // shortcut: the external id will open another app, wire the target when it exists.
  onExternalIdClick?: (account: MessengerAccountItem) => void;
};

// A generic cap until the backend defines its own limit.
const INTERNAL_NOTES_MAX_LENGTH = 512;

// shortcut: static layout only; navigation, chat lists and the main area get wired when the backend lands.
const NAV_ITEMS = ['Галерея', 'Контакти'] as const;
const CHAT_SECTIONS = ['Приватні', 'Групи', 'Канали', 'Боти'] as const;

function ChatSection({ title }: { title: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title} (0)</span>
        <ExpandMoreIcon fontSize="small" className={open ? '' : '-rotate-90'} />
      </button>
      <Collapse in={open}>
        <p className="px-3 py-1 text-xs opacity-60">Немає чатів</p>
      </Collapse>
    </section>
  );
}

function MessengerSidebar({
  account,
  onExternalIdClick,
}: {
  account: MessengerAccountItem;
  onExternalIdClick?: (account: MessengerAccountItem) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <aside
      aria-label="Навігація акаунту"
      className="flex min-h-0 w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-solid border-black/12 py-2 dark:border-white/12"
    >
      <div className="flex items-center gap-3 px-3 py-1">
        <MessengerAccountAvatar account={account} />
        <span className="flex min-w-0 flex-col">
          <span className="group-navigation-name" title={account.name}>
            {account.name}
          </span>
          <span className="group-navigation-name text-xs opacity-60">{account.phone}</span>
          {account.username ? (
            <span className="group-navigation-name text-xs opacity-60">@{account.username}</span>
          ) : null}
          {account.userId ? (
            <span className="group-navigation-name text-xs opacity-60" data-messenger-user-id>
              User ID: {account.userId}
            </span>
          ) : null}
          {account.externalId ? (
            <span className="group-navigation-name text-xs opacity-60">
              External ID:{' '}
              <button
                type="button"
                className="cursor-pointer underline hover:opacity-100"
                data-messenger-external-id
                onClick={() => onExternalIdClick?.(account)}
              >
                {account.externalId}
              </button>
            </span>
          ) : null}
        </span>
      </div>
      <nav className="flex flex-col">
        {NAV_ITEMS.map((item) => (
          <button key={item} type="button" className="px-3 py-2 text-start text-sm">
            {item}
          </button>
        ))}
      </nav>
      <div className="px-3">
        <MessengerSearchField value={query} onChange={setQuery} ariaLabel="Пошук чату" />
      </div>
      {CHAT_SECTIONS.map((title) => (
        <ChatSection key={title} title={title} />
      ))}
    </aside>
  );
}

export function MessengerWorkspace({
  account,
  loading = false,
  onSaveInternalNotes,
  onExternalIdClick,
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
    <div className="flex h-full min-h-0" data-messenger-workspace>
      <MessengerSidebar account={account} onExternalIdClick={onExternalIdClick} />
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
        <MessengerInfoCard account={account} onExternalIdClick={onExternalIdClick} />
      </main>
    </div>
  );
}
