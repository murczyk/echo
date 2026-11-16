import { useEffect, useState } from 'react';

import type { MessengersAccountItem } from '../../../../Bindings';
import { isAbortError } from '../../services/api/client';
import {
  listMessengersAccounts,
  updateMessengersAccount,
} from '../../services/api/analysis-messengers';
import { toErrorMessage } from './use-analysis-data.shared';
import type { MessengerAccountItem } from './components/MessengerAccountList';

function formatPhone(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

export function toMessengerAccountItem(account: MessengersAccountItem): MessengerAccountItem {
  return {
    id: account.id,
    name: account.displayName,
    phone: account.phone ? formatPhone(account.phone) : '',
    username: account.username,
    notes: account.notes,
    internalNotes: account.internalNotes,
    userId: account.telegram?.userId ?? null,
    externalId: account.externalId,
    externalUrl: account.externalUrl,
    avatarUrl: account.avatarUrl,
    createdAt: account.createdAt,
    lastSync: account.lastSync,
  };
}

// Loads the analysis messenger accounts only while `enabled`, so users without access never hit the endpoint.
// `refreshToken` is bumped by the header refresh button: a new value reloads the list in place.
export function useMessengerAccounts(enabled: boolean, refreshToken = 0) {
  const [accounts, setAccounts] = useState<MessengerAccountItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while a request is in flight, the header refresh stays disabled meanwhile.
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError(null);
    setFetching(true);
    listMessengersAccounts({ signal: controller.signal })
      .then((rsp) => {
        setAccounts(rsp.items.map(toMessengerAccountItem));
        setLoaded(true);
        setFetching(false);
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        setError(toErrorMessage(reason));
        setFetching(false);
      });
    return () => {
      controller.abort();
      setFetching(false);
    };
  }, [enabled, refreshToken]);

  // A blank text clears the notes. The list changes only after the request succeeded, so a
  // failed save leaves the old text.
  const saveInternalNotes = async (accountId: string, text: string) => {
    const internalNotes = text.trim() === '' ? null : text;
    await updateMessengersAccount({ accountId, internalNotes: internalNotes });
    setAccounts((current) =>
      current.map((account) =>
        account.id === accountId ? { ...account, internalNotes } : account,
      ),
    );
  };

  // Derived, so a shared link does not flash "no account" before the first request starts.
  return {
    accounts,
    loading: enabled && !loaded && error == null,
    fetching,
    error,
    saveInternalNotes,
  };
}
