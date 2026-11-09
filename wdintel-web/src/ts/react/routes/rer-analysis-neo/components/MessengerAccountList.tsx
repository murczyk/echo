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
  avatarUrl?: string | null;
  // The account's id inside the external messenger app itself (Telegram user id).
  userId?: string | null;
  // The account's id in the external system.
  externalId?: string | null;
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

export function MessengerAccountAvatar({ account }: { account: MessengerAccountItem }) {
  return (
    <span
      className="group-navigation-avatar overflow-hidden"
      data-messenger-account-avatar
      aria-hidden="true"
      style={
        account.avatarUrl
          ? undefined
          : {
              backgroundColor: 'var(--echo-color-primary, var(--color-action))',
              color: '#fff',
            }
      }
    >
      {account.avatarUrl ? (
        <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
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
                  className="group-navigation-list-item"
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
