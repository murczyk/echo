import { useCallback, useEffect, useRef, useState } from 'react';

import type { MessengersContactItem } from '../../../../Bindings';
import { listMessengersContacts } from '../../services/api/analysis-messengers';
import { isAbortError } from '../../services/api/client';
import { toErrorMessage } from './use-analysis-data.shared';

export const MESSENGER_CONTACTS_PAGE_SIZE = 100;
// Passes over all pages that an export makes before it gives up on contacts that keep changing.
const EXPORT_ATTEMPTS = 3;

type Loaded = { items: MessengersContactItem[]; total: number; pages: number };

const hasMorePages = (loaded: Loaded) => loaded.pages * MESSENGER_CONTACTS_PAGE_SIZE < loaded.total;

// The contacts of one analysis messenger account, loaded page by page for infinite scroll. Mount it with a `key`
// per account. A new `refreshToken` (the header refresh button) reloads the pages that are on screen in place: the
// contacts stay until they all arrived. Pages are offsets, so a sync between two requests can repeat a
// contact (dropped here) or skip one.
export function useMessengerContacts(accountId: string, refreshToken = 0) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const errorRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // An export pass lives as long as the hook, so a refresh of the list does not cancel it.
  const exportControllerRef = useRef<AbortController | null>(null);
  // Bumped when the list restarts, so an answer for the old list is dropped.
  const generationRef = useRef(0);
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  // Loads the next page. With `restart` it loads again from the first page, as many pages as are on screen, and
  // replaces the list once they all arrived, so a refresh keeps the scroll position. Resolves to false when it
  // failed or was dropped.
  const fetchPage = useCallback(
    (restart: boolean): Promise<boolean> => {
      if (inFlightRef.current != null) return inFlightRef.current;
      const signal = controllerRef.current?.signal;
      const base = restart ? null : loadedRef.current;
      if (signal == null || (base != null && !hasMorePages(base))) {
        return Promise.resolve(signal != null);
      }
      const wanted = restart ? Math.max(1, loadedRef.current?.pages ?? 1) : 1;
      const firstPage = base == null ? 1 : base.pages + 1;
      const generation = generationRef.current;
      setFetching(true);
      const request = (async () => {
        let next: Loaded | null = base;
        for (let page = firstPage; page < firstPage + wanted; page += 1) {
          const rsp = await listMessengersContacts(
            { accountId, page, limit: MESSENGER_CONTACTS_PAGE_SIZE },
            { signal },
          );
          if (generation !== generationRef.current) return false;
          const seen = new Set((next?.items ?? []).map((item) => item.id));
          const items = [...(next?.items ?? []), ...rsp.items.filter((item) => !seen.has(item.id))];
          // An empty page proves the end, whatever the total says.
          next = { items, total: rsp.items.length === 0 ? items.length : rsp.total, pages: page };
          // The list got shorter since it was loaded: no more pages to bring back.
          if (!hasMorePages(next)) break;
        }
        loadedRef.current = next;
        errorRef.current = null;
        setLoaded(next);
        setError(null);
        return true;
      })()
        .catch((reason: unknown) => {
          if (isAbortError(reason) || generation !== generationRef.current) return false;
          errorRef.current = toErrorMessage(reason);
          setError(errorRef.current);
          return false;
        })
        .finally(() => {
          if (generation !== generationRef.current) return;
          inFlightRef.current = null;
          setFetching(false);
        });
      inFlightRef.current = request;
      return request;
    },
    [accountId],
  );

  useEffect(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = null;
    errorRef.current = null;
    setError(null);
    void fetchPage(true);
    return () => {
      controller.abort();
      setFetching(false);
    };
  }, [fetchPage, refreshToken]);

  useEffect(() => {
    const controller = new AbortController();
    exportControllerRef.current = controller;
    return () => controller.abort();
  }, [accountId]);

  // The next page for infinite scroll. After a failure it waits for `retry`, so scrolling does not hammer a broken request.
  const loadMore = useCallback(() => {
    if (errorRef.current == null) void fetchPage(false);
  }, [fetchPage]);

  // Every contact, for an export or a search over the whole list. Resolves to null when a request failed.
  const loadAll = useCallback(async (): Promise<MessengersContactItem[] | null> => {
    for (;;) {
      const current = loadedRef.current;
      if (current != null && !hasMorePages(current)) return current.items;
      if (!(await fetchPage(current == null))) return null;
    }
  }, [fetchPage]);

  // Every contact for an export, from a fresh pass over all pages that does not touch the list on screen. Pages are
  // offsets, so a sync during the pass can repeat a contact or skip one; a pass is only trusted when the total
  // stayed the same and no contact came twice, otherwise it is made again. Resolves to null when a request failed
  // or the contacts would not hold still.
  const fetchEveryContact = useCallback(async (): Promise<MessengersContactItem[] | null> => {
    const signal = exportControllerRef.current?.signal;
    if (signal == null) return null;
    try {
      for (let attempt = 0; attempt < EXPORT_ATTEMPTS; attempt += 1) {
        const contacts = new Map<string, MessengersContactItem>();
        let total: number | null = null;
        let stable = true;
        for (let page = 1; ; page += 1) {
          const rsp = await listMessengersContacts(
            { accountId, page, limit: MESSENGER_CONTACTS_PAGE_SIZE },
            { signal },
          );
          if (total != null && rsp.total !== total) stable = false;
          total = rsp.total;
          for (const item of rsp.items) {
            if (contacts.has(item.id)) stable = false;
            contacts.set(item.id, item);
          }
          if (rsp.items.length === 0 || page * MESSENGER_CONTACTS_PAGE_SIZE >= rsp.total) break;
        }
        if (stable && contacts.size === total) return [...contacts.values()];
      }
      return null;
    } catch {
      return null;
    }
  }, [accountId]);

  const retry = useCallback(() => {
    errorRef.current = null;
    setError(null);
    void fetchPage(loadedRef.current == null);
  }, [fetchPage]);

  return {
    contacts: loaded?.items ?? [],
    total: loaded?.total ?? 0,
    // Nothing to show yet.
    loading: loaded == null && error == null,
    fetching,
    error,
    hasMore: loaded != null && hasMorePages(loaded),
    loadMore,
    loadAll,
    fetchEveryContact,
    retry,
  };
}
