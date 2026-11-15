import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { IconButton } from '@mui/material';
import { useCallback, useMemo } from 'react';

import { contactsFileName, withAccountRow } from '../messenger-contacts-export';
import { useMessengerContacts } from '../use-messenger-contacts';
import type { MessengerAccountItem } from './MessengerAccountList';
import { MessengerPeopleTable } from './MessengerPeopleTable';

type Props = {
  account: MessengerAccountItem;
  refreshToken?: number;
  // Reports whether a request is running, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
};

const TITLE = 'Контакти акаунту';

// The address book of an analysis messenger account: the shared people table fed by `contacts/list` pages.
export function MessengerContactsView({ account, refreshToken = 0, onBusyChange, onBack }: Props) {
  const {
    contacts,
    total,
    loading,
    fetching,
    error,
    hasMore,
    loadMore,
    loadAll,
    fetchEveryContact,
    retry,
  } = useMessengerContacts(account.id, refreshToken);
  const rows = useMemo(() => withAccountRow(contacts, account), [contacts, account]);
  // Stable, the table starts it from an effect and a new function on every render would start it again after a failure.
  const loadEveryContact = useCallback(() => void loadAll(), [loadAll]);
  const fetchAllRows = useCallback(async () => {
    const all = await fetchEveryContact();
    return all == null ? null : withAccountRow(all, account);
  }, [fetchEveryContact, account]);

  return (
    <MessengerPeopleTable
      tableId="rer-analysis-messenger-contacts"
      title={TITLE}
      searchLabel="Пошук контактів"
      exportLabel="Експорт контактів"
      rootAttributes={{ 'data-messenger-contacts-view': '' }}
      leading={
        <>
          <IconButton size="small" aria-label="Назад до акаунта" onClick={onBack}>
            <ArrowBackIcon
              fontSize="small"
              className="group-data-[mobile=true]/messenger:!size-[18px]"
            />
          </IconButton>
          <h2 className="m-0 text-base font-medium group-data-[mobile=true]/messenger:!text-[18px] group-data-[mobile=true]/messenger:!font-medium">
            {TITLE}
          </h2>
        </>
      }
      rows={rows}
      // The account itself is not a contact of the list, so it is not in the total.
      allCount={total + (rows.length - contacts.length)}
      loading={loading}
      fetching={fetching}
      error={error}
      hasMore={hasMore}
      loadMore={loadMore}
      loadAll={loadEveryContact}
      retry={retry}
      fetchAllRows={fetchAllRows}
      fileName={(extension) => contactsFileName(account.id, extension)}
      onBusyChange={onBusyChange}
    />
  );
}
