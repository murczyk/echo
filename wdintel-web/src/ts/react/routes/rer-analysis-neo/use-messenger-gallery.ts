import { useCallback, useEffect, useRef, useState } from 'react';

import type { MessengersAttachmentItem } from '../../../../Bindings';
import { isAbortError } from '../../services/api/client';
import {
  messengerGallerySource,
  type GalleryCounts,
  type GalleryDataSource,
  type GalleryScope,
  type GalleryTab,
} from './messenger-gallery';
import { toErrorMessage } from './use-analysis-data.shared';

type Args = {
  source?: GalleryDataSource;
  accountId: string;
  chatId: string | null;
  tab: GalleryTab;
  // Bumped by the header refresh button: loads the first page again, the items stay until it arrives.
  refreshToken?: number;
};

type Entry = { items: MessengersAttachmentItem[]; cursor: string | null; loadedAt: number };

// How long a tab that was left counts as fresh: coming back to it within this time asks for nothing.
export const GALLERY_FRESH_MS = 30_000;

const mediaIdOf = (item: MessengersAttachmentItem) => item.attachment.media.id;

// The media of one chat (or of every chat of an account, when `chatId` is null) in one tab, page by page for infinite
// scroll, newest first. Every tab keeps what it loaded, so switching back shows it at once: within `GALLERY_FRESH_MS` with
// no request, after that straight away while the first page is asked for again (it then replaces the entry, so the pages
// scrolled to before are dropped). The header refresh (`refreshToken`) drops the other tabs and refreshes this one the
// same way. The cache lives as long as the hook, so it is gone when the gallery unmounts.
export function useMessengerGallery({
  source = messengerGallerySource,
  accountId,
  chatId,
  tab,
  refreshToken = 0,
}: Args) {
  const key = `${accountId}|${chatId ?? ''}|${tab}`;
  const [attempt, setAttempt] = useState(0);
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(() => new Map());
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  });
  const refreshSeenRef = useRef(refreshToken);
  const attemptSeenRef = useRef(attempt);

  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      source.list({ accountId, chatId }, tab, cursor, signal),
    [source, accountId, chatId, tab],
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const refreshed = refreshSeenRef.current !== refreshToken;
    refreshSeenRef.current = refreshToken;
    // A retry after a failed first load asks again even when the entry is fresh.
    const retried = attemptSeenRef.current !== attempt;
    attemptSeenRef.current = attempt;
    // The other tabs are not refreshed, so they are forgotten and loaded again when opened.
    if (refreshed)
      setEntries((previous) => new Map([...previous].filter(([entry]) => entry === key)));
    const cached = entriesRef.current.get(key);
    setError(null);
    if (
      !refreshed &&
      !retried &&
      cached != null &&
      Date.now() - cached.loadedAt < GALLERY_FRESH_MS
    ) {
      busyRef.current = false;
      setFetching(false);
      return () => controller.abort();
    }
    busyRef.current = true;
    setFetching(true);
    fetchPage(null, controller.signal)
      .then((page) =>
        setEntries((previous) =>
          new Map(previous).set(key, {
            items: page.items,
            cursor: page.olderCursor,
            loadedAt: Date.now(),
          }),
        ),
      )
      .catch((reason: unknown) => {
        if (!isAbortError(reason)) setError(toErrorMessage(reason));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        busyRef.current = false;
        setFetching(false);
      });
    return () => controller.abort();
  }, [fetchPage, key, refreshToken, attempt]);

  const current = entries.get(key) ?? null;
  const cursor = current?.cursor ?? null;

  // The next page. After a failure it waits for `retry`, so scrolling does not hammer a broken request.
  const loadMore = useCallback(() => {
    const signal = controllerRef.current?.signal;
    if (busyRef.current || error != null || cursor == null || signal == null) return;
    busyRef.current = true;
    setFetching(true);
    fetchPage(cursor, signal)
      .then((page) =>
        setEntries((previous) => {
          const entry = previous.get(key);
          // The entry was replaced by a fresh first page while this one was on its way.
          if (entry == null || entry.cursor !== cursor) return previous;
          const seen = new Set(entry.items.map(mediaIdOf));
          const items = [
            ...entry.items,
            ...page.items.filter((item) => !seen.has(mediaIdOf(item))),
          ];
          return new Map(previous).set(key, { ...entry, items, cursor: page.olderCursor });
        }),
      )
      .catch((reason: unknown) => {
        if (!isAbortError(reason)) setError(toErrorMessage(reason));
      })
      .finally(() => {
        if (signal.aborted) return;
        busyRef.current = false;
        setFetching(false);
      });
  }, [cursor, error, fetchPage, key]);

  return {
    items: current?.items ?? [],
    // Nothing to show yet.
    loading: current == null && error == null,
    fetching,
    hasMore: cursor != null,
    error,
    loadMore,
    retry: () => (current == null ? setAttempt((value) => value + 1) : setError(null)),
  };
}

// The number of items per tab, or null while unknown or when the source has no counts route (yet). A failed request
// only leaves the labels without numbers, so it is not reported.
export function useMessengerGalleryCounts(
  scope: GalleryScope,
  refreshToken = 0,
  source: GalleryDataSource = messengerGallerySource,
): GalleryCounts | null {
  const { accountId, chatId } = scope;
  const [counts, setCounts] = useState<{ key: string; value: GalleryCounts } | null>(null);
  const key = `${accountId}|${chatId ?? ''}`;
  useEffect(() => {
    if (source.counts == null) return;
    const controller = new AbortController();
    source
      .counts({ accountId, chatId }, controller.signal)
      .then((value) => setCounts({ key, value }))
      .catch(() => {});
    return () => controller.abort();
  }, [source, accountId, chatId, key, refreshToken]);
  return counts?.key === key ? counts.value : null;
}
