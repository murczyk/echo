import { useCallback, useRef, useState } from 'react';

import type { Palitra, PalitraHighlightBlacklistEntry } from '../../../../Bindings';
import {
  deletePalitraHighlightBlacklistEntry,
  getPalitraHighlightBlacklist,
} from '../../services/api/palitra';
import { formatErrorMessage } from './helpers';

export function useRerPalitraNeoPageHighlightBlacklist(
  setPalitraBlacklistCount: (palitraId: number, count: number) => void,
  notify: (message: string) => void,
) {
  const [palitra, setPalitra] = useState<Palitra | null>(null);
  const [entries, setEntries] = useState<PalitraHighlightBlacklistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const requestIdRef = useRef(0);
  const openPalitraIdRef = useRef<number | null>(null);

  const load = useCallback(async (nextPalitra: Palitra) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setMutationError(null);
    setMutationBlocked(false);
    setEntries([]);
    setPendingIds(new Set());
    try {
      const nextEntries = await getPalitraHighlightBlacklist(nextPalitra.id);
      if (requestIdRef.current === requestId) setEntries(nextEntries);
    } catch (loadError) {
      if (requestIdRef.current === requestId) setError(formatErrorMessage(loadError));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  const open = useCallback(
    (nextPalitra: Palitra) => {
      if (nextPalitra.id <= 0) return;
      openPalitraIdRef.current = nextPalitra.id;
      setPalitra(nextPalitra);
      void load(nextPalitra);
    },
    [load],
  );

  const close = useCallback(() => {
    requestIdRef.current += 1;
    openPalitraIdRef.current = null;
    setPalitra(null);
    setLoading(false);
    setError(null);
    setMutationError(null);
    setPendingIds(new Set());
  }, []);

  const deleteEntry = useCallback(
    async (entry: PalitraHighlightBlacklistEntry) => {
      const currentPalitra = palitra;
      if (!currentPalitra || mutationBlocked || pendingIds.has(entry.id)) return;
      const requestId = requestIdRef.current;
      const palitraId = currentPalitra.id;
      const isCurrent = () =>
        requestIdRef.current === requestId && openPalitraIdRef.current === palitraId;
      setPendingIds((previous) => new Set(previous).add(entry.id));
      setMutationError(null);
      try {
        await deletePalitraHighlightBlacklistEntry(palitraId, entry.id);
        if (!isCurrent()) return;
        const nextEntries = entries.filter((item) => item.id !== entry.id);
        setEntries(nextEntries);
        setPalitraBlacklistCount(palitraId, nextEntries.length);
        if (nextEntries.length === 0) {
          close();
          notify('У чорному списку більше немає точок.');
        }
      } catch (mutationFailure) {
        if (!isCurrent()) return;
        setMutationError(formatErrorMessage(mutationFailure));
        const status = (mutationFailure as { status?: number }).status;
        if (status === 403 || status === 404) setMutationBlocked(true);
      } finally {
        if (isCurrent()) {
          setPendingIds((previous) => {
            const next = new Set(previous);
            next.delete(entry.id);
            return next;
          });
        }
      }
    },
    [close, entries, mutationBlocked, notify, palitra, pendingIds, setPalitraBlacklistCount],
  );

  return {
    highlightBlacklistPalitra: palitra,
    highlightBlacklistEntries: entries,
    highlightBlacklistLoading: loading,
    highlightBlacklistError: error,
    highlightBlacklistMutationError: mutationError,
    highlightBlacklistMutationBlocked: mutationBlocked,
    highlightBlacklistPendingIds: pendingIds,
    openHighlightBlacklist: open,
    loadHighlightBlacklist: () => (palitra ? load(palitra) : Promise.resolve()),
    deleteHighlightBlacklistEntry: deleteEntry,
    closeHighlightBlacklist: close,
  };
}
