import { useState } from 'react';

import '../../../components/selectable-list.css';
import { messengerAvatarUrl } from '../../../services/api/analysis-messengers';

export type MessengerAccountItem = {
  id: string;
  name: string;
  // Phone, already formatted for display.
  phone: string;
  username?: string | null;
  // Regular description of the account, comes from external service
  notes?: string | null;
  // Internal description, editable by the operator.
  internalNotes?: string | null;
  avatarId?: string | null;
  // The account's id inside the external messenger app itself (Telegram user id).
  userId?: string | null;
  // The account's id in the external system.
  externalId?: string | null;
  // Link to the account's page in the external system, an absolute http(s) URL.
  externalUrl?: string | null;
  // Epoch milliseconds, as the API sends them.
  createdAt?: number | null;
  lastSync?: number | null;
};

type Props = {
  accounts: readonly MessengerAccountItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  query?: string;
  loading?: boolean;
  error?: string | null;
};

// The backend only stores http(s) links; checking again keeps a stray scheme from ever becoming a clickable one.
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function messengerAccountInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toLocaleUpperCase() ?? '')
    .join('');
  return initials === '' ? '—' : initials;
}

function matchesQuery(account: MessengerAccountItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === '' ||
    [account.name, account.phone, account.username, account.notes, account.internalNotes].some(
      (field) => (field ?? '').toLocaleLowerCase().includes(needle),
    )
  );
}

export function MessengerAccountAvatar({
  account,
  className = '',
}: {
  account: MessengerAccountItem;
  className?: string;
}) {
  // An image that does not load (gone, no access) gives way to the initials, not to an empty circle.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const candidateUrl = account.avatarId ? messengerAvatarUrl(account.avatarId) : null;
  const avatarUrl = candidateUrl !== failedUrl ? candidateUrl : null;
  return (
    <span
      className={`group-navigation-avatar overflow-hidden ${className}`}
      data-messenger-account-avatar
      aria-hidden="true"
      style={
        avatarUrl
          ? undefined
          : {
              backgroundColor: 'var(--echo-color-primary, var(--color-action))',
              color: '#fff',
            }
      }
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        messengerAccountInitials(account.name)
      )}
    </span>
  );
}

export function MessengerAccountList({
  accounts,
  selectedId = null,
  onSelect,
  query = '',
  loading = false,
  error = null,
}: Props) {
  const visibleAccounts = accounts.filter((account) => matchesQuery(account, query));

  return (
    <>
      <nav className="group-navigation-list slim-scrollbar" aria-label="Телеграм акаунти">
        <ul>
          {visibleAccounts.map((account) => {
            const selected = account.id === selectedId;
            return (
              <li key={account.id}>
                <button
                  type="button"
                  className="group-navigation-list-item echo-selectable-list-item"
                  data-messenger-account-item
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect?.(account.id)}
                >
                  <MessengerAccountAvatar account={account} />
                  <span className="flex min-w-0 flex-col">
                    <span className="group-navigation-name" title={account.name}>
                      {account.name}
                    </span>
                    <span
                      className="group-navigation-name text-xs opacity-60"
                      title={account.phone}
                    >
                      {account.phone}
                    </span>
                    {account.username ? (
                      <span
                        className="group-navigation-name text-xs opacity-60"
                        data-messenger-account-username
                      >
                        @{account.username}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {loading ? (
        <p className="px-3 py-2" role="status">
          Завантажуємо акаунти…
        </p>
      ) : null}
      {error ? (
        <p className="px-3 py-2" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && !error && visibleAccounts.length === 0 ? (
        <p className="px-3 py-2" role="status">
          Акаунтів не знайдено.
        </p>
      ) : null}
    </>
  );
}
